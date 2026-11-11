# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The JSON shapes of API.md, built from the store. Every person is a UserSummary."""

from . import config, promotions
from .store import Chat, Event, Message, Photo, Rating, User, store
from .util import iso, now_ms


class Urls:
    """Public addresses: the configured ones, else the host the app reached (development:
    the computer's LAN address, so pictures load on the phone)."""

    api = config.PUBLIC_URL.rstrip("/") if config.PUBLIC_URL else None
    assets = config.ASSETS_URL.rstrip("/") if config.ASSETS_URL else None

    @classmethod
    def learn(cls, scheme: str, host: str):
        if not host:
            return
        if not config.PUBLIC_URL:
            cls.api = f"{scheme}://{host}"
        if not config.ASSETS_URL:
            hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
            cls.assets = f"http://{hostname}:{config.ASSETS_PORT}/v1/files"

    @classmethod
    def media(cls, key: str) -> str:
        return f"{cls.api or ''}/v1/media/{key}"

    @classmethod
    def asset(cls, path: str) -> str | None:
        return f"{cls.assets}/{path}" if cls.assets else None

    @classmethod
    def public(cls, value: str | None) -> str | None:
        """Stored references made public: `media:<key>` (uploads), `asset:<path>` (avatar
        assets); full URLs (seeded stock photos) as they are."""
        if not value:
            return value
        if value.startswith("media:"):
            return cls.media(value[6:])
        if value.startswith("asset:"):
            return cls.asset(value[6:])
        return value


def user_summary(user: User | None) -> dict | None:
    if user is None:
        return None
    picture = Urls.public(user.picture_url)
    return {
        "id": user.id,
        "username": user.username,
        "name": user.name,
        "pictureUrl": picture,
        "avatarVersion": user.avatar_version,
        # The backdrop of their profile: its colour marks them on the map
        "backdrop": (user.style or {}).get("backdrop"),
    }


def summary_of(user_id: str) -> dict | None:
    return user_summary(store.user(user_id))


# --- events ---

def event_status(event: Event, now: int | None = None) -> str:
    now = now or now_ms()
    if event.cancelled:
        return "cancelled"
    if now >= event.end:
        return "concluded"
    if now >= event.start:
        return "ongoing"
    return "upcoming"


FRIENDS_SHOWN = 3


def going_friends(event: Event, viewer_id: str) -> list[str]:
    """The viewer's connections who join the event, first joined first"""
    mine = store.connections.get(viewer_id, {})
    return [uid for uid in store.followers.get(event.id, {}) if uid in mine and not store.blocked_either(viewer_id, uid)]


def event_summary(event: Event, viewer_id: str) -> dict:
    followers = store.followers.get(event.id, {})
    friends = going_friends(event, viewer_id)
    dates = {"creationDate": iso(event.created), "startDate": iso(event.start), "endDate": iso(event.end)}
    if event.modified:
        dates["modifiedDate"] = iso(event.modified)
    if event.cancelled:
        dates["cancelDate"] = iso(event.cancelled)
    album = store.albums.get(event.id)
    return {
        "id": event.id,
        "title": event.title,
        "description": event.description,
        "categories": event.categories,
        "location": {"latitude": event.latitude, "longitude": event.longitude, "address": event.address},
        "dates": dates,
        "status": event_status(event),
        "flash": event.flash,
        "spotsNeeded": event.spots_needed,
        "theme": event.theme,
        "imageUrls": [Urls.public(url) for url in event.image_urls],
        "links": event.links,
        "creator": summary_of(event.creator_id),
        "followerCount": len(followers),
        "photoCount": len(album.photos) if album else 0,
        # Joined (going: on its people, its chat, its album); saved: a private bookmark
        "following": viewer_id in followers,
        "saved": event.id in store.saved.get(viewer_id, {}),
        # The viewer's connections going: how many, and the first few
        "friendsGoing": len(friends),
        "friends": [summary_of(uid) for uid in friends[:FRIENDS_SHOWN]],
        # How far away people see it now (metres), and whether a promotion pays for it
        "reach": promotions.reach_now(event),
        "sponsored": promotions.sponsored(event),
    }


def rating_view(rating: Rating, named: bool = True) -> dict:
    view = {
        "id": rating.id,
        # Not named: it counts and it shows, without saying who went
        "user": summary_of(rating.user_id) if named else None,
        "rating": rating.rating,
        "comment": rating.comment,
        "date": iso(rating.date),
    }
    if rating.modified:
        view["modifiedDate"] = iso(rating.modified)
    return view


def album_settings(event_id: str, viewer_id: str) -> dict:
    """Who may add photos. The ones chosen are people going to the event: their names go to
    who chose them; anyone else learns only whether they themselves are among them."""
    album = store.album(event_id)
    event = store.events.get(event_id)
    if event and event.creator_id == viewer_id:
        contributors = list(album.contributors)
    else:
        contributors = [viewer_id] if viewer_id in album.contributors else []
    return {"whoCanPost": album.who_can_post, "contributors": contributors}


MAX_FOLLOWERS = 200
MAX_RATINGS = 100


def event_detail(event: Event, viewer_id: str) -> dict:
    view = event_summary(event, viewer_id)
    organizer = viewer_id == event.creator_id
    # Who blocked whom stays hidden both ways; who keeps what they do to their connections
    # is not named to others (Store.sees_story), only to the organizer, who runs the event.
    # followerCount still counts them
    follower_ids = [uid for uid in store.followers.get(event.id, {}) if not store.blocked_either(viewer_id, uid)
                    and (organizer or store.sees_story(viewer_id, uid))]
    # The user first, then their connections, then the others (each in joining order)
    mine = store.connections.get(viewer_id, {})
    follower_ids.sort(key=lambda uid: 0 if uid == viewer_id else 1 if uid in mine else 2)
    ratings = [r for r in store.ratings.get(event.id, {}).values() if not store.blocked_either(viewer_id, r.user_id)]
    ratings.sort(key=lambda r: r.date, reverse=True)
    mine = store.ratings.get(event.id, {}).get(viewer_id)
    # Bounded answers for big events: who is going (the user first) and the newest
    # ratings; followerCount and the user's own rating are always exact
    view["followers"] = [summary_of(uid) for uid in follower_ids[:MAX_FOLLOWERS]]
    view["ratings"] = [rating_view(r, organizer or store.sees_story(viewer_id, r.user_id)) for r in ratings[:MAX_RATINGS]]
    # Over every rating the viewer may see, not only the newest MAX_RATINGS listed
    view["ratingCount"] = len(ratings)
    view["ratingAverage"] = round(sum(r.rating for r in ratings) / len(ratings), 2) if ratings else None
    view["myRating"] = rating_view(mine) if mine else None
    view["album"] = album_settings(event.id, viewer_id)
    if viewer_id == event.creator_id:
        # The free reach it was given, and its promotion: the organizer's only
        view["baseReach"] = event.reach
        view["promotion"] = promotions.promotion_view(event)
    return view


def photo_view(photo: Photo, viewer_id: str) -> dict:
    # Not named, like a rating: it shows, without saying who went to someone who may not know
    # (the organizer, who runs the album, always knows)
    event = store.events.get(photo.event_id)
    named = store.sees_story(viewer_id, photo.author_id) or (event is not None and event.creator_id == viewer_id)
    return {
        "id": photo.id,
        "eventId": photo.event_id,
        "url": Urls.public(photo.url),
        "thumbUrl": Urls.public(photo.thumb_url),
        "width": photo.width,
        "height": photo.height,
        "author": summary_of(photo.author_id) if named else None,
        "createdAt": iso(photo.created_at),
    }


# --- chats ---

def poll_view(poll, viewer: str | None = None) -> dict:
    """A poll: how many chose what, and with `viewer` (answers to one person; what goes to
    the whole chat has no `mine`) what that person chose. Counts only, however many voted:
    the size of a message never grows with its chat."""
    votes = {option["id"]: 0 for option in poll.options}
    for choices in poll.votes.values():
        for choice in choices:
            votes[choice] += 1
    view = {
        "question": poll.question,
        "options": [{"id": option["id"], "text": option["text"], "votes": votes[option["id"]]} for option in poll.options],
        "multiple": poll.multiple,
        "closed": poll.closed,
        "voterCount": len(poll.votes),
        "creator": poll.creator,
    }
    if viewer:
        view["mine"] = poll.votes.get(viewer, [])
    return view


def message_view(message: Message, viewer: str | None = None) -> dict:
    poll = store.polls.get(message.id)
    return {
        "id": message.id,
        "chatId": message.chat_id,
        "from": message.sender,
        "text": message.text,
        "at": iso(message.at),
        "clientId": message.client_id,
        "system": message.system,
        "deleted": message.deleted,
        "poll": poll_view(poll, viewer) if poll else None,
    }


def connection_view(other_id: str, entry: dict) -> dict:
    return {"user": summary_of(other_id), "since": iso(entry["since"]), "place": entry.get("place")}


def sees_message(chat_id: str, user_id: str, message: Message) -> bool:
    """Who is blocked either way writes nothing the other sees; a group shows what was said
    since someone joined it, not what its people said among themselves before."""
    if store.blocked_either(user_id, message.sender):
        return False
    chat = store.chats.get(chat_id)
    return not (chat and chat.kind == "group") or message.at >= chat.members.get(user_id, 0)


def unread_count(chat_id: str, user_id: str) -> int:
    read = store.read_at.get((chat_id, user_id), 0)
    count = 0
    for message in reversed(store.messages.get(chat_id, [])):
        if message.at <= read:
            break
        if message.sender != user_id and not message.system and sees_message(chat_id, user_id, message):
            count += 1
    return count


def chat_base(chat_id: str, user_id: str) -> dict:
    # What the user does not see is neither the chat's last message nor among the unread
    last = next((m for m in reversed(store.messages.get(chat_id, [])) if sees_message(chat_id, user_id, m)), None)
    return {
        "id": chat_id,
        "lastMessage": message_view(last, user_id) if last else None,
        "lastAuthor": summary_of(last.sender) if last else None,
        "unread": unread_count(chat_id, user_id),
        "readAt": iso(store.read_at.get((chat_id, user_id), 0)),
    }


def group_or_direct_summary(chat: Chat, user_id: str, why: str | None = None, can_write: bool = True) -> dict:
    view = chat_base(chat.id, user_id)
    other = None
    if chat.kind == "direct":
        other = next((uid for uid in chat.members if uid != user_id), None)
    view.update({
        "kind": chat.kind,
        "title": store.users[other].name if other and other in store.users else chat.title,
        "color": chat.color,
        "pictureUrl": Urls.public(chat.picture_url),
        "with": summary_of(other) if other else None,
        "event": None,
        "memberCount": len(chat.members),
        "ownerId": chat.owner_id,
        "canWrite": can_write,
        "why": why,
        "closesAt": None,
    })
    return view


def event_chat_summary(event: Event, user_id: str) -> dict:
    chat_id = f"event:{event.id}"
    view = chat_base(chat_id, user_id)
    view.update({
        "kind": "event",
        "title": event.title,
        "color": (event.theme or {}).get("color"),
        "pictureUrl": None,
        "with": None,
        "event": {"id": event.id, "title": event.title, "categories": event.categories, "theme": event.theme},
        "memberCount": len(store.followers.get(event.id, {})) + (0 if event.creator_id in store.followers.get(event.id, {}) else 1),
        "ownerId": event.creator_id,
        "canWrite": True,
        "why": None,
        "closesAt": iso(event.end),
    })
    return view
