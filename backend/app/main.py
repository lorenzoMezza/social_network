# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The development backend: every endpoint of API.md on volatile memory.

    .venv/bin/python -m app.main          # or: make dev (from the Expo project)
"""

import asyncio
import hashlib
import traceback
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, ORJSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, janitor, persistence, seed
from .errors import ApiError
from .realtime import presence_loop, router as realtime_router
from .routes import chats, events, people, promotions, social
from .views import Urls

if config.PRODUCTION and (problems := config.production_problems()):
    raise SystemExit("Not safe for production:\n  - " + "\n  - ".join(problems))


@asynccontextmanager
async def lifespan(_app):
    persistence.load()
    # Demo people's friendships, also in a state saved before they existed
    seed.connect_bots()
    tasks = [asyncio.create_task(presence_loop()), asyncio.create_task(janitor.loop())]
    if persistence.ENABLED:
        tasks.append(asyncio.create_task(persistence.save_loop()))
    yield
    for task in tasks:
        task.cancel()
    persistence.save()


app = FastAPI(
    title="Masterkey API (development)", default_response_class=ORJSONResponse, lifespan=lifespan,
    docs_url="/v1/docs" if config.DEV_TOOLS else None, redoc_url=None,
    openapi_url="/v1/openapi.json" if config.DEV_TOOLS else None,
)


# Every JSON answer to a GET carries an ETag (a hash of the body, before compression:
# this middleware is inside the gzip one) and must be checked before reuse (no-cache):
# the app keeps answers on the phone and asks with If-None-Match, so an unchanged
# profile, chat or event costs a 304 without a body (API.md, Caching). Routes with an
# ETag of their own (avatars) and answers never to be stored (no-store) are left as
# they are.
@app.middleware("http")
async def etags(request: Request, call_next):
    response = await call_next(request)
    if (request.method != "GET" or response.status_code != 200 or "etag" in response.headers
            or not response.headers.get("content-type", "").startswith("application/json")
            or "no-store" in response.headers.get("cache-control", "")):
        return response
    body = b"".join([chunk async for chunk in response.body_iterator])
    tag = f'W/"{hashlib.sha1(body).hexdigest()[:24]}"'
    cache_control = response.headers.get("cache-control", "private, no-cache")
    asked = {value.strip() for value in request.headers.get("if-none-match", "").split(",")}
    if tag in asked:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": cache_control})
    headers = {key: value for key, value in response.headers.items() if key.lower() != "content-length"}
    headers.update({"ETag": tag, "Cache-Control": cache_control})
    return Response(content=body, status_code=200, headers=headers)


app.add_middleware(GZipMiddleware, minimum_size=1024)


# JSON bodies are small (a message, an event): anything bigger is refused before it is
# read. Files go to the storage route, which streams them with its own limit.
MAX_JSON_BODY = 256 * 1024


def _version(text: str) -> tuple:
    return tuple(int(part) for part in text.split("."))


def too_old(client: str | None) -> bool:
    """X-Client: `1.2.0 (ios)`. Nothing to compare with (no minimum set, no header: a store's
    notice, a browser opening a data export) serves as ever."""
    if not config.MIN_APP_VERSION or not client:
        return False
    try:
        return _version(client.split(" ")[0]) < _version(config.MIN_APP_VERSION)
    except ValueError:
        return False


@app.middleware("http")
async def guard(request: Request, call_next):
    Urls.learn(request.url.scheme, request.headers.get("host", ""))
    if too_old(request.headers.get("x-client")):
        return ORJSONResponse({"code": "upgrade_required", "message": "this version of the app is too old"}, status_code=426)
    if request.method in ("POST", "PUT", "PATCH") and not request.url.path.startswith("/v1/storage/"):
        length = request.headers.get("content-length")
        if length is None and request.headers.get("transfer-encoding"):
            return ORJSONResponse({"code": "bad_request", "message": "a Content-Length is needed"}, status_code=411)
        if length and (not length.isdigit() or int(length) > MAX_JSON_BODY):
            return ORJSONResponse({"code": "too_large", "message": "request too large"}, status_code=413)
    return await call_next(request)


@app.exception_handler(ApiError)
async def api_error(_request, error: ApiError):
    return ORJSONResponse(error.body(), status_code=error.status, headers=error.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(_request, error: RequestValidationError):
    details = [f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in error.errors()]
    return ORJSONResponse({"code": "bad_request", "message": "invalid request", "details": details}, status_code=400)


@app.exception_handler(Exception)
async def unexpected_error(request: Request, error: Exception):
    # Logged here, never sent: an answer must not reveal the server's insides
    traceback.print_exception(error)
    return ORJSONResponse({"code": "internal", "message": "something went wrong"}, status_code=500)


@app.exception_handler(StarletteHTTPException)
async def http_error(_request, error: StarletteHTTPException):
    code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "bad_request"}.get(error.status_code, "bad_request")
    return ORJSONResponse({"code": code, "message": str(error.detail)}, status_code=error.status_code)


@app.get("/v1/health")
async def health():
    return {"ok": True}


@app.get("/v1/media/{key:path}")
async def media_file(key: str):
    path = (config.MEDIA_DIR / key).resolve()
    if config.MEDIA_DIR.resolve() not in path.parents or not path.is_file() or "uploads" in path.parts:
        raise ApiError(404, "not_found", "no such file")
    # Processed files never change (a new picture gets a new name): cached forever
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=31536000, immutable"})


for module in (people, social, chats, events, promotions):
    app.include_router(module.router)
app.include_router(realtime_router)


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app", host="0.0.0.0", port=config.PORT, log_level="warning",
        # Frames are small JSON: a huge one is refused by the protocol layer itself
        ws_ping_interval=25, ws_ping_timeout=20, ws_max_size=64 * 1024,
    )
