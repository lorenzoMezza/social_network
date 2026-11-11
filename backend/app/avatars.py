# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Avatar documents (avatar-server/shared/avatarFormat.js): validated against the catalog with the rules
of avatar-server/shared/avatarFormat.js (validateAvatar), and a preset for users who
never saved one, always the same for an ID."""

import hashlib
import re
from collections import OrderedDict

import httpx
import orjson

from . import config
from .seed import preset_of
from .store import User

FORMAT = "masterkey.avatar"
VERSION = 1
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")

_catalog = None
_presets = None


def _load():
    global _catalog, _presets
    if _catalog is None:
        try:
            _catalog = orjson.loads((config.AVATAR_LIBRARY / "catalog.json").read_bytes())
            _presets = orjson.loads((config.AVATAR_LIBRARY / "presets.json").read_bytes())["presets"]
        except FileNotFoundError:
            # Without the library (make dev) avatars are accepted as sent
            _catalog, _presets = {"items": [], "categories": []}, []
        _catalog["byId"] = {item["id"]: item for item in _catalog["items"]}
        _catalog["slots"] = {category["id"]: category for category in _catalog["categories"]}
    return _catalog, _presets


def validate(avatar) -> tuple[bool, list, dict | None]:
    catalog, _ = _load()
    if not catalog["items"]:
        return isinstance(avatar, dict), [], avatar if isinstance(avatar, dict) else None
    errors = []
    if not isinstance(avatar, dict):
        return False, ["not an object"], None
    if (not isinstance(avatar.get("bodyShape"), str) or not isinstance(avatar.get("colors") or {}, dict)
            or not isinstance(avatar.get("wearables") or {}, dict)
            or not all(isinstance(item, str) for item in (avatar.get("wearables") or {}).values())):
        return False, ["bodyShape: a string; colors, wearables: objects of strings"], None
    if avatar.get("format") != FORMAT:
        errors.append(f'format must be "{FORMAT}"')
    if avatar.get("version") != VERSION:
        errors.append(f"version must be {VERSION}")
    body = catalog["byId"].get(avatar.get("bodyShape"))
    if not body or body["category"] != "body_shape":
        errors.append(f'unknown bodyShape "{avatar.get("bodyShape")}"')
    colors = avatar.get("colors") or {}
    for key in ("skin", "hair", "eyes"):
        if not HEX.fullmatch(str(colors.get(key, ""))):
            errors.append(f"colors.{key} must be #RRGGBB")
    wearables = avatar.get("wearables") or {}
    for slot, item_id in wearables.items():
        item = catalog["byId"].get(item_id)
        if slot not in catalog["slots"] or slot == "body_shape":
            errors.append(f'unknown slot "{slot}"')
        elif not item:
            errors.append(f'unknown item "{item_id}"')
        elif item["category"] != slot:
            errors.append(f'"{item_id}" is a {item["category"]}, not a {slot}')
        elif body and avatar.get("bodyShape") not in item["representations"]:
            errors.append(f'"{item_id}" has no version for {avatar.get("bodyShape")}')
    for slot in catalog["categories"]:
        if slot.get("required") and slot["id"] != "body_shape" and slot["id"] not in wearables:
            errors.append(f'missing required slot "{slot["id"]}"')
    if errors:
        return False, errors, None
    clean = {
        "format": FORMAT,
        "version": VERSION,
        "bodyShape": avatar["bodyShape"],
        "colors": {key: colors[key].upper() for key in ("skin", "hair", "eyes")},
        "wearables": dict(wearables),
    }
    return True, [], clean


def preset_for(user: User) -> dict | None:
    _, presets = _load()
    if not presets:
        return None
    wanted = preset_of(user.username) if user.bot else None
    for preset in presets:
        if wanted and preset["id"] == wanted:
            return preset["avatar"]
    index = int.from_bytes(hashlib.sha1(user.id.encode()).digest()[:4], "big") % len(presets)
    return presets[index]["avatar"]


_before = None


def saved_before(user_id: str) -> dict | None:
    """An avatar saved with the earlier avatar server (avatar-server/data/avatars.json),
    so moving to this backend loses nobody's look (development only)."""
    global _before
    if _before is None:
        try:
            _before = orjson.loads((config.REPO / "avatar-server" / "data" / "avatars.json").read_bytes())
        except (FileNotFoundError, orjson.JSONDecodeError):
            _before = {}
    avatar = _before.get(user_id)
    if not avatar:
        return None
    ok, _, clean = validate(avatar)
    return {**clean, "updatedAt": avatar.get("updatedAt")} if ok else None


# --- Map avatars ---
# An avatar as the people around see it on the map is made once by the avatar server
# (asset-pipeline/src/mapAvatar.mjs) and named by a hash of what it looks like: the
# same look always has the same key, so it is asked for once per look.
MAP_KEY = re.compile(r"^[0-9a-f]{32}$")
_map_keys: OrderedDict[bytes, str] = OrderedDict()
_MAP_KEYS_KEPT = 20_000


async def map_avatar(avatar: dict | None) -> str | None:
    """The key of an avatar's map files, made if needed; None when the avatar server
    cannot make it now (the app shows the stand-in, and asks again later)."""
    if not avatar or not config.AVATAR_BAKER_URL:
        return None
    look = {key: avatar.get(key) for key in ("format", "version", "bodyShape", "colors", "wearables")}
    canonical = orjson.dumps(look, option=orjson.OPT_SORT_KEYS)
    known = _map_keys.get(canonical)
    if known:
        _map_keys.move_to_end(canonical)
        return known
    headers = {"X-Bake-Secret": config.AVATAR_BAKE_SECRET} if config.AVATAR_BAKE_SECRET else {}
    try:
        async with httpx.AsyncClient(timeout=config.AVATAR_BAKE_TIMEOUT_S) as client:
            response = await client.post(f"{config.AVATAR_BAKER_URL}/v1/map-avatars", content=canonical, headers={**headers, "Content-Type": "application/json"})
        key = response.json().get("key") if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(key, str) or not MAP_KEY.fullmatch(key):
        return None
    _map_keys[canonical] = key
    while len(_map_keys) > _MAP_KEYS_KEPT:
        _map_keys.popitem(last=False)
    return key
