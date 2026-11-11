# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Everything the server knows, in memory for the session (volatile by design: this is
the development stand-in of the real backend, API.md). One asyncio loop, so no locks:
handlers never await in the middle of a change."""

import uuid
from dataclasses import dataclass, field

from .util import now_ms

DEFAULT_STYLE = {"backdrop": "ocean", "pedestal": "disc", "effect": "sparkles", "greeting": "wave", "outline": "outline"}
DEFAULT_SETTINGS = {"notifyEventUpdates": True, "notifyConnections": True, "notifyMessages": True}
# What a profile's story shows to others (people.activity): kinds of moments
STORY_KINDS = ("organized", "going", "reviewed", "connected")
DEFAULT_STORY = {kind: True for kind in STORY_KINDS}
# Who sees a profile's story, the events and connections on it, and the person among who
# goes to an event: their connections (the default: nobody follows a stranger around),
# or everyone (Settings › Privacy; Store.sees_story)
STORY_AUDIENCES = ("connections", "everyone")
# Handles that would read as the app speaking: nobody gets them, however they sign in
RESERVED_USERNAMES = {"admin", "administrator", "support", "help", "official", "staff", "moderator", "system", "masterkey", "security", "team"}
# How far away people see an event, without a promotion (metres; promotions.py)
REACH_DEFAULT_M = 800


@dataclass
class User:
    id: str
    username: str
    name: str
    email: str | None = None
    bio: str = ""
    picture_url: str | None = None
    style: dict = field(default_factory=lambda: dict(DEFAULT_STYLE))
    settings: dict = field(default_factory=lambda: dict(DEFAULT_SETTINGS))
    created_at: int = field(default_factory=now_ms)
    avatar: dict | None = None
    avatar_version: int = 0
    bot: bool = False
    push_tokens: dict = field(default_factory=dict)
    # Consents given in the app: kind → [{ version, at, mode? }] (privacy.consents_of)
    consents: dict = field(default_factory=dict)
    # Named from the sign-in (the account may be made by a request without the hint)
    named: bool = False
    # Demo content made for a real user (their connections, chats, own events)
    seeded: bool = False
    events_seeded: bool = False
    # Their story: the kinds shown to others, and moments hidden one by one (entry ids)
    story: dict = field(default_factory=lambda: dict(DEFAULT_STORY))
    story_hidden: set = field(default_factory=set)
    story_audience: str = "connections"

    def __setstate__(self, state):
        # Saved before a field existed (persistence.py): its default
        self.__dict__.update(story=dict(DEFAULT_STORY), story_hidden=set(),
                             story_audience="everyone" if state.get("bot") else "connections")
        self.__dict__.update(state)
        # Saved with an effect since replaced: its heir (snow, lanterns → notes)
        if self.style.get("effect") in ("snow", "lanterns"):
            self.style = {**self.style, "effect": "notes"}


@dataclass
class Event:
    id: str
    creator_id: str
    title: str
    description: str
    categories: list
    latitude: float
    longitude: float
    address: str | None
    start: int
    end: int
    created: int
    modified: int | None = None
    cancelled: int | None = None
    links: str | None = None
    flash: bool = False
    spots_needed: int = 0
    theme: dict | None = None
    image_urls: list = field(default_factory=list)
    # People farther than this do not see it (metres, 100–800; a promotion goes beyond)
    reach: int = REACH_DEFAULT_M

    def __setstate__(self, state):
        # Saved before a field existed (persistence.py): its default
        self.__dict__.update(reach=REACH_DEFAULT_M)
        self.__dict__.update(state)


@dataclass
class Notification:
    """Something important for the user (notifications.py): what happened, about which
    event or person, by whom (several, when alike ones are gathered)"""
    id: str
    kind: str
    at: int
    actors: list = field(default_factory=list)
    count: int = 1
    event_id: str | None = None
    data: dict = field(default_factory=dict)
    read: bool = False


@dataclass
class Promotion:
    """An event shown farther than its reach, paid 24 hours at a time from the organizer's
    wallet: what it buys is time (promotions.py, PROMOTIONS.md)"""
    event_id: str
    radius: int
    # Credits a day, fixed when it started (or changed): a new price list never touches it
    daily: int
    started: int
    # Paid up to here (a moment in time, whatever happens to the event's dates)
    paid_until: int
    # live | paused (the wallet could not pay a day) | stopped (by the organizer) | ended
    status: str = "live"
    charged: int = 0
    # The price a day the time still paid was paid at: a radius made narrower and then wider
    # again costs nothing more, and what comes back at a cancellation is at this price
    paid_rate: int = 0
    # Credits given back (the event cancelled or cut short)
    refunded: int = 0

    def __setstate__(self, state):
        # Saved before a field existed (persistence.py): what it would have been
        self.__dict__.update(paid_until=state.get("started", 0), paid_rate=state.get("daily", 0), refunded=0)
        self.__dict__.update(state)


@dataclass
class WalletEntry:
    id: str
    at: int
    # Credits in (+: a purchase, time not used) or out (−: time of promotion, a refunded purchase)
    amount: int
    # purchase | day | reversal | refund
    kind: str
    event_id: str | None = None
    product_id: str | None = None
    # "<platform>:<transaction id>" of a purchase
    transaction: str | None = None


@dataclass
class Wallet:
    """Promotion credits (1 credit = 1 euro cent): bought in the stores, never expiring"""
    balance: int = 0
    # Sent with each purchase (appAccountToken, obfuscatedAccountId): the stores give it
    # back in the receipt, so a purchase is credited only to the account that made it
    account_token: str = field(default_factory=lambda: str(uuid.uuid4()))
    entries: list = field(default_factory=list)


@dataclass
class Rating:
    id: str
    user_id: str
    rating: float
    comment: str
    date: int
    modified: int | None = None


@dataclass
class Photo:
    id: str
    event_id: str
    url: str
    thumb_url: str
    width: int
    height: int
    author_id: str
    created_at: int


@dataclass
class Album:
    who_can_post: str = "everyone"
    contributors: list = field(default_factory=list)
    photos: list = field(default_factory=list)  # newest first


@dataclass
class Chat:
    id: str
    kind: str  # direct | group (event chats are made from their events)
    title: str = ""
    color: str | None = None
    owner_id: str | None = None
    # The group's picture, chosen by its owner or an admin
    picture_url: str | None = None
    # A direct chat: who opened it. Without a word in it, it shows only for them: opening chats
    # with everyone around must not fill the lists of people who never heard from them
    opened_by: str | None = None
    members: dict = field(default_factory=dict)  # user id → joined at
    created_at: int = field(default_factory=now_ms)


@dataclass
class Message:
    id: str
    chat_id: str
    sender: str
    text: str
    at: int
    client_id: str | None = None
    system: bool = False
    # Taken back by its author or removed by who runs the chat: its text is gone, its place stays
    deleted: bool = False


@dataclass
class Upload:
    id: str
    user_id: str
    purpose: str
    mime_type: str
    file_size: int
    event_id: str | None
    expires_at: int
    path: str | None = None
    used: bool = False
    chat_id: str | None = None


@dataclass
class Moderation:
    """How a group or an event chat is run, beside its members (API.md, Moderation)."""
    admins: set = field(default_factory=set)
    muted: dict = field(default_factory=dict)  # user id → muted until (ms), None: until unmuted
    read_only: bool = False  # only the owner and the admins write
    pins: list = field(default_factory=list)  # message ids, the newest pin first
    banned: set = field(default_factory=set)  # event chats: removed from the event, cannot join again


@dataclass
class Poll:
    """A poll message (its Message carries the question as its text)."""
    message_id: str
    chat_id: str
    creator: str
    question: str
    options: list  # [{"id": "o1", "text": "…"}]
    multiple: bool = False
    votes: dict = field(default_factory=dict)  # user id → [option ids]
    closed: bool = False


class Store:
    def __init__(self):
        self.users: dict[str, User] = {}
        self.by_username: dict[str, str] = {}
        # user → other → { since, place }; both directions are stored
        self.connections: dict[str, dict[str, dict]] = {}
        # Pairs who disconnected: no direct messages, even nearby, until they connect again
        self.disconnected: set[frozenset] = set()
        # blocker → blocked → since
        self.blocks: dict[str, dict[str, int]] = {}
        self.events: dict[str, Event] = {}
        # event → user → since (insertion order: who saved it first)
        self.followers: dict[str, dict[str, int]] = {}
        self.ratings: dict[str, dict[str, Rating]] = {}
        self.albums: dict[str, Album] = {}
        self.chats: dict[str, Chat] = {}
        self.direct: dict[frozenset, str] = {}
        # chat → messages, oldest first (event chats are keyed "event:<id>")
        self.messages: dict[str, list[Message]] = {}
        # (chat, user) → time read up to
        self.read_at: dict[tuple, int] = {}
        # (chat, user, clientId) → message (a retried send answers the same message)
        self.sent: dict[tuple, Message] = {}
        self.reports: list[dict] = []
        self.uploads: dict[str, Upload] = {}
        # Areas (~5 km cells) whose demo events exist
        self.seeded_areas: set[tuple] = set()
        # The demo events of each area by their key in seed.EVENTS: (area, key) → event id
        self.demo_events: dict[tuple, str] = {}
        # Groups and event chats: chat id → Moderation; poll message id → Poll
        self.moderation: dict[str, Moderation] = {}
        self.polls: dict[str, Poll] = {}
        # Events the user saved (a private bookmark: user → event → since), and the ones
        # they removed from their Saved list once over (user → events)
        self.saved: dict[str, dict[str, int]] = {}
        self.saved_hidden: dict[str, set[str]] = {}
        # Notifications (user → newest last), notifications.py
        self.notifications: dict[str, list[Notification]] = {}
        # Events whose "starting soon" was sent
        self.reminded: set[str] = set()
        # Promotions (event → Promotion) and wallets (user → Wallet)
        self.promotions: dict[str, Promotion] = {}
        self.wallets: dict[str, Wallet] = {}
        # Store purchases already credited, "<platform>:<transaction id>" → user (kept
        # after the account is deleted: a receipt is never credited twice)
        self.store_transactions: dict[str, str | None] = {}

    # --- people ---

    def user(self, user_id: str) -> User | None:
        return self.users.get(user_id)

    def add_user(self, user: User) -> User:
        self.users[user.id] = user
        self.by_username[user.username] = user.id
        return user

    def rename(self, user: User, username: str):
        self.by_username.pop(user.username, None)
        user.username = username
        self.by_username[username] = user.id

    def free_username(self, wanted: str) -> str:
        base = wanted or "user"
        candidate, n = base, 1
        while candidate in self.by_username or candidate in RESERVED_USERNAMES:
            n += 1
            candidate = f"{base[:27]}{n}"
        return candidate

    def is_connected(self, a: str, b: str) -> bool:
        return b in self.connections.get(a, {})

    def connect(self, a: str, b: str, place: str | None, since: int | None = None):
        since = since or now_ms()
        self.connections.setdefault(a, {})[b] = {"since": since, "place": place}
        self.connections.setdefault(b, {})[a] = {"since": since, "place": place}
        self.disconnected.discard(frozenset((a, b)))

    def disconnect(self, a: str, b: str):
        self.connections.get(a, {}).pop(b, None)
        self.connections.get(b, {}).pop(a, None)
        self.disconnected.add(frozenset((a, b)))

    def blocked_either(self, a: str, b: str) -> bool:
        return b in self.blocks.get(a, {}) or a in self.blocks.get(b, {})

    def sees_story(self, viewer: str, owner: str) -> bool:
        """Whether the viewer may know what the owner does: their story, their lists, that
        they go to an event. The one rule for every answer that says so."""
        if viewer == owner or self.is_connected(viewer, owner):
            return True
        user = self.users.get(owner)
        return bool(user and user.story_audience == "everyone")

    # --- events ---

    def follower_ids(self, event_id: str) -> dict:
        return self.followers.setdefault(event_id, {})

    def wallet(self, user_id: str) -> Wallet:
        if user_id not in self.wallets:
            self.wallets[user_id] = Wallet()
        return self.wallets[user_id]

    def album(self, event_id: str) -> Album:
        if event_id not in self.albums:
            self.albums[event_id] = Album()
        return self.albums[event_id]


store = Store()
