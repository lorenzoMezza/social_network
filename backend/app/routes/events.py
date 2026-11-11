# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Events, ratings, albums and uploads (API.md)."""

import dataclasses
import re

from fastapi import APIRouter, Depends, Query, Request, Response

from .. import config, limits, media, notifications, position_guard, promotions
from ..auth import current_user
from ..domain import event_chat_open, leave_chat, notify_event, notify_spots, push_chat, watch_events
from ..errors import ApiError, bad_request, conflict, forbidden, not_found
from ..moderation import forget_member, require_rank
from ..realtime import hub, presences
from ..seed import seed_area, seed_event_chat
from ..store import Event, Photo, Rating, User, store
from ..util import iso, new_id, now_ms, parse_iso, plain_text, distance_m, DAY
from ..views import Urls, album_settings, event_detail, event_status, event_summary, photo_view, rating_view

router = APIRouter(prefix="/v1")

CATEGORIES = {
    "sales", "social", "free entry", "food", "drinks", "relaxing", "sports", "exposition", "games", "music",
    "shopping", "clothes", "technology", "festival", "festivities", "party", "competitive", "convention",
}
THEME_VALUES = {"background": {"plain", "glow", "tint", "aurora", "pattern"}, "title": {"classic", "bold", "serif", "mono"},
                "beamStyle": {"beam", "pulse", "helix", "stardust", "veil"}}
HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
# Only HTTPS, as the app opens only those: a link it would not open is not accepted
LINK = re.compile(r"^https://[^\s/$.?#][^\s]*\.[^\s]+$", re.I)
MINUTE = 60 * 1000
MAX_RANGE = 10_000

# Room between events (API.md, Events): two events are never drawn on top of each other.
# The map shows every event from the moment it is made until it ends, so two events
# closer than MIN_SPACING_M may not both be there (neither ended nor cancelled).
MIN_SPACING_M = 15
# A flash event is a plan for right around its organizer: made only this close to them.
# Where they are: their presence on the map, from their phone's GPS (the server's own).
# An invisible user's position is not kept (the server forgets it, API.md): the app then
# sends it with the request ("from"), used for this check only, never stored.
FLASH_MAX_DISTANCE_M = 500
# Events of one organizer not ended nor cancelled (upcoming or ongoing)
MAX_ACTIVE = 5
# Events are organized at most a month ahead: they start within this many days
MAX_DAYS_AHEAD = 31
# And last at most this many: an event holds its place (MIN_SPACING_M) and a slot of its
# organizer's until it ends
MAX_DAYS_LONG = 31


def _event(event_id: str, user: User) -> Event:
    event = store.events.get(event_id) if isinstance(event_id, str) else None
    if not event or store.blocked_either(user.id, event.creator_id):
        raise not_found("event not found")
    return event


def _own(event_id: str, user: User) -> Event:
    event = _event(event_id, user)
    if event.creator_id != user.id:
        raise forbidden("only the organizer can do this")
    return event


@router.get("/events")
async def nearby(
    latitude: float, longitude: float, range: int = 2000,
    categories: list[str] = Query(default=[]), user: User = Depends(current_user),
):
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise bad_request("position out of range")
    # An event is seen within its reach: asking from anywhere would make reach (and what
    # a promotion pays for) mean nothing
    if not position_guard.plausible(user.id, latitude, longitude):
        raise conflict("this position is not possible", code="position_rejected")
    radius = max(100, min(range, MAX_RANGE))
    watch_events(user.id, latitude, longitude, radius)
    seed_area(latitude, longitude, user)
    wanted = set(categories)
    if wanted - CATEGORIES:
        raise bad_request("unknown categories", sorted(wanted - CATEGORIES))
    now = now_ms()
    found = []
    for event in store.events.values():
        if event.cancelled or event.end < now - 24 * 60 * MINUTE or store.blocked_either(user.id, event.creator_id):
            continue
        if wanted and not wanted.intersection(event.categories):
            continue
        # Seen only within its reach (a promotion's radius while it is paid), and within
        # the distance the user asked for: a promotion never goes past the user's choice
        metres = distance_m(latitude, longitude, event.latitude, event.longitude)
        if metres <= min(radius, promotions.reach_now(event, now)):
            found.append((metres, event))
    found.sort(key=lambda entry: entry[0])
    return {"items": [event_summary(e, user.id) for _, e in found[:200]]}


# The answer of /me/events, each list: the latest ones (the story keeps the others)
OWN_LIST_MAX = 500
# Events one person joins at a time, not over yet: more than anyone can go to
JOINED_MAX = 200


def took_place(event: Event) -> bool:
    """It happened, even in part: it stays in the lists of who saved, joined or organized it.
    Only one cancelled before it began can be taken out of them."""
    if event.cancelled:
        return event.cancelled >= event.start
    return event_status(event) == "concluded"


def _in_saved(event: Event, user_id: str) -> bool:
    """In the user's Saved list: saved or joined, and not removed from it (cancelled ones only)"""
    if event.id in store.saved_hidden.get(user_id, set()):
        return False
    return event.id in store.saved.get(user_id, {}) or user_id in store.followers.get(event.id, {})


@router.get("/me/events")
async def own_events(user: User = Depends(current_user)):
    followed = [e for e in store.events.values() if e.creator_id != user.id and _in_saved(e, user.id) and not store.blocked_either(user.id, e.creator_id)]
    hidden = store.saved_hidden.get(user.id, set())
    created = [e for e in store.events.values() if e.creator_id == user.id and e.id not in hidden]
    order = lambda e: e.start  # noqa: E731
    return {
        "followed": [event_summary(e, user.id) for e in sorted(followed, key=order)[-OWN_LIST_MAX:]],
        "created": [event_summary(e, user.id) for e in sorted(created, key=order)[-OWN_LIST_MAX:]],
    }


@router.get("/events/{event_id}")
async def details(event_id: str, user: User = Depends(current_user)):
    return event_detail(_event(event_id, user), user.id)


def _theme(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise bad_request("theme: an object or null")
    color, beam, emoji = value.get("color"), value.get("beam"), value.get("emoji")
    emoji = plain_text(emoji) if isinstance(emoji, str) else emoji
    if color is not None and not HEX.fullmatch(str(color)):
        raise bad_request("theme.color: #RRGGBB")
    if beam is not None and not HEX.fullmatch(str(beam)):
        raise bad_request("theme.beam: #RRGGBB")
    # A symbol, not words: it shows on the map and in lists, where nobody could report it as text
    if emoji is not None and (not isinstance(emoji, str) or len(emoji) > 16 or any(c.isalnum() for c in emoji)):
        raise bad_request("theme.emoji: one emoji")
    for key, allowed in THEME_VALUES.items():
        if value.get(key) is not None and (not isinstance(value[key], str) or value[key] not in allowed):
            raise bad_request(f"theme.{key}: one of {sorted(allowed)}")
    return {"color": color, "beam": beam, "beamStyle": value.get("beamStyle") or "beam", "emoji": emoji, "background": value.get("background") or "plain", "title": value.get("title") or "classic"}


def _apply(event: Event, body: dict, creating: bool):
    """Validated fields of EventInput onto the event (all of them when creating)."""
    errors = []
    def need(key):  # noqa: E306
        return creating or key in body
    if need("title"):
        title = " ".join(plain_text(str(body.get("title") or "")).split())
        if not 1 <= len(title) <= 50:
            errors.append("title: 1–50 characters")
        event.title = title
    if need("description"):
        description = plain_text(str(body.get("description") or "")).strip()
        if not 1 <= len(description) <= 500:
            errors.append("description: 1–500 characters")
        event.description = description
    if need("categories"):
        categories = body.get("categories")
        if not isinstance(categories, list) or not categories or any(not isinstance(c, str) or c not in CATEGORIES for c in categories):
            errors.append("categories: at least one known category")
        else:
            event.categories = list(dict.fromkeys(categories))
    if need("location"):
        location = body.get("location") or {}
        try:
            lat, lon = float(location["latitude"]), float(location["longitude"])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError
            event.latitude, event.longitude = lat, lon
        except (KeyError, TypeError, ValueError):
            errors.append("location: latitude and longitude")
        address = location.get("address") if isinstance(location, dict) else None
        if address is not None and (not isinstance(address, str) or len(address) > 200):
            errors.append("location.address: at most 200 characters")
        event.address = plain_text(address) if isinstance(address, str) and address else None
    if need("dates"):
        dates = body.get("dates") if isinstance(body.get("dates"), dict) else {}
        start, end = parse_iso(dates.get("startDate")), parse_iso(dates.get("endDate"))
        if start is None or end is None or end <= start:
            errors.append("dates: startDate before endDate")
        elif end - start > MAX_DAYS_LONG * 24 * 60 * MINUTE and (creating or end - start > event.end - event.start):
            errors.append(f"dates: the event lasts at most {MAX_DAYS_LONG} days")
        elif (creating or start != event.start) and start < now_ms() - 5 * MINUTE:
            errors.append("dates: the event cannot start in the past")
        elif end <= now_ms():
            errors.append("dates: the event must end in the future")
        elif not creating and start != event.start and event.start <= now_ms():
            # What took place took place: its people, ratings and album are about that start
            errors.append("dates: an event under way keeps its start")
        elif not creating and end > event.created + (MAX_DAYS_AHEAD + MAX_DAYS_LONG) * DAY:
            # Moved on again and again it would stay on the map for good, for nothing
            errors.append(f"dates: an event ends at most {MAX_DAYS_AHEAD + MAX_DAYS_LONG} days after it was made")
        elif (creating or start != event.start) and start > now_ms() + MAX_DAYS_AHEAD * 24 * 60 * MINUTE:
            # A start it already had stays, even later (only moving it there is refused)
            errors.append(f"dates: the event starts at most {MAX_DAYS_AHEAD} days ahead")
        else:
            event.start, event.end = start, end
    if "links" in body:
        links = body.get("links")
        if links is not None and (not isinstance(links, str) or not LINK.fullmatch(links.strip()) or len(links) > 500):
            errors.append("links: a full https link")
        event.links = links.strip() if isinstance(links, str) and links else None
    # What it is stays what it was made as: a normal event turned flash would skip the
    # check that a flash event is made near its organizer
    if creating and "flash" in body:
        event.flash = bool(body.get("flash"))
    if "spotsNeeded" in body:
        spots = body.get("spotsNeeded")
        if isinstance(spots, bool) or not isinstance(spots, int) or not 0 <= spots <= 20:
            errors.append("spotsNeeded: 0–20")
        else:
            event.spots_needed = spots
    if "theme" in body:
        event.theme = _theme(body.get("theme"))
    if "reach" in body:
        reach = body.get("reach")
        if isinstance(reach, bool) or not isinstance(reach, int) or not promotions.REACH_MIN_M <= reach <= promotions.REACH_MAX_M:
            errors.append(f"reach: {promotions.REACH_MIN_M}–{promotions.REACH_MAX_M} metres")
        else:
            event.reach = reach
    if event.flash and not errors and (event.start > now_ms() + 65 * MINUTE or event.end - event.start > 185 * MINUTE):
        errors.append("flash events start within the hour and last at most 3 h")
    if errors:
        raise bad_request("invalid event", errors)


def _active(event: Event, now: int) -> bool:
    return not event.cancelled and event.end > now


def _check_room(event: Event):
    """409 too_close when another event within MIN_SPACING_M is not over (whoever made
    it, whenever it starts: the map of everyone around shows both until they end)."""
    now = now_ms()
    # A degree of latitude is ~111 km: farther than this is never close (cheap filter)
    near = MIN_SPACING_M / 100_000
    for other in store.events.values():
        if other.id == event.id or not _active(other, now):
            continue
        if abs(other.latitude - event.latitude) > near:
            continue
        if distance_m(event.latitude, event.longitude, other.latitude, other.longitude) < MIN_SPACING_M:
            raise conflict(f"another event is within {MIN_SPACING_M} m", code="too_close")


def _check_flash_near(event: Event, user: User, body: dict):
    """409 too_far for a flash event farther than FLASH_MAX_DISTANCE_M from its organizer,
    409 position_needed when where they are is not known."""
    if not event.flash:
        return
    presence = presences.get(user.id)
    if presence:
        latitude, longitude = presence.latitude, presence.longitude
    else:
        origin = body.get("from")
        try:
            latitude, longitude = float(origin["latitude"]), float(origin["longitude"])
        except (TypeError, KeyError, ValueError):
            raise conflict("where you are is needed to make a flash event", code="position_needed")
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise conflict("where you are is needed to make a flash event", code="position_needed")
        if not position_guard.plausible(user.id, latitude, longitude):
            raise conflict(f"flash events are made within {FLASH_MAX_DISTANCE_M} m of you", code="too_far")
    if distance_m(latitude, longitude, event.latitude, event.longitude) > FLASH_MAX_DISTANCE_M:
        raise conflict(f"flash events are made within {FLASH_MAX_DISTANCE_M} m of you", code="too_far")


def _check_active(event: Event, user: User):
    """409 too_many_events when the organizer already has MAX_ACTIVE others on."""
    now = now_ms()
    if not _active(event, now):
        return
    others = sum(1 for e in store.events.values() if e.creator_id == user.id and e.id != event.id and _active(e, now))
    if others >= MAX_ACTIVE:
        raise conflict(f"at most {MAX_ACTIVE} events on at once", code="too_many_events")


# Idempotency-Key of creating an event: (user, key) → the event made, and when. The answer
# lost on a bad network (a crowded square): sent again it is the same event, never a second
# one, nor "too close" to the user's own.
_made: dict[tuple[str, str], tuple[str, int]] = {}
MADE_KEPT_MS = 24 * 60 * MINUTE


# The same for a photo added to an album: (user, key) → (event, photo), and when. A photo
# whose answer was lost is the same photo when sent again, not a second one (and not "upload
# already used": the app would not know whether it was added)
_added: dict[tuple[str, str], tuple[str, str, int]] = {}


def sweep(now: int):
    for key in [key for key, (_, at) in _made.items() if at < now - MADE_KEPT_MS]:
        del _made[key]
    for key in [key for key, (_, _, at) in _added.items() if at < now - MADE_KEPT_MS]:
        del _added[key]


# Checked and stored with no await in between: on this single-threaded server no other
# request can take the place or the slot meanwhile
@router.post("/events", status_code=201)
async def create(body: dict, request: Request, user: User = Depends(current_user)):
    key = request.headers.get("idempotency-key")
    if key is not None and not 1 <= len(key) <= 64:
        raise bad_request("Idempotency-Key: at most 64 characters")
    made = store.events.get(_made[(user.id, key)][0]) if key and (user.id, key) in _made else None
    if made:
        return event_detail(made, user.id)
    limits.check(user.id, "event")
    now = now_ms()
    event = Event(id=new_id("ev"), creator_id=user.id, title="", description="", categories=[], latitude=0, longitude=0,
                  address=None, start=now, end=now, created=now)
    _apply(event, body, creating=True)
    _check_active(event, user)
    _check_room(event)
    _check_flash_near(event, user, body)
    store.events[event.id] = event
    if key:
        _made[(user.id, key)] = (event.id, now)
    # Its chat is the organizer's from now on
    push_chat(f"event:{event.id}", [user.id])
    # On the maps of everyone around, at once (a flash event lasts an hour or two)
    notify_event(event)
    return event_detail(event, user.id)


@router.patch("/events/{event_id}")
async def modify(event_id: str, body: dict, user: User = Depends(current_user)):
    event = _own(event_id, user)
    if event.cancelled:
        raise ApiError(410, "gone", "the event was cancelled")
    # What took place stays as it took place: its ratings, people and album are about
    # that event, and must not end up on another one with its title and date changed
    if event_status(event) == "concluded":
        raise ApiError(410, "gone", "the event is over")
    limits.check(user.id, "event-edit")
    # Applied to a copy: a refused change leaves the event as it was
    changed = dataclasses.replace(event)
    _apply(changed, body, creating=False)
    # A new place or new dates must leave room around it
    if (changed.latitude, changed.longitude, changed.start, changed.end) != (event.latitude, event.longitude, event.start, event.end):
        _check_room(changed)
        if (changed.latitude, changed.longitude) != (event.latitude, event.longitude):
            _check_flash_near(changed, user, body)
    # Its pictures last of all that can refuse, and before anything changes: a refused change
    # changes nothing, and a picture that could not be made leaves no other behind
    images = _new_images(event, body["images"], user) if "images" in body else None
    reach_before = promotions.reach_now(event)
    # What its people are told about: a new time or a new place
    changes = ([] if (changed.start, changed.end) == (event.start, event.end) else ["time"]) + \
        ([] if (changed.latitude, changed.longitude, changed.address) == (event.latitude, event.longitude, event.address) else ["place"])
    # Starting at another time: "starts soon" is said again for the new one
    if changed.start != event.start:
        store.reminded.discard(event.id)
    vars(event).update(vars(changed))
    if images is not None:
        previous, event.image_urls = event.image_urls, images
        media.discard(*(ref for ref in previous if ref not in images))
    # What was paid stays the time it was, wherever the event moves
    promotions.dates_changed(event)
    event.modified = now_ms()
    # A smaller reach is told to whoever saw it from farther
    notify_event(event, also_within=reach_before)
    if changes:
        notifications.notify_going(event, "event.changed", actor=user.id, data={"changes": changes})
    return event_detail(event, user.id)


IMAGES_MAX = 6
SAVED_MAX = 1000


def _new_images(event: Event, items, user: User) -> list:
    """The event's pictures as they are going to be, in order (the first is its cover): each
    one kept (`{ url }`, one of its current pictures) or new (`{ uploadId }`, purpose
    event-cover, made here). Everything is checked before any upload is used: a bad item
    changes nothing, and nothing stays behind of one that could not be made."""
    if not isinstance(items, list) or len(items) > IMAGES_MAX:
        raise bad_request(f"images: at most {IMAGES_MAX}")
    current = {Urls.public(ref): ref for ref in event.image_urls}
    plan = []
    for item in items:
        if not isinstance(item, dict) or len(item) != 1:
            raise bad_request("images: each one { url } or { uploadId }")
        if "url" in item:
            ref = current.get(item["url"])
            if ref is None:
                raise bad_request("images: a url that is not one of the event's pictures")
            plan.append(("keep", ref))
        elif "uploadId" in item and isinstance(item["uploadId"], str):
            upload = store.uploads.get(item["uploadId"])
            if not upload or upload.user_id != user.id or upload.purpose != "event-cover" or upload.event_id != event.id:
                raise bad_request("images: unknown upload")
            if upload.used or upload.expires_at < now_ms() or not upload.path:
                raise ApiError(410, "expired", "upload expired or already used")
            plan.append(("new", item["uploadId"]))
        else:
            raise bad_request("images: each one { url } or { uploadId }")
    kept = [ref for kind, ref in plan if kind == "keep"]
    if len(set(kept)) != len(kept) or len({ref for kind, ref in plan if kind == "new"}) != len(plan) - len(kept):
        raise bad_request("images: each picture once")
    made, images = [], []
    try:
        for kind, ref in plan:
            if kind == "keep":
                images.append(ref)
            else:
                made.append(media.event_cover(media.take(ref, user.id, "event-cover", event.id)))
                images.append(made[-1])
    except ApiError:
        media.discard(*made)
        raise
    return images


@router.delete("/events/{event_id}")
async def cancel(event_id: str, user: User = Depends(current_user)):
    event = _own(event_id, user)
    if not event.cancelled:
        if event_status(event) == "concluded":
            raise conflict("this event is over", code="past_event")
        event.cancelled = now_ms()
        # The time paid can no longer be given: what was not used goes back to the wallet
        promotions.cancelled(event)
        notifications.notify_going(event, "event.cancelled", actor=user.id)
        notify_event(event, also_within=max(promotions.RADII))
        for member in {event.creator_id, *store.followers.get(event.id, {})}:
            hub.send(member, {"type": "chat.removed", "chatId": f"event:{event.id}"})
    return event_detail(event, user.id)


@router.put("/events/{event_id}/followers/me")
async def follow(event_id: str, user: User = Depends(current_user)):
    event = _event(event_id, user)
    if event.cancelled:
        raise ApiError(410, "gone", "the event was cancelled")
    moderation = store.moderation.get(f"event:{event.id}")
    if moderation and user.id in moderation.banned:
        raise forbidden("you were removed from this event")
    followers = store.follower_ids(event.id)
    if user.id not in followers:
        # Nobody joins what is over: it would say they went (and let them rate it)
        if event_status(event) == "concluded":
            raise ApiError(410, "gone", "the event is over")
        # A flash event asks for so many people: then it has them
        if event.flash and event.spots_needed and sum(uid != event.creator_id for uid in followers) >= event.spots_needed:
            raise conflict("everyone it was looking for has joined", code="full")
        limits.check(user.id, "join")
        now = now_ms()
        if sum(1 for other in store.events.values() if other.end > now and not other.cancelled and user.id in store.followers.get(other.id, {})) >= JOINED_MAX:
            raise conflict(f"at most {JOINED_MAX} events at a time", code="too_many_joined")
        followers[user.id] = now_ms()
        # Its chat opens with what was said so far to read, not counted as new (the demo
        # people's first messages, made the first time a chat is read, included)
        seed_event_chat(event)
        said = store.messages.get(f"event:{event.id}")
        if said:
            store.read_at[(f"event:{event.id}", user.id)] = said[-1].at
        push_chat(f"event:{event.id}", [user.id])
        notifications.notify(event.creator_id, "event.joined", actor=user.id, event=event)
        notify_spots(event)
    # Back in the Saved list, if it was removed from it
    store.saved_hidden.get(user.id, set()).discard(event.id)
    return {"following": True, "followerCount": len(followers)}


@router.delete("/events/{event_id}/followers/me")
async def unfollow(event_id: str, user: User = Depends(current_user)):
    event = _event(event_id, user)
    followers = store.follower_ids(event.id)
    if user.id in followers:
        if took_place(event):
            raise conflict("this event is over", code="past_event")
        limits.check(user.id, "join")
        if event.creator_id != user.id and event_chat_open(event):
            # The same as leaving from its chat: its people are told, and so are the
            # user's other devices
            leave_chat(f"event:{event.id}", user.id)
        else:
            del followers[user.id]
            if event.creator_id != user.id:
                forget_member(f"event:{event.id}", user.id)
    return {"following": False, "followerCount": len(followers)}


@router.put("/events/{event_id}/saved/me")
async def save(event_id: str, user: User = Depends(current_user)):
    """Saved: a private bookmark (nobody is told; the event is in the user's Saved list)"""
    event = _event(event_id, user)
    limits.check(user.id, "save")
    mine = store.saved.get(user.id, {})
    # What is over cannot be saved any more: it could never be taken out again
    if event.id not in mine and took_place(event):
        raise conflict("this event is over", code="past_event")
    # Only what can still happen counts: the past stays in the list, and must not fill it
    if event.id not in mine and sum(1 for saved in mine if saved in store.events and not took_place(store.events[saved])) >= SAVED_MAX:
        raise conflict("you have saved as many events as one can", code="too_many_saved")
    store.saved.setdefault(user.id, {}).setdefault(event.id, now_ms())
    store.saved_hidden.get(user.id, set()).discard(event.id)
    return {"saved": True}


@router.delete("/events/{event_id}/saved/me")
async def unsave(event_id: str, user: User = Depends(current_user)):
    """Not saved any more. An event that took place cannot be taken out of the lists; one
    cancelled before it began also leaves them, for who joined or organized it too"""
    event = _event(event_id, user)
    if took_place(event):
        raise conflict("this event is over", code="past_event")
    store.saved.get(user.id, {}).pop(event.id, None)
    if event.cancelled:
        store.saved_hidden.setdefault(user.id, set()).add(event.id)
    return {"saved": False}


@router.delete("/me/saved/cancelled", status_code=204)
async def clear_cancelled(user: User = Depends(current_user)):
    """Every event cancelled before it began out of the Saved list at once"""
    for event in store.events.values():
        if event.cancelled and not took_place(event) and _in_saved(event, user.id):
            store.saved.get(user.id, {}).pop(event.id, None)
            store.saved_hidden.setdefault(user.id, set()).add(event.id)
    return Response(status_code=204)


def _rating_input(body: dict) -> tuple[float, str]:
    rating, comment = body.get("rating"), body.get("comment") or ""
    if isinstance(rating, bool) or not isinstance(rating, (int, float)) or not 0 <= rating <= 10:
        raise bad_request("rating: 0–10")
    if not isinstance(comment, str) or len(comment) > 500:
        raise bad_request("comment: at most 500 characters")
    return float(rating), plain_text(comment).strip()


@router.post("/events/{event_id}/ratings", status_code=201)
async def rate(event_id: str, body: dict, user: User = Depends(current_user)):
    event = _event(event_id, user)
    if user.id == event.creator_id or user.id not in store.followers.get(event.id, {}) or event_status(event) not in ("ongoing", "concluded"):
        raise forbidden("only people who joined it rate it, once it started")
    ratings = store.ratings.setdefault(event.id, {})
    if user.id in ratings:
        raise conflict("already rated")
    value, comment = _rating_input(body)
    limits.check(user.id, "rating")
    ratings[user.id] = Rating(id=new_id("rt"), user_id=user.id, rating=value, comment=comment, date=now_ms())
    notifications.notify(event.creator_id, "event.rated", actor=user.id, event=event, data={"rating": value})
    return rating_view(ratings[user.id])


@router.put("/events/{event_id}/ratings/me")
async def rerate(event_id: str, body: dict, user: User = Depends(current_user)):
    event = _event(event_id, user)
    rating = store.ratings.get(event.id, {}).get(user.id)
    if not rating:
        raise not_found("no rating to change")
    rating.rating, rating.comment = _rating_input(body)
    rating.modified = now_ms()
    return rating_view(rating)


@router.delete("/events/{event_id}/ratings/me", status_code=204)
async def unrate(event_id: str, user: User = Depends(current_user)):
    # Their own words: they can take them back also from who blocked them
    store.ratings.get(event_id, {}).pop(user.id, None)
    return Response(status_code=204)


# --- albums ---

def _album_open(event: Event) -> bool:
    return not event.cancelled and now_ms() >= event.start


# How many photos: enough for an evening, and no one fills an album or the storage. A photo
# removed makes room again; they stay as long as their event (a year after it ends)
PHOTOS_PER_EVENT = 500
PHOTOS_PER_PERSON = 30         # in one album
PHOTOS_BY_ORGANIZER = 200      # their own album: they run it
PHOTOS_PER_DAY = 100           # in all albums
PHOTOS_PER_ACCOUNT = 2000      # in all albums, kept at once


def _photos_of(user_id: str) -> list[Photo]:
    return [photo for album in store.albums.values() for photo in album.photos if photo.author_id == user_id]


def _check_photo_room(event: Event, user_id: str):
    """409 album_full, or photo_limit when this person has added all they may"""
    album = store.album(event.id)
    if len(album.photos) >= PHOTOS_PER_EVENT:
        raise conflict("this album is full", code="album_full")
    allowed = PHOTOS_BY_ORGANIZER if user_id == event.creator_id else PHOTOS_PER_PERSON
    if sum(1 for photo in album.photos if photo.author_id == user_id) >= allowed:
        raise conflict(f"at most {allowed} photos in an album", code="photo_limit")
    mine = _photos_of(user_id)
    if len(mine) >= PHOTOS_PER_ACCOUNT or sum(1 for photo in mine if photo.created_at > now_ms() - DAY) >= PHOTOS_PER_DAY:
        raise conflict("you have added all the photos you can for now", code="photo_limit")


def _can_post(event: Event, user_id: str) -> bool:
    if not _album_open(event):
        return False
    if event.creator_id == user_id:
        return True
    # Whoever posts is going to it: someone who left or was removed adds nothing, also if
    # the organizer had chosen them
    album = store.album(event.id)
    if album.who_can_post == "organizer" or user_id not in store.followers.get(event.id, {}):
        return False
    return album.who_can_post != "chosen" or user_id in album.contributors


@router.get("/events/{event_id}/photos")
async def photos(event_id: str, cursor: str | None = None, limit: int = 60, user: User = Depends(current_user)):
    event = _event(event_id, user)
    limit = max(1, min(limit, 100))
    album = store.album(event.id)
    shown = [p for p in album.photos if not store.blocked_either(user.id, p.author_id)] if not event.cancelled else []
    start = int(cursor) if cursor and cursor.isdigit() else 0
    page = shown[start:start + limit]
    return {
        "settings": album_settings(event.id, user.id),
        "items": [photo_view(p, user.id) for p in page],
        "total": len(shown),
        # How many more the user may add here, so the app never asks for what would fail
        "room": max(0, min(
            PHOTOS_PER_EVENT - len(album.photos),
            (PHOTOS_BY_ORGANIZER if user.id == event.creator_id else PHOTOS_PER_PERSON) - sum(1 for p in album.photos if p.author_id == user.id),
        )),
        "nextCursor": str(start + limit) if start + limit < len(shown) else None,
    }


@router.put("/events/{event_id}/photos/settings")
async def album_rules(event_id: str, body: dict, user: User = Depends(current_user)):
    event = _own(event_id, user)
    who, contributors = body.get("whoCanPost"), body.get("contributors") or []
    if who not in ("everyone", "chosen", "organizer"):
        raise bad_request("whoCanPost: everyone, chosen or organizer")
    followers = store.followers.get(event.id, {})
    if not isinstance(contributors, list) or any(not isinstance(c, str) or c not in followers for c in contributors):
        raise bad_request("contributors: people who saved the event")
    album = store.album(event.id)
    album.who_can_post, album.contributors = who, list(dict.fromkeys(contributors))
    return album_settings(event.id, user.id)


@router.post("/events/{event_id}/photos", status_code=201)
async def add_photo(event_id: str, body: dict, request: Request, user: User = Depends(current_user)):
    event = _event(event_id, user)
    if not _can_post(event, user.id):
        raise forbidden("you can't add photos to this event")
    key = request.headers.get("idempotency-key")
    if key is not None and not 1 <= len(key) <= 64:
        raise bad_request("Idempotency-Key: at most 64 characters")
    if key and (user.id, key) in _added:
        added_to, photo_id, _ = _added[(user.id, key)]
        again = next((p for p in store.album(event.id).photos if p.id == photo_id), None) if added_to == event.id else None
        # Removed meanwhile: it is not put back, and its upload is used (410 below)
        if again:
            return photo_view(again, user.id)
    _check_photo_room(event, user.id)
    upload = media.take(body.get("uploadId"), user.id, "event-photo", event.id)
    url, thumb, width, height = media.album_photo(upload)
    photo = Photo(id=new_id("ph"), event_id=event.id, url=url, thumb_url=thumb, width=width, height=height, author_id=user.id, created_at=now_ms())
    store.album(event.id).photos.insert(0, photo)
    if key:
        _added[(user.id, key)] = (event.id, photo.id, now_ms())
    # Who was there (and its organizer) see the album grow; gathered per event
    notifications.notify_going(event, "album.photos", actor=user.id, also=[event.creator_id], but=[user.id])
    return photo_view(photo, user.id)


@router.delete("/events/{event_id}/photos/{photo_id}", status_code=204)
async def delete_photo(event_id: str, photo_id: str, user: User = Depends(current_user)):
    # Their own photo: they can take it back also from who blocked them
    event = store.events.get(event_id)
    album = store.albums.get(event_id)
    photo = next((p for p in album.photos if p.id == photo_id), None) if album else None
    if not event or not photo or (photo.author_id != user.id and store.blocked_either(user.id, event.creator_id)):
        raise not_found("photo not found")
    if user.id not in (photo.author_id, event.creator_id):
        raise forbidden("only its author or the organizer")
    album.photos.remove(photo)
    media.discard(photo.url, photo.thumb_url)
    return Response(status_code=204)


# --- uploads ---

@router.post("/uploads")
async def upload_ticket(body: dict, user: User = Depends(current_user)):
    purpose, event_id, chat_id = body.get("purpose"), body.get("eventId"), body.get("chatId")
    if purpose in ("event-cover", "event-photo"):
        event = _event(event_id or "", user)
        if purpose == "event-cover" and event.creator_id != user.id:
            raise forbidden("only the organizer sets the cover")
        # Refused here, before the file is sent at all
        if purpose == "event-photo":
            if not _can_post(event, user.id):
                raise forbidden("you can't add photos to this event")
            _check_photo_room(event, user.id)
    elif event_id is not None:
        raise bad_request("eventId only for event uploads")
    if purpose == "group-picture":
        chat = store.chats.get(chat_id) if isinstance(chat_id, str) else None
        if not chat or chat.kind != "group":
            raise not_found("chat not found")
        require_rank(chat_id, user.id, chat.members)
    elif chat_id is not None:
        raise bad_request("chatId only for a group's picture")
    limits.check(user.id, "upload")
    return media.create_ticket(user.id, purpose, body.get("mimeType"), body.get("fileSize"), event_id, chat_id)


@router.put("/storage/{upload_id}")
async def storage_put(upload_id: str, expires: int, signature: str, request: Request):
    """The object storage's side (development): the file sent to its signed address."""
    upload, limit = media.open_address(upload_id, expires, signature)
    announced = request.headers.get("content-length")
    if announced and announced.isdigit() and int(announced) > limit:
        raise ApiError(413, "too_large", "bigger than announced")
    await media.receive(upload, limit, request.stream())
    return {"ok": True, "receivedAt": iso(now_ms())}
