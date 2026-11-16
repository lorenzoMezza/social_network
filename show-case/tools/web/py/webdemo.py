# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The development backend (backend/app) run inside the browser by Pyodide, for the try-it demo
of show-case/: the page's service worker hands it the app's requests, the WebSocket shim its
socket, and it answers as the server on a computer would. Its state lives in this tab only.

backend-worker.js sets the environment and the files (/backend/app, /library), then:
    import webdemo; await webdemo.start(); await webdemo.http(...); webdemo.Socket(...)
"""

import asyncio
import sys
import types
from urllib.parse import unquote

# Not needed in a browser: the server process (uvicorn) and HEIC photos (pillow-heif, a
# native library Pyodide has not). A picture from the browser is JPEG, PNG or WebP.
sys.modules["uvicorn"] = types.ModuleType("uvicorn")
heif = types.ModuleType("pillow_heif")
heif.register_heif_opener = lambda *args, **kwargs: None
sys.modules["pillow_heif"] = heif

from app import avatars, config  # noqa: E402
from app.main import app  # noqa: E402

# Map avatars are made by the avatar server, which is not here: the looks of the demo were
# made in advance (show-case/tools/web/build.mjs) and are found by their look. A new look
# made in the editor keeps the stand-in on the map.
_baked: dict[bytes, str] = {}


def bake_known(pairs: list):
    import orjson
    for look, key in pairs:
        _baked[orjson.dumps(look, option=orjson.OPT_SORT_KEYS)] = key


async def _map_avatar(avatar):
    if not avatar:
        return None
    import orjson
    look = {key: avatar.get(key) for key in ("format", "version", "bodyShape", "colors", "wearables")}
    return _baked.get(orjson.dumps(look, option=orjson.OPT_SORT_KEYS))


avatars.map_avatar = _map_avatar  # (read through the module: routes/people.py)

_life: dict = {}

# Connecting needs a second phone to scan the code. In the demo there is none, so a demo
# person nearby scans it a few seconds after My code opens: the real connection
# (routes/social.connect_users), with its frames to the app.
SCAN_AFTER_MS = 3500


async def _demo_scans():
    from app.realtime import BOTS
    from app.routes.social import connect_users, sessions
    from app.seed import bot_id
    from app.store import store
    from app.util import now_ms
    while True:
        await asyncio.sleep(0.5)
        try:
            for session_id, session in list(sessions.items()):
                host = store.users.get(session["host"])
                if session["status"] != "waiting" or not host or host.bot or now_ms() - session["created"] < SCAN_AFTER_MS:
                    continue
                known = store.connections.get(host.id, {})
                guest = next((bot_id(name) for name, mode, *_ in BOTS
                              if mode == "visible" and bot_id(name) in store.users and bot_id(name) not in known), None)
                if guest:
                    connect_users(host.id, guest, session_id)
        except Exception as error:  # the demo goes on
            print("demo scan:", error)


# The demo people make the first move, once per visit, so the map shows what meeting
# people is like before the visitor tries it: soon after the visitor shows up on the map
# the nearest one waves, and a little later one says something to everyone around, which
# two others answer (realtime.send_broadcast). Nothing more: it is a hint, not a show.
WAVE_AFTER_S = 5
SHOUT_AFTER_S = 22
SHOUT = "Anyone coming to the street food market? 🍕"


async def _demo_greetings():
    from app.realtime import in_range, presences, send_broadcast, send_gesture
    from app.store import store
    seen_at: dict[str, float] = {}
    done: dict[str, set] = {}
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(1)
        try:
            for user_id, presence in list(presences.items()):
                user = store.users.get(user_id)
                if not user or user.bot or presence.mode == "invisible":
                    continue
                since = seen_at.setdefault(user_id, loop.time())
                steps = done.setdefault(user_id, set())
                bots = [entry[0].user_id for entry in in_range(user_id) if store.users[entry[0].user_id].bot]
                if not bots:
                    continue
                if "wave" not in steps and loop.time() - since > WAVE_AFTER_S:
                    steps.add("wave")
                    send_gesture(bots[0], user_id, "wave")
                if "shout" not in steps and loop.time() - since > SHOUT_AFTER_S:
                    steps.add("shout")
                    send_broadcast(bots[min(2, len(bots) - 1)], SHOUT)
        except Exception as error:  # the demo goes on
            print("demo greetings:", error)


async def start():
    """The server starts (persistence, demo people, presence loop, janitor)."""
    inbox: asyncio.Queue = asyncio.Queue()
    outbox: asyncio.Queue = asyncio.Queue()
    await inbox.put({"type": "lifespan.startup"})
    _life["task"] = asyncio.create_task(app({"type": "lifespan", "asgi": {"version": "3.0"}, "state": {}}, inbox.get, outbox.put))
    message = await outbox.get()
    if message["type"] != "lifespan.startup.complete":
        raise RuntimeError(message.get("message", "the server did not start"))
    _life["scans"] = asyncio.create_task(_demo_scans())
    _life["greetings"] = asyncio.create_task(_demo_greetings())
    return True


def _scope(kind: str, path: str, query: str, headers) -> dict:
    host = config.PUBLIC_URL.split("://", 1)[-1] if config.PUBLIC_URL else "localhost"
    return {
        "type": kind, "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
        "scheme": "https" if kind == "http" else "wss", "path": unquote(path), "raw_path": path.encode(),
        "query_string": query.encode(), "root_path": "", "client": ("127.0.0.1", 0), "server": (host, 443),
        "headers": [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers
                    if name.lower() != "accept-encoding"] + [(b"host", host.encode())],
    }


async def http(method: str, path: str, query: str, headers, body) -> tuple:
    """One request: (status, [[name, value], …], body bytes)."""
    scope = {**_scope("http", path, query, list(headers)), "method": method}
    # (a Uint8Array from the page, or nothing: None or a JavaScript null)
    body = bytes(body.to_py()) if hasattr(body, "to_py") else (bytes(body) if isinstance(body, (bytes, bytearray, memoryview)) else b"")
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.Event().wait()  # the page never goes away mid-answer

    answer = {"status": 500, "headers": [], "body": []}

    async def send(message):
        if message["type"] == "http.response.start":
            answer["status"] = message["status"]
            answer["headers"] = [[name.decode("latin-1"), value.decode("latin-1")] for name, value in message.get("headers", [])]
        elif message["type"] == "http.response.body":
            answer["body"].append(message.get("body", b""))

    await app(scope, receive, send)
    return answer["status"], answer["headers"], b"".join(answer["body"])


class Socket:
    """One WebSocket of the app: frames from the page go in with push(), the server's come
    out through emit(kind, data), kind being open, message or close."""

    def __init__(self, path: str, query: str, emit):
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.emit = emit
        self.inbox.put_nowait({"type": "websocket.connect"})
        self.task = asyncio.create_task(self._run(path, query))

    async def _run(self, path, query):
        closed = False

        async def send(message):
            nonlocal closed
            kind = message["type"]
            if kind == "websocket.accept":
                self.emit("open", None)
            elif kind == "websocket.send":
                self.emit("message", message.get("text") if message.get("text") is not None else message.get("bytes", b"").decode())
            elif kind == "websocket.close" and not closed:
                closed = True
                self.emit("close", message.get("code", 1000))

        try:
            await app(_scope("websocket", path, query, []), self.inbox.get, send)
        finally:
            if not closed:
                self.emit("close", 1006)

    def push(self, text: str):
        self.inbox.put_nowait({"type": "websocket.receive", "text": text})

    def close(self, code: int = 1000):
        self.inbox.put_nowait({"type": "websocket.disconnect", "code": code})
