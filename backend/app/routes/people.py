# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Me and People (API.md): the own profile, pictures, avatars, other people's profiles,
their events and their story."""

import re

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import ORJSONResponse

from .. import avatars, limits, media, notifications, position_guard, privacy
from ..auth import current_user, forget_account
from ..domain import can_message, stats
from ..errors import ApiError, bad_request, conflict, not_found
from ..realtime import forget_person, hub, update_presence
from ..store import DEFAULT_SETTINGS, RESERVED_USERNAMES, STORY_AUDIENCES, STORY_KINDS, User, store
from ..util import iso, now_ms, plain_text
from ..views import Urls, event_status, event_summary, summary_of, user_summary

router = APIRouter(prefix="/v1")

USERNAME = re.compile(r"^[a-z0-9._]{3,30}$")
STYLE_VALUES = {
    "backdrop": {"studio", "sunset", "ocean", "forest", "candy", "lemon", "night", "ember"},
    "pedestal": {"none", "disc", "ring"},
    "effect": {"none", "sparkles", "bubbles", "fireflies", "notes", "hearts", "confetti", "petals"},
    "greeting": {"wave", "fistpump", "handsair", "dab", "dontsee", "punch", "shrug"},
    "outline": {"outline", "none"},
}


def me_view(user: User) -> dict:
    return {
        **user_summary(user),
        "email": user.email,
        "bio": user.bio,
        "style": user.style,
        "settings": user.settings,
        "stats": stats(user.id),
        "createdAt": iso(user.created_at),
        # What their story shows to others (the kinds; moments hidden one by one are
        # marked in their own story)
        "story": user.story,
        "storyAudience": user.story_audience,
        "storyHidden": len(user.story_hidden),
        "unreadNotifications": notifications.unread(user.id),
    }


@router.get("/me")
async def get_me(user: User = Depends(current_user)):
    return me_view(user)


def _username_problem(value: str) -> str | None:
    if not USERNAME.fullmatch(value):
        return "3–30 lowercase letters, digits, dots and underscores"
    if value.startswith(".") or value.endswith(".") or ".." in value:
        return "no leading, trailing or double dots"
    return None


PUSH_TOKENS_MAX = 10
STORY_HIDDEN_MAX = 2000


@router.patch("/me")
async def patch_me(body: dict, user: User = Depends(current_user)):
    if not isinstance(body, dict) or not body:
        raise bad_request("nothing to change")
    errors = []
    name = body.get("name")
    if name is not None:
        name = " ".join(plain_text(str(name)).split())
        if not 1 <= len(name) <= 30:
            errors.append("name: 1–30 characters")
    username = body.get("username")
    if username is not None:
        username = str(username).lower().lstrip("@")
        problem = _username_problem(username)
        if problem:
            errors.append(f"username: {problem}")
    bio = body.get("bio")
    if bio is not None:
        bio = plain_text(str(bio)).strip()
        if len(bio) > 200:
            errors.append("bio: at most 200 characters")
    style = body.get("style")
    if style is not None:
        if not isinstance(style, dict) or any(key not in STYLE_VALUES or not isinstance(value, str) or value not in STYLE_VALUES[key] for key, value in style.items()):
            errors.append("style: unknown key or value")
    settings = body.get("settings")
    if settings is not None:
        if not isinstance(settings, dict) or any(key not in DEFAULT_SETTINGS or not isinstance(value, bool) for key, value in settings.items()):
            errors.append("settings: unknown key or not a boolean")
    story = body.get("story")
    if story is not None:
        if not isinstance(story, dict) or any(key not in STORY_KINDS or not isinstance(value, bool) for key, value in story.items()):
            errors.append(f"story: {', '.join(STORY_KINDS)} as booleans")
    audience = body.get("storyAudience")
    if audience is not None and audience not in STORY_AUDIENCES:
        errors.append(f"storyAudience: {' or '.join(STORY_AUDIENCES)}")
    if errors:
        raise bad_request("invalid profile", errors)
    limits.check(user.id, "profile")
    if username is not None and username != user.username:
        if username in store.by_username or username in RESERVED_USERNAMES:
            raise conflict("this username is taken", code="username_taken")
        limits.check(user.id, "username")
        store.rename(user, username)
    if name is not None:
        user.name = name
    if bio is not None:
        user.bio = bio
    if style is not None:
        user.style = {**user.style, **style}
    if settings is not None:
        user.settings = {**user.settings, **settings}
    if story is not None:
        user.story = {**user.story, **story}
    if audience is not None:
        user.story_audience = audience
    return me_view(user)


@router.put("/me/picture")
async def put_picture(body: dict, user: User = Depends(current_user)):
    limits.check(user.id, "picture")
    upload = media.take(body.get("uploadId"), user.id, "profile-picture")
    previous = user.picture_url
    user.picture_url = media.profile_picture(upload)
    media.discard(previous)
    return me_view(user)


@router.delete("/me/picture")
async def delete_picture(user: User = Depends(current_user)):
    media.discard(user.picture_url)
    user.picture_url = None
    return me_view(user)


async def avatar_entry(user: User) -> dict:
    source, avatar = ("saved", user.avatar) if user.avatar else ("preset", avatars.preset_for(user))
    return {
        "userId": user.id,
        "source": source,
        "avatar": avatar,
        "avatarVersion": user.avatar_version,
        # Their look on the map, made by the avatar server (null: not available now)
        "mapAvatar": await avatars.map_avatar(avatar),
    }


@router.put("/me/avatar")
async def put_avatar(body: dict, user: User = Depends(current_user)):
    ok, errors, clean = avatars.validate(body)
    if not ok:
        raise ApiError(400, "invalid_avatar", "invalid avatar", errors)
    limits.check(user.id, "avatar")
    user.avatar = {**clean, "updatedAt": iso(now_ms())}
    user.avatar_version += 1
    return await avatar_entry(user)


@router.post("/me/push-tokens", status_code=204)
async def push_token(body: dict, user: User = Depends(current_user)):
    token, platform = body.get("token"), body.get("platform")
    if not isinstance(token, str) or not 1 <= len(token) <= 256 or platform not in ("ios", "android"):
        raise bad_request("token and platform (ios, android) are needed")
    # A phone is one person's at a time: signed in with another account, the last one's
    # notifications must not go on arriving on it
    for other in store.users.values():
        if other.id != user.id:
            other.push_tokens.pop(token, None)
    user.push_tokens.pop(token, None)
    user.push_tokens[token] = platform
    while len(user.push_tokens) > PUSH_TOKENS_MAX:
        del user.push_tokens[next(iter(user.push_tokens))]
    return Response(status_code=204)


@router.delete("/me/push-tokens/{token}", status_code=204)
async def forget_push_token(token: str, user: User = Depends(current_user)):
    """This phone signs out: no more notifications for the account on it"""
    user.push_tokens.pop(token, None)
    return Response(status_code=204)


@router.delete("/me", status_code=204)
async def delete_me(user: User = Depends(current_user)):
    """Deletes the account and everything that is the user's (GDPR art. 17):
    privacy.erase_user lists what goes and what is kept, and why."""
    update_presence(user.id, "invisible", None)
    position_guard.forget(user.id)
    forget_person(user.id)
    privacy.erase_user(user)
    # Its other devices are out now: an old token must not make the account again
    forget_account(user.id)
    hub.close_all(user.id)
    return Response(status_code=204)


CONSENTS = {"location-sharing"}
CONSENTS_KEPT = 50


@router.put("/me/consents/{kind}", status_code=204)
async def record_consent(kind: str, body: dict, user: User = Depends(current_user)):
    """A consent given in the app, with the version of the text the user read
    (GDPR art. 7(1): the service must be able to show it). Kept with the account."""
    version = body.get("version")
    if kind not in CONSENTS or not isinstance(version, int) or not 0 < version < 1000:
        raise bad_request("unknown consent or version")
    mode = body.get("mode") if body.get("mode") in ("visible", "approximate") else None
    log = privacy.consents_of(user).setdefault(kind, [])
    log.append({"version": version, "at": now_ms(), **({"mode": mode} if mode else {})})
    del log[:-CONSENTS_KEPT]
    return Response(status_code=204)


@router.post("/me/export")
async def export_link(user: User = Depends(current_user)):
    """A one-time link to a copy of the user's data (GDPR art. 15 and 20), opened in
    the browser: valid for a few minutes, once"""
    limits.check(user.id, "export")
    token, expires = privacy.export_ticket(user.id)
    return {"url": f"{Urls.api or ''}/v1/exports/{token}", "expiresAt": iso(expires)}


@router.get("/exports/{token}")
async def export_file(token: str):
    """The copy itself: no sign-in (the link is the key), once, as a JSON file"""
    user_id = privacy.redeem(token)
    user = store.users.get(user_id) if user_id else None
    if not user:
        raise ApiError(410, "expired", "this link has expired: ask for a new copy in the app")
    return ORJSONResponse(
        privacy.export_data(user),
        headers={
            "Content-Disposition": f'attachment; filename="my-data-{now_ms() // 1000}.json"',
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    )


# --- other people ---

def _visible_user(user_id: str, viewer: User) -> User:
    limits.check(viewer.id, "people")
    other = store.user(user_id)
    # Who blocked the user is gone for them; whom the user blocked stays (to unblock)
    if not other or viewer.id in store.blocks.get(user_id, {}):
        raise not_found("user not found")
    return other


@router.get("/users/{user_id}")
async def get_user(user_id: str, viewer: User = Depends(current_user)):
    other = _visible_user(user_id, viewer)
    own = other.id == viewer.id
    connection = store.connections.get(viewer.id, {}).get(other.id)
    allowed = False if own else can_message(viewer.id, other.id)[0]
    sees_story = store.sees_story(viewer.id, other.id)
    return {
        **user_summary(other),
        "bio": other.bio,
        "style": other.style,
        "stats": stats(other.id) if sees_story else {"organized": None, "connections": None},
        "relation": {
            "connected": bool(connection),
            "connectedSince": iso(connection["since"]) if connection else None,
            "blocked": other.id in store.blocks.get(viewer.id, {}),
            "canMessage": allowed,
            "seesStory": sees_story,
        },
    }


@router.get("/users/{user_id}/avatar")
async def get_avatar(user_id: str, request: Request, viewer: User = Depends(current_user)):
    other = _visible_user(user_id, viewer)
    entry = await avatar_entry(other)
    # The map avatar is part of the answer: one made later changes the tag too
    etag = f'"{other.id}:{other.avatar_version}:{entry["mapAvatar"] or "-"}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return ORJSONResponse(entry, headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.get("/users/{user_id}/events")
async def user_events(user_id: str, viewer: User = Depends(current_user)):
    _visible_user(user_id, viewer)
    if not store.sees_story(viewer.id, user_id):
        return {"items": []}
    events = [e for e in store.events.values() if e.creator_id == user_id and not e.cancelled]
    events.sort(key=lambda e: e.start, reverse=True)
    return {"items": [
        {"event": event_summary(e, viewer.id), "people": len(store.followers.get(e.id, {})), "past": event_status(e) == "concluded"}
        for e in events
    ]}


@router.get("/users/{user_id}/activity")
async def activity(user_id: str, cursor: str | None = None, limit: int = 30, viewer: User = Depends(current_user)):
    _visible_user(user_id, viewer)
    if not store.sees_story(viewer.id, user_id):
        return {"items": [], "nextCursor": None}
    limit = max(1, min(limit, 100))
    entries = []
    for event in store.events.values():
        # An organizer the viewer blocked, or who blocked them, stays out of sight here too
        if event.cancelled or store.blocked_either(viewer.id, event.creator_id):
            continue
        status = event_status(event)
        summary = None
        if event.creator_id == user_id:
            summary = event_summary(event, viewer.id)
            entries.append({"id": f"o-{event.id}", "kind": "organized", "at": event.start, "upcoming": status == "upcoming", "event": summary})
        elif user_id in store.followers.get(event.id, {}):
            # "Going" while it is on too: joining says they mean to go, not where they are
            # right now (never told to anyone by this, whatever their mode on the map)
            kind = "went" if status == "concluded" else "going"
            summary = event_summary(event, viewer.id)
            entries.append({"id": f"j-{event.id}", "kind": kind, "at": event.end if kind == "went" else event.start, "upcoming": kind != "went", "event": summary})
        rating = store.ratings.get(event.id, {}).get(user_id)
        if rating and event.creator_id != user_id:
            entries.append({"id": f"r-{event.id}", "kind": "reviewed", "at": rating.date, "upcoming": False,
                            "event": summary or event_summary(event, viewer.id), "rating": {"rating": rating.rating, "comment": rating.comment}})
    # Connections: all of one's own; on someone else's profile, only theirs with the viewer
    for other, entry in store.connections.get(user_id, {}).items():
        if user_id == viewer.id or other == viewer.id:
            # The other side (on someone else's profile: the viewer, "with you")
            entries.append({"id": f"c-{other}", "kind": "connected", "at": entry["since"], "upcoming": False,
                            "person": summary_of(other), "place": entry.get("place")})
    # The story's kinds and hidden moments: gone for others, marked in one's own
    kind_of = {"organized": "organized", "going": "going", "went": "going", "reviewed": "reviewed", "connected": "connected"}
    owner = store.user(user_id)
    for entry in entries:
        entry["hidden"] = entry["id"] in owner.story_hidden or not owner.story.get(kind_of[entry["kind"]], True)
    if user_id != viewer.id:
        entries = [entry for entry in entries if not entry["hidden"]]
    upcoming = sorted((e for e in entries if e["upcoming"]), key=lambda e: e["at"])
    past = sorted((e for e in entries if not e["upcoming"]), key=lambda e: e["at"], reverse=True)
    ordered = upcoming + past
    start = int(cursor) if cursor and cursor.isdigit() else 0
    page = ordered[start:start + limit]
    for entry in page:
        entry["at"] = iso(entry["at"])
        entry.setdefault("event", None)
        entry.setdefault("person", None)
        entry.setdefault("rating", None)
        entry.setdefault("place", None)
    return {"items": page, "nextCursor": str(start + limit) if start + limit < len(ordered) else None}


# --- the own story, notifications ---

@router.put("/me/story/hidden/{entry_id}", status_code=204)
async def hide_moment(entry_id: str, user: User = Depends(current_user)):
    """One moment of the user's story (an entry id of /activity) out of what others see"""
    if not entry_id[:2] in ("o-", "j-", "r-", "c-") or len(entry_id) > 80:
        raise bad_request("not a moment of a story")
    if len(user.story_hidden) >= STORY_HIDDEN_MAX:
        raise conflict("too many hidden moments")
    user.story_hidden.add(entry_id)
    return Response(status_code=204)


@router.delete("/me/story/hidden/{entry_id}", status_code=204)
async def show_moment(entry_id: str, user: User = Depends(current_user)):
    user.story_hidden.discard(entry_id)
    return Response(status_code=204)


@router.delete("/me/story/hidden", status_code=204)
async def show_all_moments(user: User = Depends(current_user)):
    user.story_hidden.clear()
    return Response(status_code=204)


@router.get("/users/{user_id}/connections")
async def user_connections(user_id: str, viewer: User = Depends(current_user)):
    """Someone's connections: the ones they share with the viewer first (mutual), then
    the others, by name. Nobody blocked either way with the viewer"""
    _visible_user(user_id, viewer)
    if not store.sees_story(viewer.id, user_id):
        return {"items": [], "total": None, "mutual": 0}
    mine = store.connections.get(viewer.id, {})
    people = [uid for uid in store.connections.get(user_id, {}) if uid != viewer.id and store.user(uid)
              and not store.blocked_either(viewer.id, uid)]
    people.sort(key=lambda uid: (uid not in mine, store.user(uid).name.lower()))
    return {
        "items": [{"user": summary_of(uid), "mutual": uid in mine} for uid in people],
        "total": len(store.connections.get(user_id, {})),
        "mutual": sum(1 for uid in people if uid in mine),
    }


@router.get("/me/notifications")
async def my_notifications(user: User = Depends(current_user)):
    return notifications.list_view(user.id)


@router.post("/me/notifications/read")
async def read_notifications(user: User = Depends(current_user)):
    notifications.mark_read(user.id)
    return {"unread": 0}
