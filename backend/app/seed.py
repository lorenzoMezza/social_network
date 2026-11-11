# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The demo world of the development server, behind the real API: enough people, events,
chats and notifications to try every screen and rule of the app (what is where: the
checklist at the end of this docstring). Demo people are bot users: they walk on the
map, answer messages, waves and words to everyone, and accept invitations to connect
(realtime.py). Each real user gets their connections, chats, blocked person, credits
when their account is made (seed_new_user); the events appear around the first place
they look at (seed_area), with the user's part in them (going, saved, went, reviewed,
their own) and their notifications, the first time they look.

`python -m app.reset` (make reset-data) empties everything but the real accounts and
seeds again.

What to try where (the user's side):
  Map        people walking around (visible, approximate, not connected), beacons of
             events within 1 km, a flash event starting now, waves and broadcasts
  Nearby     2 sponsored on top (a 3rd sponsored further down), live and flash events,
             a short-reach event (400 m), events with connections going
  Saved      joined upcoming (Going), bookmarks only, one joined that is live now, a
             cancelled one, past ones (went, reviewed, a bookmark): × and Clear
  Yours      an upcoming one with people (connections among them), a past one rated
  Event      Join / Going / Save, Who's in with connections first, chat, album (open,
             organizer only), rating (one to rate, one rated), changed time
  Social     direct chats (one unread, one with someone only nearby), two groups (the
             user's own with an admin; another with a poll and a pinned message)
  Profile    story of every kind, the bell with unread notifications, connections in
             common on others' profiles, a blocked person in Settings, credits to promote
"""

import math

from . import config, promotions
from .store import (
    Chat, Event, Message, Moderation, Notification, Photo, Poll, Promotion, Rating, User, Wallet, WalletEntry, store,
)
from .util import DAY, HOUR, distance_m, new_id, now_ms, offset, offset_bearing, unit_hash

MINUTE = 60 * 1000

# username → name, profile style [backdrop, pedestal, effect, greeting, outline], preset
PEOPLE = {
    "sara_m": ("Sara Moretti", ["candy", "ring", "hearts", "wave", True], "default3"),
    "tommi": ("Tommaso", ["forest", "disc", "fireflies", "fistpump", True], "default2"),
    "chiara.v": ("Chiara V.", ["sunset", "ring", "petals", "wave", True], "default8"),
    "davide88": ("Davide", ["night", "disc", "sparkles", "handsair", True], "default84"),
    "irene": ("Irene", ["studio", "none", "bubbles", "shrug", False], "default12"),
    "fede": ("Federico", ["ember", "disc", "confetti", "fistpump", True], "default86"),
    "marta": ("Marta", ["lemon", "ring", "petals", "wave", True], "default16"),
    "nico_l": ("Nico", ["ocean", "disc", "bubbles", "dab", True], "default88"),
    "elena": ("Elena", ["forest", "ring", "fireflies", "dontsee", True], "default20"),
    "gio": ("Gio", ["night", "ring", "sparkles", "dab", True], "default90"),
    "ale.b": ("Alessandro B.", ["studio", "disc", "sparkles", "wave", True], "default30"),
    "paolo.s": ("Paolo S.", ["ocean", "ring", "bubbles", "shrug", True], "default32"),
    "bluenote_tv": ("Blue Note TV", ["night", "ring", "sparkles", "wave", False], "default6"),
    "disco_rotto": ("Disco Rotto", ["ember", "disc", "confetti", "dab", True], "default10"),
    "eatrome": ("Eat Rome", ["sunset", "disc", "hearts", "handsair", True], "default14"),
    "f8andbethere": ("f/8 and be there", ["studio", "disc", "confetti", "fistpump", True], "default82"),
    "giulia.r": ("Giulia Romano", ["candy", "ring", "petals", "wave", True], "default24"),
    "lucaplays": ("Luca", ["ocean", "disc", "sparkles", "dab", True], "default92"),
    "marco_10": ("Marco", ["lemon", "disc", "confetti", "fistpump", True], "default94"),
    "pixel_pete": ("Pixel Pete", ["night", "disc", "fireflies", "shrug", True], "default96"),
    "rn_roma": ("React Native Roma", ["studio", "ring", "bubbles", "handsair", True], "default85"),
    "serena.yoga": ("Serena", ["forest", "none", "petals", "wave", False], "default27"),
    "via_dei_volsci": ("Via dei Volsci", ["ember", "ring", "fireflies", "dontsee", True], "default18"),
    # Blocked by every new user: Settings › Blocked people has someone to unblock
    "anon.42": ("Anonymous 42", ["studio", "none", "none", "shrug", False], None),
}

BIOS = {
    "sara_m": "Sunsets, spritz and long walks 🌅",
    "tommi": "Five-a-side on Tuesdays, board games on Fridays.",
    "chiara.v": "Running club every Thursday. Come along!",
    "davide88": "Early mornings, long runs.",
    "irene": "Brunch enthusiast. I book the table.",
    "nico_l": "New in the neighbourhood, say hi 👋",
    "giulia.r": "I organize things. Mostly aperitivi.",
    "marco_10": "Football every Tuesday. Bring a dark shirt.",
    "lucaplays": "Catan champion of via dei Volsci (self-proclaimed).",
    "disco_rotto": "Records, swaps and good music.",
    "eatrome": "The street food of the whole city, in one place.",
    "rn_roma": "The React Native community in Rome.",
    "serena.yoga": "Yoga teacher. Breathe in, breathe out.",
    "via_dei_volsci": "Our street's committee: parties, markets, cleanups.",
}


def bot_id(username: str) -> str:
    return f"user-{username}"


def preset_of(username: str) -> str | None:
    return PEOPLE.get(username, (None, None, None))[2]


def _make_bots():
    for username, (name, style, preset) in PEOPLE.items():
        backdrop, pedestal, effect, greeting, outline = style
        store.add_user(User(
            id=bot_id(username),
            username=username,
            name=name,
            bio=BIOS.get(username, ""),
            picture_url=f"asset:items/presets/{preset}.png" if preset else None,
            style={"backdrop": backdrop, "pedestal": pedestal, "effect": effect, "greeting": greeting, "outline": "outline" if outline else "none"},
            created_at=now_ms() - 90 * DAY,
            bot=True,
            # Their stories and events can be tried without connecting first
            story_audience="everyone",
            seeded=True,
            events_seeded=True,
        ))


if config.DEV_TOOLS:
    _make_bots()

# Friends among the demo people: their profiles list connections, some in common with
# the user (CONNECTIONS)
BOT_FRIENDS = [
    ("sara_m", ["tommi", "chiara.v", "irene", "nico_l", "giulia.r", "ale.b"]),
    ("tommi", ["davide88", "fede", "marco_10", "lucaplays"]),
    ("chiara.v", ["davide88", "marta", "serena.yoga", "elena"]),
    ("disco_rotto", ["sara_m", "irene", "marta", "bluenote_tv", "paolo.s", "gio"]),
    ("giulia.r", ["ale.b", "tommi", "fede", "elena"]),
    ("marco_10", ["davide88", "pixel_pete", "lucaplays"]),
    ("irene", ["marta", "elena", "paolo.s"]),
    ("via_dei_volsci", ["tommi", "chiara.v", "irene", "gio"]),
]


def connect_bots():
    since = now_ms() - 60 * DAY
    for name, friends in BOT_FRIENDS:
        for friend in friends:
            if bot_id(name) in store.users and bot_id(friend) in store.users and not store.is_connected(bot_id(name), bot_id(friend)):
                store.connect(bot_id(name), bot_id(friend), None, since=since)


connect_bots()


# --- a new real user: connections, chats, a blocked person, credits ---

# [username, connected days ago, where]. Not connected, on the map: nico_l, ale.b
CONNECTIONS = [
    ("sara_m", 0.2, "Sunset aperitivo on the terrace"),
    ("tommi", 1.5, "Neighbourhood birthday party"),
    ("chiara.v", 3, "Thursday running club"),
    ("davide88", 6, "Thursday running club"),
    ("irene", 12, None),
    ("fede", 20, "Tech meetup: React Native"),
    ("marta", 34, None),
]

# [with, [(from ('me' or a username), minutes ago, text)], unread]
DIRECT = [
    ("sara_m", [("sara_m", 190, "That terrace was amazing 🌅"), ("me", 182, "Right? Same place next week?"),
                ("sara_m", 14, "Yes! I will bring Tommi too"), ("sara_m", 12, "Are you going to the vinyl market?")], True),
    ("chiara.v", [("chiara.v", 60 * 26, "Running club Thursday?"), ("me", 60 * 25, "Always 🏃"),
                  ("chiara.v", 60 * 24, "Thanks for the photos of last week!")], False),
    # Not a connection: written while near (the chat stays, writing needs them near)
    ("nico_l", [("nico_l", 45, "Hey, I saw you on the map, are you at the park?")], True),
]

# [title, colour, owner, members, admins, messages, poll, pinned (index of a message)]
GROUPS = [
    ("Morning runners", "#1F9D63", "me", ["chiara.v", "davide88", "fede"], ["chiara.v"], [
        ("davide88", 60 * 9, "Tomorrow 7:00 at the fountain?"), ("chiara.v", 60 * 8.5, "I am in"),
        ("fede", 45, "Rain forecast, maybe 8:00?"),
    ], ("chiara.v", 30, "Saturday long run: how far?", ["10 km", "15 km", "Half marathon"], {"chiara.v": [1], "davide88": [1], "fede": [0]}), 0),
    ("Sunday brunch", "#E08A00", "irene", ["me", "sara_m", "marta", "tommi"], [], [
        ("irene", 60 * 50, "New place on via dei Volsci, booking for 5"), ("marta", 60 * 49, "Perfect"),
        ("sara_m", 60 * 3, "Can we move it to 11:30?"),
    ], ("irene", 60 * 2, "Which Sunday works?", ["This Sunday", "Next Sunday"], {"irene": [0], "marta": [0], "sara_m": [1]}), 0),
]

BLOCKED = ["anon.42"]
# Promotion credits to start with (1 credit = €0.01): enough to promote at 1 km, not
# farther (the sheet then offers a top-up)
CREDITS = 199


def _message(chat_id: str, sender: str, at: int, text: str, system=False) -> Message:
    message = Message(id=new_id("msg"), chat_id=chat_id, sender=sender, text=text, at=at, system=system)
    store.messages.setdefault(chat_id, []).append(message)
    return message


def _poll(chat_id, creator, at, question, options, votes) -> Message:
    message = _message(chat_id, creator, at, question)
    store.polls[message.id] = Poll(
        message_id=message.id, chat_id=chat_id, creator=creator, question=question,
        options=[{"id": f"o{n + 1}", "text": text} for n, text in enumerate(options)],
        votes={voter: [f"o{n + 1}" for n in choices] for voter, choices in votes.items()},
    )
    return message


def seed_new_user(user: User):
    if user.seeded or not config.DEV_TOOLS:
        return
    user.seeded = True
    now = now_ms()
    who = lambda name: user.id if name == "me" else bot_id(name)  # noqa: E731
    for username, days, place in CONNECTIONS:
        store.connect(user.id, bot_id(username), place, since=int(now - days * DAY))
    for username, lines, unread in DIRECT:
        chat = Chat(id=new_id("chat"), kind="direct", members={user.id: now - 30 * DAY, bot_id(username): now - 30 * DAY})
        store.chats[chat.id] = chat
        store.direct[frozenset((user.id, bot_id(username)))] = chat.id
        for sender, minutes, text in lines:
            _message(chat.id, who(sender), int(now - minutes * MINUTE), text)
        store.read_at[(chat.id, user.id)] = (store.messages[chat.id][-1].at - MINUTE * 3) if unread else now
    for title, color, owner, members, admins, lines, poll, pinned in GROUPS:
        member_ids = [who(owner)] + [who(m) for m in members]
        chat = Chat(id=new_id("chat"), kind="group", title=title, color=color, owner_id=who(owner),
                    members={m: now - 60 * DAY for m in member_ids}, created_at=now - 60 * DAY)
        store.chats[chat.id] = chat
        _message(chat.id, who(owner), int(now - 60 * DAY), f"Created “{title}”", system=True)
        written = [_message(chat.id, who(sender), int(now - minutes * MINUTE), text) for sender, minutes, text in lines]
        creator, minutes, question, options, votes = poll
        _poll(chat.id, who(creator), int(now - minutes * MINUTE), question, options, {who(v): c for v, c in votes.items()})
        store.moderation[chat.id] = Moderation(admins={who(a) for a in admins}, pins=[written[pinned].id])
        # The newest messages of others are unread
        store.read_at[(chat.id, user.id)] = now - 3 * HOUR
    for username in BLOCKED:
        store.blocks.setdefault(user.id, {})[bot_id(username)] = now - 5 * DAY
    wallet = store.wallets.setdefault(user.id, Wallet())
    wallet.balance = CREDITS
    wallet.entries.append(WalletEntry(id=new_id("we"), at=now - 2 * DAY, amount=CREDITS, kind="purchase",
                                      product_id="promo.credits.199", transaction=f"dev:seed-{user.id}"))


# --- events around a place ---

# key → (title, description, categories, metres east, metres north, starts in (h),
#        lasts (h), creator, extra). Within 800 m (the free reach) unless promoted.
#   extra: crowd (how many of CROWD go), flash/spots, promoted (radius), reach,
#          photos (count, authors), organizerOnly, cancelled, ratings (how many),
#          changed (its time changed lately)
EVENTS = {
    "aperitivo": ("Sunset aperitivo on the terrace", "Spritz, music and a view over the rooftops. Come alone or with friends, everyone is welcome. We will save a spot for latecomers.",
                  ["drinks", "social"], 320, -180, -1, 3, "giulia.r", {"photos": (5, ["giulia.r", "sara_m", "ale.b"]), "crowd": 9}),
    "football": ("Pickup football at the park", "Five-a-side, all levels. Bring water and a dark and a light shirt. We play until it gets dark.",
                 ["sports", "competitive"], -450, 380, 2, 2, "marco_10", {"crowd": 8}),
    "boardgames": ("Board games night", "Catan, Codenames, Dixit and many more. Beginners welcome, we explain the rules. Snacks are on us.",
                   ["games", "social"], 900, 260, 5, 4, "lucaplays", {"promoted": 1500, "crowd": 6}),
    "vinyl": ("Vinyl market", "Second-hand records from local collectors: jazz, soul, Italian 70s. Bring your crates to swap.",
              ["music", "shopping"], -1300, -700, 22, 6, "disco_rotto", {"promoted": 3000, "crowd": 10, "changed": True}),
    "streetfood": ("Street food festival", "Twenty stands from every region, live band from 21:00. Free entry, pay at the stands.",
                   ["food", "festival", "free entry"], 1700, -1200, 26, 9, "eatrome", {"promoted": 5000, "crowd": 12}),
    "yoga": ("Yoga in the garden", "An hour of gentle flow under the trees. Bring a mat; a few spares are available.",
             ["relaxing", "sports"], -300, -550, 40, 1.5, "serena.yoga", {"reach": 400, "crowd": 4}),
    "photowalk": ("Photography walk", "We walk through the old town at golden hour and share tips on composition. Any camera works, phones too.",
                  ["exposition", "social"], 500, 450, 48, 2.5, "f8andbethere", {"crowd": 5}),
    "arcade": ("Retro arcade tournament", "Street Fighter II and Tekken 3, single elimination. Prizes for the top three.",
               ["games", "competitive", "technology"], -600, -200, 72, 5, "pixel_pete", {"crowd": 7}),
    "swap": ("Clothes swap", "Bring up to five items in good condition and leave with new ones. Leftovers go to charity.",
             ["clothes", "free entry"], 150, -700, 96, 3, "giulia.r", {"crowd": 3}),
    "jazz": ("Open mic jazz session", "House trio from 21:00, then the stage is yours. Sign up at the bar.",
             ["music", "drinks"], -700, 300, 120, 4, "bluenote_tv", {"crowd": 3}),
    "fivea": ("Quick five-a-side, 2 missing", "We have a ball and 8 players. Come as you are.",
              ["sports"], 260, 140, 0.6, 1.5, "marco_10", {"flash": True, "spots": 2, "crowd": 6}),
    "frisbee": ("Frisbee on the lawn", "Anyone welcome, just show up.",
                ["sports", "relaxing"], -380, -120, -0.3, 1, "serena.yoga", {"flash": True, "spots": 0, "crowd": 4}),
    "xmas": ("Christmas market preview", "A first look at the stands, with mulled wine and chestnuts.",
             ["festivities", "shopping", "food"], -800, -300, 60, 5, "eatrome", {"cancelled": True, "crowd": 5}),
    "birthday": ("Neighbourhood birthday party", "Our street turns 100! Cake, games for kids and a DJ set at night.",
                 ["party", "festivities"], 150, 600, -30, 6, "via_dei_volsci",
                 {"photos": (14, ["via_dei_volsci", "tommi", "chiara.v", "me", "davide88", "irene"]), "crowd": 11, "ratings": 4}),
    "meetup": ("Tech meetup: React Native", "Talks on Expo, maps and 3D in apps, then pizza. Laptops optional.",
               ["technology", "convention"], 2400, -400, -50, 3, "rn_roma", {"photos": (6, ["rn_roma"]), "organizerOnly": True, "crowd": 8, "ratings": 3}),
    "farmers": ("Farmers' market", "Local producers, cheese, bread and the first oranges. Bring a bag.",
                ["food", "shopping"], -200, 700, -50, 4, "eatrome", {"crowd": 6, "ratings": 2}),
}

# The user's part in them: going (joined; once over: went), saved (a bookmark only),
# reviewed (went and rated). Going and also saved: SAVED_TOO
USER_PART = {
    "aperitivo": "going", "vinyl": "going", "fivea": "going", "xmas": "going", "meetup": "going",
    "football": "saved", "yoga": "saved", "farmers": "saved",
    "birthday": "reviewed",
}
SAVED_TOO = {"vinyl"}

# The user's own events: key, title, description, categories, east, north, starts in
# (h), lasts (h), who is going
OWN_EVENTS = [
    ("picnic", "Picnic by the lake", "Bring something to share, I bring a blanket, a speaker and frisbees.",
     ["relaxing", "social", "food"], 600, -300, 30, 4, ["sara_m", "chiara.v", "nico_l", "elena", "gio"]),
    ("running", "Thursday running club", "Easy 6 km around the park, then coffee. All paces.",
     ["sports", "social"], -300, 300, -70, 1.5, ["chiara.v", "davide88", "fede"]),
]

COMMENTS = [(9, "Great atmosphere, I will be back!"), (8, "Well organized and friendly people."), (10, "Best evening of the month."),
            (6, "Nice, but too crowded after 22:00."), (7, "")]
CROWD = ["ale.b", "sara_m", "tommi", "chiara.v", "davide88", "irene", "fede", "nico_l", "marta", "paolo.s", "elena", "gio"]
EVENT_LINES = {
    "sports": ["Who has a ball?", "I can bring the bibs", "Is it still on if it rains?", "On my way 🏃", "Two more needed!"],
    "music": ["Who is playing first?", "I am bringing my crate", "Great vibe tonight", "Saving a table at the front", "See you there 👋"],
    "food": ["What time are the stands open?", "Any vegan options?", "I will be by the entrance", "So good 😋", "Thanks everyone!"],
    "default": ["Who is coming early to help set up?", "I can be there 30 min before", "Running late, start without me",
                "Where exactly are you?", "See you there 👋"],
}

AREA_SIZE_M = 5000


def area_of(lat: float, lon: float) -> tuple:
    return (math.floor(lat * 111_320 / AREA_SIZE_M), math.floor(lon * 111_320 * math.cos(math.radians(lat)) / AREA_SIZE_M))


def _quarter(ms: int) -> int:
    return round(ms / (15 * MINUTE)) * 15 * MINUTE


# As routes/events.py MIN_SPACING_M, which imports this module
ROOM_M = 15


def _event(creator_id, title, description, categories, lat, lon, starts_in_h, lasts_h, index, now, address=None) -> Event:
    start = _quarter(int(now + starts_in_h * HOUR))
    event = Event(
        id=new_id("ev"), creator_id=creator_id, title=title, description=description, categories=categories,
        latitude=lat, longitude=lon, address=address, start=start, end=int(start + lasts_h * HOUR),
        created=int(now - (5 + index) * DAY), links="https://example.com/event" if index % 3 == 0 else None,
    )
    store.events[event.id] = event
    return event


def _photos(event: Event, count: int, authors: list, user_id: str, now: int):
    album = store.album(event.id)
    for n in range(count):
        portrait = n % 3 == 1
        width, height = (1200, 1600) if portrait else (1600, 1200)
        author = authors[n % len(authors)]
        key = f"{event.id}-{n}"
        album.photos.append(Photo(
            id=new_id("ph"), event_id=event.id,
            url=f"https://picsum.photos/seed/{key}/{width}/{height}",
            thumb_url=f"https://picsum.photos/seed/{key}/400/400",
            width=width, height=height,
            author_id=user_id if author == "me" else bot_id(author),
            created_at=int(now - (n + 1) * 0.7 * HOUR),
        ))


def _notify(user_id: str, kind: str, minutes_ago: float, *, actors=(), count=None, event=None, data=None, read=False):
    store.notifications.setdefault(user_id, []).append(Notification(
        id=new_id("nt"), kind=kind, at=int(now_ms() - minutes_ago * MINUTE), actors=[bot_id(a) for a in actors],
        count=count or max(1, len(actors)), event_id=event.id if event else None, data=dict(data or {}), read=read))


def seed_area(lat: float, lon: float, user: User):
    """The demo events around a place, the first time anyone asks about its area; the
    user's part in them, their own events and their notifications, the first time they ask."""
    if not config.DEV_TOOLS:
        return
    now = now_ms()
    cell = area_of(lat, lon)
    if cell not in store.seeded_areas:
        store.seeded_areas.add(cell)
        for index, (key, (title, description, categories, east, north, starts, lasts, creator, extra)) in enumerate(EVENTS.items()):
            elat, elon = offset(lat, lon, east, north)
            event = _event(bot_id(creator), title, description, categories, elat, elon, starts, lasts, index, now)
            store.demo_events[(cell, key)] = event.id
            event.flash = bool(extra.get("flash"))
            event.spots_needed = extra.get("spots", 0)
            event.reach = extra.get("reach", event.reach)
            if extra.get("cancelled"):
                event.cancelled = now - 20 * HOUR
            if extra.get("changed"):
                event.modified = now - 2 * HOUR
            if extra.get("promoted"):
                # Sponsored by its (demo) organizer for all its days: the list shows the
                # two nearest first (PROMOTIONS.md)
                radius = extra["promoted"]
                store.promotions[event.id] = Promotion(
                    event_id=event.id, radius=radius, daily=promotions.daily_price(radius, promotions.promoted_days(event, now)),
                    started=now, paid_until=event.end, paid_rate=promotions.daily_price(radius, promotions.promoted_days(event, now)))
            followers = store.follower_ids(event.id)
            crowd = [name for name in CROWD[index % len(CROWD):] + CROWD[:index % len(CROWD)] if name != creator][: extra.get("crowd", 4)]
            for n, name in enumerate(crowd):
                followers[bot_id(name)] = now - (n + 2) * HOUR
            if extra.get("ratings"):
                ratings = store.ratings.setdefault(event.id, {})
                for n, (value, comment) in enumerate(COMMENTS[: extra["ratings"]]):
                    rater = bot_id(crowd[n % len(crowd)])
                    ratings[rater] = Rating(id=new_id("rt"), user_id=rater, rating=value, comment=comment, date=now - (n + 1) * HOUR)
            if "photos" in extra:
                count, authors = extra["photos"]
                if extra.get("organizerOnly"):
                    store.album(event.id).who_can_post = "organizer"
                _photos(event, count, authors, user.id, now)
    if user.events_seeded or user.bot:
        return
    user.events_seeded = True

    def demo(key):
        return store.events.get(store.demo_events.get((cell, key)))

    for key, part in USER_PART.items():
        event = demo(key)
        if event is None:
            continue
        if part in ("going", "reviewed"):
            store.follower_ids(event.id)[user.id] = now - 3 * DAY
        if part == "saved" or key in SAVED_TOO:
            store.saved.setdefault(user.id, {})[event.id] = now - 2 * DAY
        if part == "reviewed":
            store.ratings.setdefault(event.id, {})[user.id] = Rating(
                id=new_id("rt"), user_id=user.id, rating=9, comment="Best street party in years 🎉", date=now - 20 * HOUR)
    own = {}
    # Each account's own a little apart (30–150 m): never on top of another's
    shift = 30 + unit_hash(user.id) * 120
    for index, (key, title, description, categories, east, north, starts, lasts, people) in enumerate(OWN_EVENTS):
        around = offset(lat, lon, east, north)
        away, bearing = shift, unit_hash(f"{user.id}{key}") * 360
        elat, elon = offset_bearing(*around, away, bearing)
        # Another account's may be right there: two events are never on top of each other
        while any(not other.cancelled and other.end > now and distance_m(elat, elon, other.latitude, other.longitude) < ROOM_M
                  for other in store.events.values()):
            away, bearing = away + 5, bearing + 37
            elat, elon = offset_bearing(*around, away, bearing)
        event = _event(user.id, title, description, categories, elat, elon, starts, lasts, index + 20, now)
        own[key] = event
        for n, name in enumerate(people):
            store.follower_ids(event.id)[bot_id(name)] = now - (n + 1) * HOUR
    running = own["running"]
    ratings = store.ratings.setdefault(running.id, {})
    for n, name in enumerate(["chiara.v", "davide88"]):
        value, comment = COMMENTS[n]
        ratings[bot_id(name)] = Rating(id=new_id("rt"), user_id=bot_id(name), rating=value, comment=comment, date=now - (n + 2) * DAY)
    _photos(running, 4, ["chiara.v", "me", "davide88"], user.id, now - 2 * DAY)
    # What the bell shows: the newest unread, the older ones read (app/notifications.py)
    if demo("fivea"):
        _notify(user.id, "event.starting", 5, event=demo("fivea"))
    _notify(user.id, "event.joined", 25, actors=["nico_l", "elena", "gio"], event=own["picnic"])
    _notify(user.id, "connect.invite", 40, actors=["nico_l"])
    if demo("vinyl"):
        _notify(user.id, "event.changed", 120, event=demo("vinyl"), actors=["disco_rotto"], data={"changes": ["time"]})
    if demo("birthday"):
        _notify(user.id, "album.photos", 60 * 20, actors=["tommi", "chiara.v"], count=5, event=demo("birthday"), read=True)
    if demo("xmas"):
        _notify(user.id, "event.cancelled", 60 * 20, actors=["eatrome"], event=demo("xmas"), read=True)
    _notify(user.id, "event.rated", 60 * 48, actors=["davide88", "chiara.v"], event=running, read=True)
    store.notifications[user.id].sort(key=lambda n: n.at)


def seed_event_chat(event: Event):
    """The first messages of an event's chat, from its people, the first time it is read."""
    chat_id = f"event:{event.id}"
    if chat_id in store.messages:
        return
    store.messages[chat_id] = []
    bots = [uid for uid in store.followers.get(event.id, {}) if store.users.get(uid) and store.users[uid].bot]
    organizer_bot = bool(store.users.get(event.creator_id) and store.users[event.creator_id].bot)
    members = ([event.creator_id] if organizer_bot else []) + bots
    if not members:
        return
    lines = next((EVENT_LINES[c] for c in event.categories if c in EVENT_LINES), EVENT_LINES["default"])
    count = 2 + ord(event.id[-1]) % 4
    newest = 8 + (ord(event.id[-1]) % 6) * 11
    now = now_ms()
    for n in range(count):
        first = n == 0 and organizer_bot
        sender = event.creator_id if first else members[(n * 3 + 1) % len(members)]
        text = f"Welcome to the chat of “{event.title}”!" if first else lines[n % len(lines)]
        _message(chat_id, sender, int(now - (newest + (count - 1 - n) * 41) * MINUTE), text)
