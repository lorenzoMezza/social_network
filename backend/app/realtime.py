# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The WebSocket of API.md: one per signed-in app. A hub keyed by user (a user may have
several devices), the presence of people on the map (who sees whom, area points,
deltas), gestures, words to everyone around, and the demo people (bots) who walk on
the map and answer.

Presence costs: positions live in a grid of ~1 km cells; a change marks the user dirty,
and twice a second only the viewers in the 3×3 cells around the dirty ones are
recomputed, each getting one delta with what changed for them."""

import asyncio
import hashlib
import hmac
import math
import secrets
import random
import time
from dataclasses import dataclass, field

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import config, limits, position_guard
from .auth import user_from_token, _claims_for
from .errors import ApiError
from .seed import bot_id
from .store import store
from .util import distance_m, iso, new_id, now_ms, offset_bearing, plain_text, unit_hash
from .views import summary_of

router = APIRouter()

RANGE_M = 1000
# The most people one map shows: the user's connections first, then the nearest. Measured
# (make map-bench-people): 25 cost the phone's GPU about 1.4× an empty map and 35 MB of GPU
# memory; beyond 300 the frame time collapses. In a crowd everyone is someone's nearest,
# so everyone is still seen by those around them.
MAX_SHOWN = 25
# Someone already shown counts as this much closer: two people at about the same distance
# do not take turns on the map
SHOWN_ADVANTAGE = 0.85
# Someone who waves at a person enters that person's map for a minute, also in a crowd: the
# map plays a gesture only on someone it shows. The gesture waits a moment for the map to
# draw them.
PINNED_S = 60
PIN_DELAY_S = 0.3
# Approximate mode: the real position is known only to a square of AREA_CELL_M; the
# point shown stands near its centre, AREA_JITTER_M away at most (within ~300 m of the
# real position, as the app tells the user)
AREA_CELL_M = 300
AREA_JITTER_M = 100
TTL_S = 45
CELL_M = 1000
FLUSH_S = 0.5
FRAME_RATE = 10
FRAME_BURST = 30
MAX_SOCKETS_PER_USER = 5
GESTURES = {"wave", "handsair", "fistpump", "dab"}
GESTURE_COOLDOWN_S = 2
BROADCAST_MAX = 120
BROADCAST_COOLDOWN_S = 10
# "Connect" on someone: one invitation to the same person every 10 s, valid a minute
INVITE_COOLDOWN_S = 10
# What a phone may say about how it moves: anything else is not sent to anybody. These numbers
# reach other people's phones
HEADING_RANGE = (0, 360)
SPEED_RANGE = (0, 150)
INVITE_TTL_S = 60


# --- sockets ---

class Client:
    def __init__(self, ws: WebSocket, user_id: str):
        self.ws = ws
        self.user_id = user_id
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        # People whose UserSummary this connection already received with a presence
        # Person → their UserSummary as last sent on this connection
        self.known: dict[str, dict] = {}
        self.presence_started = False
        # How many people have the user on their map, as last told on this connection
        self.audience: int | None = None
        # What the phone can do to connect in person (`device` frame): kept only here, in
        # memory, for as long as the connection lasts
        # Frames allowed: 10 a second on average, bursts of 30 (an app sends ~1 a second)
        self.budget = FRAME_BURST
        self.budget_at = time.monotonic()
        self.opened_at = time.monotonic()

    def allow(self) -> bool:
        now = time.monotonic()
        self.budget = min(FRAME_BURST, self.budget + (now - self.budget_at) * FRAME_RATE)
        self.budget_at = now
        if self.budget < 1:
            return False
        self.budget -= 1
        return True

    def push(self, payload: dict):
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            # A client that does not read: it reconnects and gets a fresh snapshot
            asyncio.get_running_loop().create_task(self.ws.close(1013))

    async def writer(self):
        while True:
            payload = await self.queue.get()
            # Text frames: JSON is text, and React Native's WebSocket hands binary frames
            # over as blobs. One frame that cannot be written costs that frame, not the socket
            try:
                text = orjson.dumps(payload).decode()
            except TypeError as error:
                print("frame not sent:", repr(error))
                continue
            await self.ws.send_text(text)


class Hub:
    def __init__(self):
        self.clients: dict[str, set[Client]] = {}

    def add(self, client: Client):
        group = self.clients.setdefault(client.user_id, set())
        # A person has a few devices; a script opening sockets without end does not get
        # them: the oldest one goes
        while len(group) >= MAX_SOCKETS_PER_USER:
            oldest = min(group, key=lambda other: other.opened_at)
            group.discard(oldest)
            asyncio.ensure_future(oldest.ws.close(1008))
        group.add(client)

    def close_all(self, user_id: str, code: int = 4001):
        """Their sockets end now: the account was deleted"""
        for client in self.clients.pop(user_id, set()):
            asyncio.ensure_future(client.ws.close(code))

    def remove(self, client: Client):
        group = self.clients.get(client.user_id)
        if group:
            group.discard(client)
            if not group:
                del self.clients[client.user_id]

    def online(self, user_id: str) -> bool:
        return user_id in self.clients

    def send(self, user_id: str, payload: dict):
        for client in self.clients.get(user_id, ()):
            client.push(payload)


hub = Hub()


# --- presence ---

@dataclass
class Presence:
    user_id: str
    mode: str
    latitude: float
    longitude: float
    accuracy: float | None = None
    heading: float | None = None
    speed: float | None = None
    moving: bool | None = None
    updated: float = field(default_factory=time.monotonic)
    updated_at: int = field(default_factory=now_ms)
    cell: tuple = (0, 0)
    area: tuple | None = None  # (cell, latitude, longitude)
    # The connection that sends it: when that one ends, so does the presence
    owner: object = None


presences: dict[str, Presence] = {}
grid: dict[tuple, set[str]] = {}
# viewer → target → what the viewer last got (to send only changes)
seen: dict[str, dict[str, tuple]] = {}
dirty: dict[str, tuple] = {}  # user → the cell they were in before the change
_last_gesture: dict[tuple, float] = {}
_last_broadcast: dict[str, float] = {}
_pinned: dict[str, dict[str, float]] = {}  # viewer → who waved at them → until


def cell_of(latitude: float, longitude: float) -> tuple:
    return (
        math.floor(latitude * 111_320 / CELL_M),
        math.floor(longitude * 111_320 * math.cos(math.radians(latitude)) / CELL_M),
    )


def around(cell: tuple):
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            yield from grid.get((cell[0] + dx, cell[1] + dy), ())


def sight(a: str, b: str) -> str:
    if a == "invisible" or b == "invisible":
        return "none"
    if a == "visible" and b == "visible":
        return "precise"
    return "area"


# The jitter comes from a key only this server knows: from public data (the user's ID,
# the time) nobody can compute it and subtract it
_AREA_KEY = secrets.token_bytes(32)


def _area_point(presence: Presence) -> tuple[float, float]:
    """Where someone in approximate mode is shown: the centre of the square of the grid
    they are in, moved by a secret amount that stays the same for them in that square
    for the day. It depends on the square, not on the real position: watching it for
    hours and averaging gives the square, never the place (a new random point around
    the real position every few minutes would give it away). It changes only when they
    walk into another square."""
    lat_step = AREA_CELL_M / 111_320
    row = math.floor(presence.latitude / lat_step)
    lon_step = AREA_CELL_M / (111_320 * max(math.cos(math.radians((row + 0.5) * lat_step)), 0.01))
    column = math.floor(presence.longitude / lon_step)
    cell = (row, column, int(time.time() // 86_400))
    if not presence.area or presence.area[0] != cell:
        digest = hmac.new(_AREA_KEY, f"{presence.user_id}:{cell}".encode(), hashlib.sha256).digest()
        metres = math.sqrt(int.from_bytes(digest[:4], "big") / 2**32) * AREA_JITTER_M
        bearing = int.from_bytes(digest[4:8], "big") / 2**32 * 360
        lat, lon = offset_bearing((row + 0.5) * lat_step, (column + 0.5) * lon_step, metres, bearing)
        presence.area = (cell, lat, lon)
    return presence.area[1], presence.area[2]


def visible_to(viewer_id: str) -> list[tuple[Presence, str, float]]:
    """Who the viewer's map shows now: (presence, precision, metres), nearest first. At
    most MAX_SHOWN of the people in range: their connections, then who just waved at them
    (never over a connection: a crowd of strangers waving hides no friend), then the nearest."""
    found = in_range(viewer_id)
    if len(found) <= MAX_SHOWN:
        return found
    mine = store.connections.get(viewer_id, {})
    shown = seen.get(viewer_id, {})
    now = time.monotonic()
    pinned = _pinned.get(viewer_id, {})
    chosen = sorted(found, key=lambda entry: (
        0 if entry[0].user_id in mine else 1 if pinned.get(entry[0].user_id, 0) > now else 2,
        entry[2] * (SHOWN_ADVANTAGE if entry[0].user_id in shown else 1),
    ))[:MAX_SHOWN]
    chosen.sort(key=lambda entry: entry[2])
    return chosen


def in_range(viewer_id: str) -> list[tuple[Presence, str, float]]:
    """Everyone within range who may see the viewer and be seen: (presence, precision,
    metres), nearest first."""
    me = presences.get(viewer_id)
    if not me or me.mode == "invisible":
        return []
    found = []
    for other_id in around(me.cell):
        if other_id == viewer_id:
            continue
        other = presences[other_id]
        precision = sight(me.mode, other.mode)
        if precision == "none" or store.blocked_either(viewer_id, other_id):
            continue
        # Shown by area: whether they are in range is decided by the point shown, or
        # walking along the edge of the range would trace the circle around the real place
        latitude, longitude = (other.latitude, other.longitude) if precision == "precise" else _area_point(other)
        metres = distance_m(me.latitude, me.longitude, latitude, longitude)
        if metres <= RANGE_M:
            found.append((other, precision, metres))
    found.sort(key=lambda entry: entry[2])
    return found


def are_near(a: str, b: str) -> bool:
    """Whether two people are around each other right now (direct messages, gestures,
    invitations): whoever they are, also in a crowd where the map does not show them."""
    return any(entry[0].user_id == b for entry in in_range(a))


def _shown(presence: Presence, precision: str) -> tuple:
    if precision == "precise":
        return ("precise", round(presence.latitude, 6), round(presence.longitude, 6),
                None if presence.heading is None else round(presence.heading),
                None if presence.speed is None else round(presence.speed, 1), presence.moving)
    lat, lon = _area_point(presence)
    return ("area", round(lat, 6), round(lon, 6), None, None, None)


def _payload(client: Client | None, presence: Presence, shown: tuple) -> dict:
    precision, lat, lon, heading, speed, moving = shown
    user = store.user(presence.user_id)
    payload = {
        "userId": presence.user_id,
        "position": {"latitude": lat, "longitude": lon},
        "precision": precision,
        "heading": heading,
        "speed": speed,
        "moving": moving,
        "avatarVersion": user.avatar_version if user else 0,
        "updatedAt": iso(presence.updated_at),
    }
    # Their UserSummary the first time, and again whenever it changed (a new name or
    # picture): the app's copies of people are corrected at once
    if client is not None:
        summary = summary_of(presence.user_id)
        if client.known.get(presence.user_id) != summary:
            payload["user"] = summary
            client.known[presence.user_id] = summary
    return payload


def _send_view(viewer_id: str, snapshot: bool):
    clients = hub.clients.get(viewer_id)
    if not clients:
        return
    now_view = {presence.user_id: (presence, _shown(presence, precision)) for presence, precision, _ in visible_to(viewer_id)}
    before = seen.get(viewer_id, {})
    seen[viewer_id] = {uid: shown for uid, (_, shown) in now_view.items()}
    for client in clients:
        if snapshot:
            client.push({"type": "presence.snapshot", "people": [_payload(client, p, s) for p, s in now_view.values()]})
            client.presence_started = True
            client.audience = None  # told again: the app forgot it when it left the map
        elif client.presence_started:
            changed = [_payload(client, p, s) for uid, (p, s) in now_view.items() if before.get(uid) != s]
            removed = [uid for uid in before if uid not in now_view]
            if changed or removed:
                client.push({"type": "presence.delta", "people": changed, "removed": removed})


def update_presence(user_id: str, mode: str, position: dict | None):
    old = presences.get(user_id)
    old_cell = old.cell if old else None
    if mode == "invisible" or not position:
        if old:
            grid.get(old.cell, set()).discard(user_id)
            del presences[user_id]
            dirty[user_id] = old_cell
        if mode == "invisible":
            seen.pop(user_id, None)
            hub.send(user_id, {"type": "presence.snapshot", "people": []})
        return
    lat, lon = position["latitude"], position["longitude"]
    presence = old or Presence(user_id=user_id, mode=mode, latitude=lat, longitude=lon)
    presence.mode = mode
    presence.latitude, presence.longitude = lat, lon
    presence.accuracy = position.get("accuracy")
    presence.heading = position.get("heading")
    presence.speed = position.get("speed")
    presence.moving = position.get("moving")
    presence.updated = time.monotonic()
    presence.updated_at = now_ms()
    new_cell = cell_of(lat, lon)
    if old_cell != new_cell:
        if old_cell is not None:
            grid.get(old_cell, set()).discard(user_id)
        grid.setdefault(new_cell, set()).add(user_id)
        presence.cell = new_cell
    presences[user_id] = presence
    dirty[user_id] = old_cell or new_cell


async def presence_loop():
    while True:
        await asyncio.sleep(FLUSH_S)
        try:
            _expire()
            _move_bots()
            if not dirty:
                continue
            changes = dict(dirty)
            dirty.clear()
            viewers = set()
            for user_id, old_cell in changes.items():
                viewers.add(user_id)
                presence = presences.get(user_id)
                for cell in {old_cell, presence.cell if presence else None} - {None}:
                    viewers.update(around(cell))
            for viewer in viewers:
                if viewer in hub.clients:
                    _send_view(viewer, snapshot=False)
            # After everyone's view is up to date: who sees whom just changed
            _send_audiences(viewers)
        except Exception as error:  # noqa: BLE001 (the loop must survive)
            print("presence loop:", repr(error))


def _send_audiences(viewers):
    """How many people have each one on their map, told when it changes. Only the server
    knows: in a crowd it differs from the people they see."""
    for viewer in viewers:
        clients = hub.clients.get(viewer)
        if not clients:
            continue
        count = len(_audience(viewer))
        for client in clients:
            if client.presence_started and client.audience != count:
                client.audience = count
                client.push({"type": "presence.delta", "people": [], "removed": [], "audience": count})


def _expire():
    limit = time.monotonic() - TTL_S
    for user_id, presence in list(presences.items()):
        if presence.updated < limit and not store.users[user_id].bot:
            update_presence(user_id, "visible", None)


# --- the demo people on the map ---

# [username, mode, metres from the anchor, bearing, loop radius (0: standing), speed]
BOTS = [
    ("sara_m", "visible", 30, 20, 10, 1.1),
    ("tommi", "visible", 38, 120, 0, 0),
    ("nico_l", "visible", 45, 220, 14, 1.3),
    ("chiara.v", "visible", 60, 300, 24, 2.8),
    ("davide88", "visible", 52, 70, 0, 0),
    ("irene", "visible", 70, 170, 18, 1.2),
    ("fede", "visible", 85, 340, 30, 1.4),
    ("elena", "approximate", 140, 255, 0, 0),
    ("marta", "approximate", 320, 200, 0, 0),
    ("gio", "invisible", 40, 260, 12, 1.2),
    # Not connected with the user, walking by: Connect, and a chat while near
    ("ale.b", "visible", 95, 30, 16, 1.0),
]
BOT_GESTURE_ANSWERS = {"wave": "wave", "handsair": "fistpump", "fistpump": "handsair", "dab": "dab"}
BOT_BROADCAST_ANSWERS = ["Hi! 👋", "Hello neighbour!", "Anyone up for a coffee?", "🙌", "I see you!", "Nice day out here"]
BOT_REPLIES = ["Hey! 👋", "Haha, I see you!", "Coming over", "What are you up to?", "Nice to see you around", "Wave back 🙌"]
_anchor: tuple | None = None
_bot_replied: dict[str, float] = {}
_answer_index = 0


def anchor_bots(latitude: float, longitude: float):
    """Center the demo people around a real user who just became map-visible."""
    global _anchor
    if not config.DEV_TOOLS:
        return
    _anchor = (latitude, longitude)
    _move_bots(move_standing=True)


def _move_bots(move_standing: bool = False):
    if _anchor is None:
        return
    t = time.time()
    for username, mode, metres, bearing, radius, speed in BOTS:
        if mode == "invisible":
            continue
        home = offset_bearing(_anchor[0], _anchor[1], metres, bearing)
        if radius:
            angle = unit_hash(username) * math.tau + (speed / radius) * t
            lat, lon = offset_bearing(home[0], home[1], radius, math.degrees(angle))
            heading = (math.degrees(angle) + 90) % 360
            position = {"latitude": lat, "longitude": lon, "heading": heading, "speed": speed, "moving": True}
        else:
            if bot_id(username) in presences and not move_standing:
                continue
            position = {"latitude": home[0], "longitude": home[1], "heading": None, "speed": 0, "moving": False}
        update_presence(bot_id(username), mode, position)


def sweep():
    """Forgets cooldowns that ran out (called now and then by the janitor)."""
    now = time.monotonic()
    for key in [key for key, at in _last_gesture.items() if at < now - GESTURE_COOLDOWN_S]:
        del _last_gesture[key]
    for key in [key for key, at in _last_broadcast.items() if at < now - BROADCAST_COOLDOWN_S]:
        del _last_broadcast[key]
    for key in [key for key, at in _bot_replied.items() if at < now - 60]:
        del _bot_replied[key]
    for viewer, people in list(_pinned.items()):
        for person in [person for person, until in people.items() if until <= now]:
            del people[person]
        if not people:
            del _pinned[viewer]
    sweep_invites()
    position_guard.sweep()


def _later(seconds: float, run):
    asyncio.get_running_loop().call_later(seconds, run)


def _deliver_gesture(sender: str, target: str, gesture: str):
    hub.send(target, {"type": "gesture", "id": new_id("g"), "from": sender, "gesture": gesture, "at": iso(now_ms())})


def send_gesture(sender: str, target: str, gesture: str):
    if gesture not in GESTURES:
        raise ApiError(400, "bad_request", "unknown gesture")
    if target not in store.users:
        raise ApiError(404, "not_found", "unknown person")
    if not are_near(sender, target):
        raise ApiError(403, "forbidden", "they cannot see you on the map now")
    key = (sender, target)
    if time.monotonic() - _last_gesture.get(key, 0) < GESTURE_COOLDOWN_S:
        raise ApiError(429, "rate_limited", "one gesture every 2 s")
    limits.check(sender, "gesture")
    _last_gesture[key] = time.monotonic()
    already_shown = sender in seen.get(target, {})
    _pinned.setdefault(target, {})[sender] = time.monotonic() + PINNED_S
    if sender in presences:
        dirty[sender] = presences[sender].cell  # one more person may see them now
    if already_shown or not hub.online(target):
        _deliver_gesture(sender, target, gesture)
    else:
        _send_view(target, snapshot=False)
        _later(PIN_DELAY_S, lambda: _deliver_gesture(sender, target, gesture))
    if store.users[target].bot:
        _later(1.1, lambda: _deliver_gesture(target, sender, BOT_GESTURE_ANSWERS[gesture]))


def _audience(sender: str) -> list[str]:
    """Who has the sender on their map now: only they see what is said over their head"""
    return [entry[0].user_id for entry in in_range(sender)
            if any(shown[0].user_id == sender for shown in visible_to(entry[0].user_id))]


def _deliver_broadcast(sender: str, text: str) -> int:
    recipients = _audience(sender)
    payload = {"type": "broadcast", "id": new_id("b"), "from": sender, "text": text, "at": iso(now_ms())}
    for user_id in recipients:
        hub.send(user_id, payload)
    return len(recipients)


def send_broadcast(sender: str, text: str) -> int:
    text = plain_text(text).strip() if isinstance(text, str) else ""
    if not text or len(text) > BROADCAST_MAX:
        raise ApiError(400, "bad_request", "1–120 characters")
    presence = presences.get(sender)
    if not presence or presence.mode == "invisible":
        raise ApiError(403, "forbidden", "nobody sees you while you are invisible")
    if time.monotonic() - _last_broadcast.get(sender, 0) < BROADCAST_COOLDOWN_S:
        raise ApiError(429, "rate_limited", "one message every 10 s")
    _last_broadcast[sender] = time.monotonic()
    count = _deliver_broadcast(sender, text)
    global _answer_index
    bots = [uid for uid in _audience(sender) if store.users[uid].bot][:2]
    for n, bot in enumerate(bots):
        answer = BOT_BROADCAST_ANSWERS[(_answer_index + n) % len(BOT_BROADCAST_ANSWERS)]
        _later(1.8 + n * 1.7 + random.random() * 0.6, lambda bot=bot, answer=answer: _deliver_broadcast(bot, answer))
    _answer_index += len(bots)
    return count


def bot_reply(chat_id: str, bot: str, post):
    """A demo person answers a direct message a moment later, once in a while per chat.
    `post(sender, text)` stores and delivers the answer."""
    if time.monotonic() - _bot_replied.get(chat_id, -100) < 15:
        return
    _bot_replied[chat_id] = time.monotonic()
    count = len(store.messages.get(chat_id, []))
    _later(2.2 + random.random() * 1.2, lambda: post(bot, BOT_REPLIES[(count + len(bot)) % len(BOT_REPLIES)]))


def forget_person(user_id: str):
    """An account deleted: nothing in memory says anything about them any more"""
    _pinned.pop(user_id, None)
    for people in _pinned.values():
        people.pop(user_id, None)
    for invite_id in [i for i, invite in _invites.items() if user_id in (invite["from"], invite["to"])]:
        del _invites[invite_id]
    seen.pop(user_id, None)
    for shown in seen.values():
        shown.pop(user_id, None)


# --- connecting in person: an invitation to do it ---
#
# Someone taps "Connect" on a person they see on the map. The other person gets an
# invitation to accept; the one who invited shows their code and the other scans it. The
# connection itself is still made by the token (routes/social.py): an invitation connects
# nobody.

_invites: dict[str, dict] = {}
_last_invite: dict[tuple, float] = {}


def send_invite(sender: str, target: str) -> dict:
    if target not in store.users or target == sender:
        raise ApiError(404, "not_found", "unknown person")
    if store.blocked_either(sender, target) or not are_near(sender, target):
        raise ApiError(403, "forbidden", "they cannot see you on the map now")
    if store.is_connected(sender, target):
        raise ApiError(409, "already", "already connected")
    key = (sender, target)
    if time.monotonic() - _last_invite.get(key, 0) < INVITE_COOLDOWN_S:
        raise ApiError(429, "rate_limited", "one invitation every 10 s")
    limits.check(sender, "invite")
    _last_invite[key] = time.monotonic()
    invite_id = new_id("ci")
    expires = now_ms() + INVITE_TTL_S * 1000
    _invites[invite_id] = {"from": sender, "to": target, "expires": expires}
    hub.send(target, {"type": "connect.invite", "id": invite_id, "from": summary_of(sender), "expiresAt": iso(expires)})
    # Kept among their notifications too: a request they may have missed
    from . import notifications
    notifications.notify(target, "connect.invite", actor=sender)
    if store.users[target].bot:
        _later(1.5, lambda: _deliver_answer(invite_id, True))
    return {"invite": invite_id}


def _deliver_answer(invite_id: str, accept: bool):
    invite = _invites.pop(invite_id, None)
    if invite:
        hub.send(invite["from"], {"type": "connect.answer", "invite": invite_id, "accept": accept, "by": summary_of(invite["to"])})


def answer_invite(user_id: str, invite_id: str, accept) -> dict:
    invite = _invites.get(invite_id)
    # Blocked meanwhile: as if it had run out, and nothing goes to the other
    if not invite or invite["to"] != user_id or invite["expires"] < now_ms() or store.blocked_either(user_id, invite["from"]):
        raise ApiError(410, "expired", "the invitation is over")
    _deliver_answer(invite_id, accept is True)
    return {}


def sweep_invites():
    now = now_ms()
    for invite_id in [i for i, invite in _invites.items() if invite["expires"] < now]:
        del _invites[invite_id]
    limit = time.monotonic() - INVITE_COOLDOWN_S
    for key in [k for k, at in _last_invite.items() if at < limit]:
        del _last_invite[key]


# --- the socket ---

def _number(value, within: tuple | None = None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value) if not within or within[0] <= value <= within[1] else None


def _handle(client: Client, frame: dict):
    kind = frame.get("type")
    user_id = client.user_id
    if kind == "ping":
        return {"type": "pong"}
    if kind == "presence":
        mode = frame.get("mode")
        if mode not in ("visible", "approximate", "invisible"):
            raise ApiError(400, "bad_request", "unknown mode")
        raw = frame.get("position")
        position = None
        if isinstance(raw, dict) and _number(raw.get("latitude")) is not None and _number(raw.get("longitude")) is not None:
            lat, lon = _number(raw["latitude"]), _number(raw["longitude"])
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ApiError(400, "bad_request", "position out of range")
            # Refused: the user stays where they were, and leaves the map with the 45 s
            if mode != "invisible" and not position_guard.plausible(user_id, lat, lon):
                raise ApiError(409, "position_rejected", "this position is not possible")
            moving = raw.get("moving")
            position = {
                "latitude": lat, "longitude": lon, "accuracy": _number(raw.get("accuracy"), (0, 1_000_000)),
                "heading": _number(raw.get("heading"), HEADING_RANGE), "speed": _number(raw.get("speed"), SPEED_RANGE),
                "moving": moving if isinstance(moving, bool) else None,
            }
        before = presences.get(user_id)
        mode_changed = before is None or before.mode != mode
        entering_map = bool(
            position
            and mode != "invisible"
            and (mode_changed or not client.presence_started)
            and not store.users[user_id].bot
        )
        update_presence(user_id, mode, position)
        if user_id in presences:
            presences[user_id].owner = client
        if entering_map:
            anchor_bots(position["latitude"], position["longitude"])
        # A fresh view after the first update of this connection and every change of mode
        if position and mode != "invisible" and (mode_changed or not client.presence_started):
            _send_view(user_id, snapshot=True)
        return None
    if kind == "gesture":
        send_gesture(user_id, str(frame.get("to") or ""), str(frame.get("gesture") or ""))
        return {}
    if kind == "broadcast":
        return {"recipients": send_broadcast(user_id, frame.get("text"))}
    if kind == "connect.invite":
        return send_invite(user_id, str(frame.get("to") or ""))
    if kind == "connect.answer":
        return answer_invite(user_id, str(frame.get("invite") or ""), frame.get("accept"))
    raise ApiError(400, "bad_request", f"unknown frame {kind!r}")


@router.websocket("/v1/ws")
async def socket(ws: WebSocket):
    await ws.accept()
    try:
        first = orjson.loads(await asyncio.wait_for(ws.receive_text(), timeout=5))
        token = first.get("token") if first.get("type") == "auth" else None
        user = await user_from_token(token, ws.headers)
        claims = await _claims_for(token)
    except (asyncio.TimeoutError, ApiError, orjson.JSONDecodeError, WebSocketDisconnect, AttributeError, KeyError):
        # (KeyError: a binary frame, which has no text: this socket speaks text only)
        await ws.close(4001)
        return
    client = Client(ws, user.id)
    hub.add(client)
    writer = asyncio.create_task(client.writer())
    # The token expires: the app reconnects with a fresh one
    expires_in = float(claims.get("exp", time.time() + 3600)) - time.time()
    expiry = asyncio.get_running_loop().call_later(max(expires_in, 1), lambda: asyncio.ensure_future(ws.close(4001)))
    client.push({"type": "ready", "userId": user.id})
    try:
        while True:
            try:
                text = await ws.receive_text()
            except KeyError:
                text = ""  # a binary frame: answered below like any frame that is not JSON
            if not client.allow():
                # A client flooding the server: closed (a well-behaved app never gets here)
                await ws.close(1008)
                break
            try:
                frame = orjson.loads(text)
                ref = frame.get("ref")
                answer = _handle(client, frame)
                if answer is not None:
                    client.push(answer if answer.get("type") else {"type": "ack", "ref": ref, **answer})
            except ApiError as error:
                client.push({"type": "error", "ref": frame.get("ref") if isinstance(frame, dict) else None, **error.body()})
            except (orjson.JSONDecodeError, AttributeError, TypeError, KeyError):
                client.push({"type": "error", "code": "bad_request", "message": "invalid frame"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        expiry.cancel()
        writer.cancel()
        hub.remove(client)
        # The app went to the background or was closed (its socket ends with it): out of
        # everyone's map at once. TTL_S is only for a connection lost without a word.
        presence = presences.get(user.id)
        if presence and (presence.owner is client or not hub.online(user.id)):
            update_presence(user.id, presence.mode, None)
        if not hub.online(user.id):
            seen.pop(user.id, None)
