# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Who is calling: the `sub` of the Logto access token (API.md, Conventions).

JWT access tokens (an API resource is configured) are checked with Logto's JWKS: the
signature, `iss`, `exp`, and `aud` when API_RESOURCE is set. Opaque tokens (no API
resource yet) are resolved with Logto's userinfo endpoint. Results are cached until the
token expires, so a request costs no network call after the first.

Development only (TRUST_UNVERIFIED_TOKENS): when the JWKS cannot be reached (offline),
a JWT's claims are read without checking the signature."""

import asyncio
import re
import secrets
import time
import unicodedata
from urllib.parse import unquote

import httpx
import jwt
import orjson
from fastapi import Request

from . import config, limits
from .errors import ApiError
from . import avatars
from .seed import seed_new_user
from .store import User, store
from .util import plain_text

_cache: dict[str, tuple[float, dict]] = {}
_jwks: jwt.PyJWKClient | None = None


def _unauthorized(message="access token missing, invalid or expired"):
    return ApiError(401, "unauthorized", message)


def _jwks_client() -> jwt.PyJWKClient:
    global _jwks
    if _jwks is None:
        _jwks = jwt.PyJWKClient(config.LOGTO_JWKS_URL, cache_keys=True, lifespan=3600)
    return _jwks


SHOWCASE_TOKEN = re.compile(r"showcase\.[a-z]{1,20}")


def _verify_jwt(token: str) -> dict:
    key = _jwks_client().get_signing_key_from_jwt(token)
    options = {"verify_aud": bool(config.API_RESOURCE)}
    return jwt.decode(
        token,
        key.key,
        algorithms=["ES384", "ES256", "RS256"],
        issuer=config.LOGTO_ISSUER,
        audience=config.API_RESOURCE,
        options=options,
    )


def _unverified(token: str) -> dict:
    """Development only: the claims without the signature, still refusing an expired or
    malformed token."""
    try:
        return jwt.decode(token, options={"verify_signature": False, "verify_exp": True})
    except jwt.ExpiredSignatureError as error:
        raise _unauthorized("access token expired") from error
    except jwt.InvalidTokenError as error:
        raise _unauthorized("malformed access token") from error


# Accounts erased (sub → when): a token issued before that still has its signature and may
# live up to an hour, and must not make the account again. Kept as long as such a token.
ERASED_KEEP_S = 2 * 3600
_erased: dict[str, float] = {}


def forget_account(sub: str):
    """The account is gone (DELETE /me): its tokens stop working now, on every device"""
    _erased[sub] = time.time()
    for token in [token for token, (_, claims) in _cache.items() if claims.get("sub") == sub]:
        del _cache[token]


def sweep_erased():
    limit = time.time() - ERASED_KEEP_S
    for sub in [sub for sub, at in _erased.items() if at < limit]:
        del _erased[sub]


def _check_not_erased(claims: dict):
    erased = _erased.get(claims.get("sub"))
    if erased is not None and float(claims.get("iat") or 0) <= erased:
        raise _unauthorized("this account was deleted")


async def _claims_for(token: str) -> dict:
    cached = _cache.get(token)
    if cached and cached[0] > time.time():
        return cached[1]
    # The showcase recordings only (config.SHOWCASE, refused in production): the person the
    # token names, signed in without Logto
    if config.SHOWCASE and SHOWCASE_TOKEN.fullmatch(token):
        return {"sub": token, "iat": time.time()}
    if token.count(".") == 2:
        try:
            claims = await asyncio.to_thread(_verify_jwt, token)
        except jwt.ExpiredSignatureError as error:
            raise _unauthorized("access token expired") from error
        except (jwt.PyJWKClientConnectionError, OSError) as error:
            # Only when Logto cannot be reached. Never for a key it does not know: anyone
            # can write a token naming an unknown key (PyJWKClientError), and reading it
            # unchecked would let them be anyone
            if not config.TRUST_UNVERIFIED_TOKENS:
                raise _unauthorized("cannot check the access token") from error
            claims = _unverified(token)
        except (jwt.PyJWKClientError, jwt.InvalidTokenError) as error:
            raise _unauthorized("invalid access token") from error
        expires = float(claims.get("exp") or time.time() + 300)
    elif config.API_RESOURCE:
        # With an API resource every real token is a JWT for it: nothing else is accepted
        raise _unauthorized("invalid access token")
    else:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                answer = await client.get(config.LOGTO_USERINFO_URL, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as error:
            raise _unauthorized("cannot check the access token") from error
        if answer.status_code != 200:
            raise _unauthorized()
        claims = answer.json()
        expires = time.time() + 600
    if not claims.get("sub"):
        raise _unauthorized("the token has no subject")
    _check_not_erased(claims)
    _cache[token] = (expires, claims)
    if len(_cache) > 5000:
        for stale in [key for key, (until, _) in _cache.items() if until < time.time()]:
            del _cache[stale]
    return claims


def _id_token_claims(token: str) -> dict:
    key = _jwks_client().get_signing_key_from_jwt(token)
    # An expired one still says who signed in: it only names the account made by that sign-in
    return jwt.decode(token, key.key, algorithms=["ES384", "ES256", "RS256"], issuer=config.LOGTO_ISSUER,
                      audience=config.LOGTO_APP_ID, options={"verify_exp": False})


async def _names(request_headers, sub: str) -> dict:
    """What names a new account: only what Logto signed (X-Id-Token, the same `sub`), so
    nobody names themselves with an email they do not own. Development also takes the
    unsigned X-Profile-Hint, for what cannot reach Logto."""
    token = request_headers.get("x-id-token")
    if token:
        try:
            claims = await asyncio.to_thread(_id_token_claims, token)
            if claims.get("sub") == sub:
                return {key: claims[key] for key in ("name", "username", "email") if claims.get(key)}
        except (jwt.PyJWTError, OSError):
            pass
    return {} if config.PRODUCTION else _hint(request_headers)


def _hint(request_headers) -> dict:
    """X-Profile-Hint: name, username and email as percent-encoded JSON, unsigned (above)."""
    raw = request_headers.get("x-profile-hint")
    if not raw:
        return {}
    try:
        value = orjson.loads(unquote(raw))
        return value if isinstance(value, dict) else {}
    except (ValueError, orjson.JSONDecodeError):
        return {}


def _random_handle() -> str:
    """Nothing that says who someone is, or how many came before them"""
    return f"user{secrets.randbelow(10**8):08d}"


def _handle_from(text: str | None) -> str:
    """A handle the rules of @handles allow (API.md: a-z, 0-9, dots, underscores), or nothing:
    a name made of other letters ("Müller", "Алиса") keeps what it can, accents off"""
    plain = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    cleaned = "".join(c for c in plain if c.isalnum() or c in "._")
    while ".." in cleaned:
        cleaned = cleaned.replace("..", ".")
    cleaned = cleaned[:30].strip("._")
    return cleaned if len(cleaned) >= 3 else ""


def _name_from(handle: str) -> str:
    words = [w for w in handle.replace("_", ".").replace("-", ".").split(".") if w and not w.isdigit()]
    return " ".join(w.capitalize() for w in words) or "New user"


def _name_account(user: User, claims: dict, hint: dict):
    email = hint.get("email") or claims.get("email")
    given = hint.get("name") or claims.get("name")
    given = " ".join(plain_text(given).split())[:30].strip() if isinstance(given, str) else ""
    # The @handle is public: from what the person chose to be called, never from their email,
    # which nobody around them should learn this way
    handle = _handle_from(hint.get("username") or claims.get("username") or given.replace(" ", ".")) or _random_handle()
    if handle != user.username:
        store.rename(user, store.free_username(handle))
    user.name = given or (_name_from(handle) if not handle.startswith("user") else "New user")
    user.email = email
    user.named = bool(hint or claims.get("email") or claims.get("name"))


def ensure_account(sub: str, claims: dict, hint: dict) -> User:
    user = store.user(sub)
    if user:
        # Made by a request without the sign-in's names: named now, once
        if not user.named and hint:
            _name_account(user, claims, hint)
        # Kept through a reset of the development data (reset.py): the demo world again
        seed_new_user(user)
        return user
    user = store.add_user(User(id=sub, username=store.free_username(_random_handle()), name="New user"))
    _name_account(user, claims, hint)
    seed_new_user(user)
    saved = avatars.saved_before(sub)
    if saved:
        user.avatar, user.avatar_version = saved, 1
    return user


async def user_from_token(token: str | None, headers=None) -> User:
    if not token:
        raise _unauthorized()
    claims = await _claims_for(token)
    known = store.user(claims["sub"])
    # Asked only while it matters: an account already named needs nothing
    names = {} if known and known.named else await _names(headers or {}, claims["sub"])
    return ensure_account(claims["sub"], claims, names)


async def current_user(request: Request) -> User:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else None
    user = await user_from_token(token, request.headers)
    limits.check(user.id, "requests")
    return user
