# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Who runs a group or an event chat, and what each role may do (API.md, Moderation).

Roles: the owner (a group's creator, an event's organizer), the admins the owner
names, the members. Every rule is checked here, on the server; the app only hides
what a role cannot do.
  - The owner names and removes admins and acts on everyone but themselves.
  - Admins act on members only, never on another admin or on the owner.
  - Removing, muting and unmuting need a higher role than the person's.
  - Everyone may leave. A group's owner too: it passes to the admin who has been in it
    longest, else to whoever has; only the owner can delete it for everyone.
Direct chats have none of this.
"""

from .errors import ApiError, bad_request, forbidden, not_found
from .store import Moderation, store
from .util import now_ms, plain_text

RANK = {"owner": 2, "admin": 1, "member": 0}
PIN_MAX = 3
# Muting: an hour, eight hours, a week, or until unmuted (None)
MUTE_MINUTES = {60, 480, 10080}
POLL_OPTIONS = (2, 10)
POLL_QUESTION_MAX = 200
POLL_OPTION_MAX = 80


def is_moderated(chat_id: str) -> bool:
    """A group, or the chat of an event not over: a chat that closed with its event has
    nobody to run (removing someone from it would also take away that they went)."""
    if chat_id.startswith("event:"):
        event = store.events.get(chat_id[6:])
        return bool(event and not event.cancelled and event.end > now_ms())
    chat = store.chats.get(chat_id)
    return bool(chat and chat.kind == "group")


def moderation_of(chat_id: str) -> Moderation:
    return store.moderation.setdefault(chat_id, Moderation())


def owner_of(chat_id: str) -> str | None:
    if chat_id.startswith("event:"):
        event = store.events.get(chat_id[6:])
        return event.creator_id if event else None
    chat = store.chats.get(chat_id)
    return chat.owner_id if chat else None


def role_of(chat_id: str, user_id: str) -> str:
    """The role of a member (who is in the chat: checked by the caller)."""
    if user_id == owner_of(chat_id):
        return "owner"
    moderation = store.moderation.get(chat_id)
    return "admin" if moderation and user_id in moderation.admins else "member"


def muted_until(chat_id: str, user_id: str) -> tuple[bool, int | None]:
    """Whether the member is muted now, and until when (None: until unmuted)."""
    moderation = store.moderation.get(chat_id)
    if not moderation or user_id not in moderation.muted:
        return False, None
    until = moderation.muted[user_id]
    if until is not None and until <= now_ms():
        del moderation.muted[user_id]
        return False, None
    return True, until


def write_rule(chat_id: str, user_id: str) -> str | None:
    """Why a member cannot write now: 'muted', 'readonly', or None."""
    if muted_until(chat_id, user_id)[0]:
        return "muted"
    moderation = store.moderation.get(chat_id)
    if moderation and moderation.read_only and RANK[role_of(chat_id, user_id)] < RANK["admin"]:
        return "readonly"
    return None


def require_rank(chat_id: str, user_id: str, members, rank: str = "admin") -> str:
    """The user's role, when it is at least `rank` (404 outside the chat, 403 below)."""
    if not is_moderated(chat_id) or user_id not in members:
        raise not_found("chat not found")
    role = role_of(chat_id, user_id)
    if RANK[role] < RANK[rank]:
        raise forbidden(f"only the {'owner' if rank == 'owner' else 'owner or an admin'} can do this")
    return role


def require_above(chat_id: str, actor: str, target: str, members) -> None:
    """The actor may act on the target: both in the chat, the actor's role higher."""
    actor_role = require_rank(chat_id, actor, members)
    if target == actor:
        raise forbidden("not on yourself")
    if target not in members:
        raise not_found("member not found")
    if RANK[role_of(chat_id, target)] >= RANK[actor_role]:
        raise forbidden("only on someone with a lower role")


def forget_member(chat_id: str, user_id: str) -> None:
    """Someone left or was removed: no role or mute stays behind."""
    moderation = store.moderation.get(chat_id)
    if moderation:
        moderation.admins.discard(user_id)
        moderation.muted.pop(user_id, None)
    # Chosen to add photos to the event's album as someone going to it: no longer
    album = store.albums.get(chat_id[6:]) if chat_id.startswith("event:") else None
    if album and user_id in album.contributors:
        album.contributors.remove(user_id)


def mute_until(minutes) -> int | None:
    if minutes is None:
        return None
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes not in MUTE_MINUTES:
        raise bad_request(f"minutes: one of {sorted(MUTE_MINUTES)}, or null (until unmuted)")
    return now_ms() + minutes * 60_000


def poll_input(body: dict) -> tuple[str, list, bool]:
    question = " ".join(plain_text(body.get("question")).split()) if isinstance(body.get("question"), str) else ""
    if not 1 <= len(question) <= POLL_QUESTION_MAX:
        raise bad_request(f"question: 1–{POLL_QUESTION_MAX} characters")
    options = body.get("options")
    if not isinstance(options, list) or not POLL_OPTIONS[0] <= len(options) <= POLL_OPTIONS[1]:
        raise bad_request(f"options: {POLL_OPTIONS[0]}–{POLL_OPTIONS[1]}")
    texts = [" ".join(plain_text(option).split()) if isinstance(option, str) else "" for option in options]
    if any(not 1 <= len(text) <= POLL_OPTION_MAX for text in texts):
        raise bad_request(f"each option: 1–{POLL_OPTION_MAX} characters")
    if len({text.casefold() for text in texts}) != len(texts):
        raise bad_request("options: all different")
    multiple = body.get("multiple", False)
    if not isinstance(multiple, bool):
        raise bad_request("multiple: true or false")
    return question, [{"id": f"o{i + 1}", "text": text} for i, text in enumerate(texts)], multiple


def vote_input(poll, body: dict) -> list[str]:
    ids = body.get("optionIds")
    if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
        raise bad_request("optionIds: a list of option ids (empty: no vote)")
    valid = {option["id"] for option in poll.options}
    if len(set(ids)) != len(ids) or any(i not in valid for i in ids):
        raise bad_request("optionIds: options of this poll, once each")
    if not poll.multiple and len(ids) > 1:
        raise bad_request("this poll takes one option")
    if poll.closed:
        raise ApiError(409, "closed", "the poll is closed")
    return ids
