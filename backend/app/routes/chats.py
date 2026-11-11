# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Chats (API.md): direct, groups and event chats, their messages."""

from fastapi import APIRouter, Depends, Response

from .. import limits, media
from ..auth import current_user
from ..domain import (
    can_message, chat_detail, chats_of, end_group, hand_over, leave_chat, members_of, next_owner, post_message, push_chat,
    require_chat, summary_for,
)
from ..moderation import (
    PIN_MAX, RANK, is_moderated, moderation_of, mute_until, poll_input, require_above, require_rank, role_of, vote_input, write_rule,
)
from ..errors import bad_request, conflict, forbidden, not_found
from ..realtime import hub
from ..store import Chat, Poll, User, store
from ..util import new_id, now_ms, plain_text
from ..views import message_view, sees_message, unread_count

router = APIRouter(prefix="/v1")

TONES = {"#F2546B", "#2F7BFF", "#1F9D63", "#A855F7", "#E08A00", "#0EA5A4", "#F06A3D", "#6E7FF5"}
MESSAGE_MAX = 1000
# A group is among friends: everyone in it gets every message, and it has an owner who knows
# them. Events are the place for crowds.
GROUP_MEMBERS_MAX = 256
GROUPS_OWNED_MAX = 50


@router.get("/chats")
async def list_chats(user: User = Depends(current_user)):
    return {"items": chats_of(user.id)}


@router.post("/chats/direct")
async def open_direct(body: dict, response: Response, user: User = Depends(current_user)):
    other = body.get("userId")
    if not isinstance(other, str) or other not in store.users or other == user.id:
        raise not_found("user not found")
    key = frozenset((user.id, other))
    existing = store.direct.get(key)
    if existing:
        summary = summary_for(existing, user.id)
        if summary is None:
            raise forbidden("you cannot write to this person")
        return summary
    allowed, _ = can_message(user.id, other)
    if not allowed:
        raise forbidden("only with a connection, or someone nearby right now")
    limits.check(user.id, "direct-chat")
    chat = Chat(id=new_id("chat"), kind="direct", members={user.id: now_ms(), other: now_ms()}, opened_by=user.id)
    store.chats[chat.id] = chat
    store.direct[key] = chat.id
    response.status_code = 201
    return summary_for(chat.id, user.id)


def _title(value) -> str:
    title = " ".join(plain_text(value).split()) if isinstance(value, str) else ""
    if not 1 <= len(title) <= 50:
        raise bad_request("title: 1–50 characters")
    return title


def _color(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value not in TONES:
        raise bad_request("color: one of the app's tones")
    return value


@router.post("/chats", status_code=201)
async def create_group(body: dict, user: User = Depends(current_user)):
    title, color = _title(body.get("title")), _color(body.get("color"))
    members = body.get("memberIds") or []
    if not isinstance(members, list) or any(not isinstance(m, str) or not store.is_connected(user.id, m) for m in members):
        raise forbidden("only your connections can be added")
    if len(set(members)) + 1 > GROUP_MEMBERS_MAX:
        raise conflict(f"a group has at most {GROUP_MEMBERS_MAX} people", code="group_full")
    if sum(1 for chat in store.chats.values() if chat.kind == "group" and chat.owner_id == user.id) >= GROUPS_OWNED_MAX:
        raise conflict(f"at most {GROUPS_OWNED_MAX} groups", code="too_many_groups")
    limits.check(user.id, "group")
    now = now_ms()
    chat = Chat(id=new_id("chat"), kind="group", title=title, color=color, owner_id=user.id, members={user.id: now, **{m: now for m in members}})
    store.chats[chat.id] = chat
    post_message(chat.id, user.id, f"Created “{title}”", system=True)
    push_chat(chat.id, chat.members)
    return chat_detail(chat.id, user.id)


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str, user: User = Depends(current_user)):
    return chat_detail(chat_id, user.id)


@router.patch("/chats/{chat_id}")
async def patch_chat(chat_id: str, body: dict, user: User = Depends(current_user)):
    """Groups: title, colour, read-only. Event chats (named after their event): read-only."""
    members = members_of(chat_id)
    require_rank(chat_id, user.id, members)
    limits.check(user.id, "chat-edit")
    group = store.chats.get(chat_id)
    if ("title" in body or "color" in body) and not group:
        raise bad_request("an event chat is named after its event")
    if "title" in body:
        group.title = _title(body["title"])
    if "color" in body:
        group.color = _color(body["color"])
    if "readOnly" in body:
        if not isinstance(body["readOnly"], bool):
            raise bad_request("readOnly: true or false")
        moderation = moderation_of(chat_id)
        if moderation.read_only != body["readOnly"]:
            moderation.read_only = body["readOnly"]
            post_message(chat_id, user.id, f"{store.users[user.id].name} {'made the chat read-only: only admins write' if moderation.read_only else 'let everyone write again'}", system=True)
    push_chat(chat_id, members)
    return chat_detail(chat_id, user.id)


@router.post("/chats/{chat_id}/members")
async def add_members(chat_id: str, body: dict, user: User = Depends(current_user)):
    """Groups: the owner and the admins add their own connections."""
    chat = store.chats.get(chat_id)
    if not chat or chat.kind != "group":
        raise not_found("chat not found")
    require_rank(chat_id, user.id, chat.members)
    ids = body.get("userIds") or []
    if not isinstance(ids, list) or not ids or any(not isinstance(m, str) or not store.is_connected(user.id, m) for m in ids):
        raise forbidden("only your connections can be added")
    # An admin adding someone with a block with the owner would put them where who runs the
    # group cannot see them
    if any(store.blocked_either(chat.owner_id, m) for m in ids):
        raise forbidden("they cannot be added to this group")
    new = [member for member in dict.fromkeys(ids) if member not in chat.members]
    if len(chat.members) + len(new) > GROUP_MEMBERS_MAX:
        raise conflict(f"a group has at most {GROUP_MEMBERS_MAX} people", code="group_full")
    limits.check(user.id, "members")
    # After the last thing said, also within the same millisecond: what came before stays theirs to not see
    said = store.messages.get(chat.id)
    joined_at = max(now_ms(), said[-1].at + 1) if said else now_ms()
    for member in new:
        chat.members[member] = joined_at
    # Said in the chat, like someone leaving or being removed
    if new:
        names = ", ".join(store.users[member].name for member in new)
        post_message(chat.id, user.id, f"{store.users[user.id].name} added {names}", system=True)
    push_chat(chat.id, chat.members)
    return chat_detail(chat.id, user.id)


def _group_run_by(chat_id: str, user: User) -> Chat:
    chat = store.chats.get(chat_id)
    if not chat or chat.kind != "group":
        raise not_found("chat not found")
    require_rank(chat_id, user.id, chat.members)
    return chat


@router.put("/chats/{chat_id}/picture")
async def put_group_picture(chat_id: str, body: dict, user: User = Depends(current_user)):
    """The group's picture, chosen by its owner or an admin (an upload of purpose
    group-picture, made for this chat). Said in the chat, as a new name would be."""
    chat = _group_run_by(chat_id, user)
    limits.check(user.id, "picture")
    upload = media.take(body.get("uploadId"), user.id, "group-picture", chat_id=chat.id)
    previous = chat.picture_url
    chat.picture_url = media.group_picture(upload)
    media.discard(previous)
    post_message(chat.id, user.id, f"{store.users[user.id].name} changed the group's photo", system=True)
    push_chat(chat.id, chat.members)
    return chat_detail(chat.id, user.id)


@router.delete("/chats/{chat_id}/picture")
async def delete_group_picture(chat_id: str, user: User = Depends(current_user)):
    chat = _group_run_by(chat_id, user)
    if chat.picture_url:
        media.discard(chat.picture_url)
        chat.picture_url = None
        post_message(chat.id, user.id, f"{store.users[user.id].name} removed the group's photo", system=True)
        push_chat(chat.id, chat.members)
    return chat_detail(chat.id, user.id)


@router.delete("/chats/{chat_id}/members/{member_id}", status_code=204)
async def remove_member(chat_id: str, member_id: str, user: User = Depends(current_user)):
    """Someone leaves (`me`), or is removed by a higher role. Removed from an event chat,
    they are removed from the event too and cannot join it again."""
    members = members_of(chat_id)
    if not is_moderated(chat_id) or user.id not in members:
        raise not_found("chat not found")
    member_id = user.id if member_id == "me" else member_id
    if member_id == user.id:
        if role_of(chat_id, user.id) == "owner":
            chat = store.chats.get(chat_id)
            if not chat:
                raise forbidden("the organizer cancels the event instead")
            # The group goes on with who has been in it longest; alone in it, it is over
            successor = next_owner(chat, user.id)
            if successor is None:
                end_group(chat)
                return Response(status_code=204)
            # In the chat as it happened: they leave, then the other takes over
            leave_chat(chat_id, user.id)
            hand_over(chat, successor)
        else:
            leave_chat(chat_id, user.id)
    else:
        require_above(chat_id, user.id, member_id, members)
        limits.check(user.id, "chat-edit")
        leave_chat(chat_id, member_id, removed_by=user.id)
    return Response(status_code=204)


@router.put("/chats/{chat_id}/members/{member_id}/role")
async def set_role(chat_id: str, member_id: str, body: dict, user: User = Depends(current_user)):
    """The owner names an admin, or makes one a member again."""
    members = members_of(chat_id)
    require_rank(chat_id, user.id, members, "owner")
    limits.check(user.id, "chat-edit")
    role = body.get("role")
    if role not in ("admin", "member"):
        raise bad_request("role: admin or member")
    if member_id not in members or store.blocked_either(user.id, member_id):
        raise not_found("member not found")
    if member_id == user.id:
        raise forbidden("not on yourself")
    moderation = moderation_of(chat_id)
    if (member_id in moderation.admins) != (role == "admin"):
        if role == "admin":
            moderation.admins.add(member_id)
            moderation.muted.pop(member_id, None)
        else:
            moderation.admins.discard(member_id)
        name = store.users[member_id].name
        post_message(chat_id, user.id, f"{name} is now an admin" if role == "admin" else f"{name} is no longer an admin", system=True)
    push_chat(chat_id, members)
    return chat_detail(chat_id, user.id)


@router.put("/chats/{chat_id}/members/{member_id}/mute")
async def mute(chat_id: str, member_id: str, body: dict, user: User = Depends(current_user)):
    """No messages from them for `minutes` (60, 480, 10080), or until unmuted (null)."""
    members = members_of(chat_id)
    require_above(chat_id, user.id, member_id, members)
    limits.check(user.id, "chat-edit")
    moderation_of(chat_id).muted[member_id] = mute_until(body.get("minutes"))
    push_chat(chat_id, [member_id, *(m for m in members if role_of(chat_id, m) != "member")])
    return chat_detail(chat_id, user.id)


@router.delete("/chats/{chat_id}/members/{member_id}/mute")
async def unmute(chat_id: str, member_id: str, user: User = Depends(current_user)):
    members = members_of(chat_id)
    require_above(chat_id, user.id, member_id, members)
    limits.check(user.id, "chat-edit")
    moderation_of(chat_id).muted.pop(member_id, None)
    push_chat(chat_id, [member_id, *(m for m in members if role_of(chat_id, m) != "member")])
    return chat_detail(chat_id, user.id)


@router.delete("/chats/{chat_id}", status_code=204)
async def delete_group(chat_id: str, user: User = Depends(current_user)):
    """The owner deletes their group for everyone (an event chat ends with its event)."""
    chat = store.chats.get(chat_id)
    if not chat or chat.kind != "group" or user.id not in chat.members:
        raise not_found("chat not found")
    require_rank(chat_id, user.id, chat.members, "owner")
    end_group(chat)
    return Response(status_code=204)


@router.put("/chats/{chat_id}/pins/{message_id}")
async def pin(chat_id: str, message_id: str, user: User = Depends(current_user)):
    """At most PIN_MAX pinned messages: a new pin beyond them unpins the oldest."""
    members = members_of(chat_id)
    require_rank(chat_id, user.id, members)
    message = _message(chat_id, message_id)
    if message.system or message.deleted:
        raise bad_request("system or removed messages cannot be pinned")
    limits.check(user.id, "chat-edit")
    moderation = moderation_of(chat_id)
    if message_id not in moderation.pins:
        moderation.pins = [message_id, *moderation.pins][:PIN_MAX]
    push_chat(chat_id, members)
    return chat_detail(chat_id, user.id)


@router.delete("/chats/{chat_id}/pins/{message_id}")
async def unpin(chat_id: str, message_id: str, user: User = Depends(current_user)):
    members = members_of(chat_id)
    require_rank(chat_id, user.id, members)
    limits.check(user.id, "chat-edit")
    moderation = moderation_of(chat_id)
    if message_id in moderation.pins:
        moderation.pins.remove(message_id)
    push_chat(chat_id, members)
    return chat_detail(chat_id, user.id)


@router.post("/chats/{chat_id}/polls", status_code=201)
async def create_poll(chat_id: str, body: dict, user: User = Depends(current_user)):
    """The owner and the admins ask the chat to choose."""
    members = members_of(chat_id)
    require_rank(chat_id, user.id, members)
    if not require_chat(chat_id, user.id)["canWrite"]:
        raise forbidden("you cannot write in this chat")
    question, options, multiple = poll_input(body)
    limits.check(user.id, "message")
    message = post_message(chat_id, user.id, question, poll=Poll(message_id="", chat_id=chat_id, creator=user.id,
                                                                    question=question, options=options, multiple=multiple))
    return message_view(message, user.id)


@router.post("/chats/{chat_id}/polls/{message_id}/votes")
async def vote(chat_id: str, message_id: str, body: dict, user: User = Depends(current_user)):
    """The member's choices (replacing the previous ones; [] takes the vote back)."""
    require_chat(chat_id, user.id)
    poll = _poll(chat_id, message_id)
    # A poll from before they joined the group, or of someone blocked, is not there for them
    if not sees_message(chat_id, user.id, _message(chat_id, message_id)):
        raise not_found("poll not found")
    if write_rule(chat_id, user.id) == "muted":
        raise forbidden("you are muted in this chat")
    choices = vote_input(poll, body)
    limits.check(user.id, "vote")
    if choices:
        poll.votes[user.id] = choices
    else:
        poll.votes.pop(user.id, None)
    _poll_changed(chat_id, message_id)
    return message_view(_message(chat_id, message_id), user.id)


@router.post("/chats/{chat_id}/polls/{message_id}/close")
async def close_poll(chat_id: str, message_id: str, user: User = Depends(current_user)):
    members = members_of(chat_id)
    poll = _poll(chat_id, message_id)
    if user.id != poll.creator:
        require_rank(chat_id, user.id, members)
    elif user.id not in members:
        raise not_found("chat not found")
    # Closed once: asked again it tells nobody again
    if not poll.closed:
        limits.check(user.id, "chat-edit")
        poll.closed = True
        _poll_changed(chat_id, message_id)
    return message_view(_message(chat_id, message_id), user.id)


def _message(chat_id: str, message_id: str):
    message = next((m for m in store.messages.get(chat_id, []) if m.id == message_id), None)
    if not message:
        raise not_found("message not found")
    return message


def _poll(chat_id: str, message_id: str):
    poll = store.polls.get(message_id)
    if not poll or poll.chat_id != chat_id:
        raise not_found("poll not found")
    return poll


def _poll_changed(chat_id: str, message_id: str):
    """Everyone in the chat sees the new counts at once (`message.updated`)."""
    message = _message(chat_id, message_id)
    view = message_view(message)
    for member in members_of(chat_id):
        if sees_message(chat_id, member, message):
            hub.send(member, {"type": "message.updated", "message": view})


@router.delete("/chats/{chat_id}/messages/{message_id}")
async def delete_message(chat_id: str, message_id: str, user: User = Depends(current_user)):
    """A message taken back by its author, or removed by a higher role than theirs. Its text
    goes for everyone at once and on the server; its place in the chat stays ("removed")."""
    require_chat(chat_id, user.id)
    message = _message(chat_id, message_id)
    if message.system:
        raise bad_request("system messages cannot be removed")
    if message.sender != user.id:
        role = require_rank(chat_id, user.id, members_of(chat_id))
        if RANK[role_of(chat_id, message.sender)] >= RANK[role]:
            raise forbidden("only a message of someone with a lower role")
        limits.check(user.id, "chat-edit")
    if not message.deleted:
        message.deleted, message.text = True, ""
        store.polls.pop(message.id, None)
        moderation = store.moderation.get(chat_id)
        pinned = moderation and message.id in moderation.pins
        if pinned:
            moderation.pins.remove(message.id)
        _poll_changed(chat_id, message.id)
        if pinned:
            push_chat(chat_id, members_of(chat_id))
    return message_view(message, user.id)


@router.get("/chats/{chat_id}/messages")
async def messages(chat_id: str, before: str | None = None, after: str | None = None, limit: int = 50,
                   user: User = Depends(current_user)):
    require_chat(chat_id, user.id)
    if before and after:
        raise bad_request("before or after, not both")
    limit = max(1, min(limit, 100))
    # Pages of what the user sees: what they do not (someone blocked, before they joined the
    # group) neither takes room in a page nor says there is more
    items = [m for m in store.messages.get(chat_id, []) if sees_message(chat_id, user.id, m)]
    if after:
        # Newer than a message the app has (it was offline): oldest first, and the
        # cursor to ask for the next ones while there are more
        index = next((i for i, m in enumerate(items) if m.id == after), None)
        if index is None:
            raise not_found("message not found")
        end = min(len(items), index + 1 + limit)
        return {"items": [message_view(m, user.id) for m in items[index + 1:end]], "nextCursor": items[end - 1].id if end < len(items) else None}
    end = len(items)
    if before:
        end = next((i for i, m in enumerate(items) if m.id == before), end)
    start = max(0, end - limit)
    return {"items": [message_view(m, user.id) for m in items[start:end]], "nextCursor": items[start].id if start > 0 else None}


@router.post("/chats/{chat_id}/messages", status_code=201)
async def send(chat_id: str, body: dict, user: User = Depends(current_user)):
    summary = require_chat(chat_id, user.id)
    client_id = body.get("clientId")
    if client_id is not None and (not isinstance(client_id, str) or len(client_id) > 64):
        raise bad_request("clientId: a string of at most 64 characters")
    # Sent already, its answer lost on the way: the same message, whatever changed since
    # (they walked away, the chat became read-only). It was allowed when it was written
    if client_id and (chat_id, user.id, client_id) in store.sent:
        return message_view(store.sent[(chat_id, user.id, client_id)])
    if not summary["canWrite"]:
        raise forbidden("you cannot write in this chat")
    text = plain_text(body.get("text")).strip() if isinstance(body.get("text"), str) else ""
    if not text or len(text) > MESSAGE_MAX:
        raise bad_request(f"text: 1–{MESSAGE_MAX} characters")
    limits.check(user.id, "message")
    return message_view(post_message(chat_id, user.id, text, client_id))


@router.post("/chats/{chat_id}/read", status_code=204)
async def read(chat_id: str, body: dict, user: User = Depends(current_user)):
    require_chat(chat_id, user.id)
    message = next((m for m in store.messages.get(chat_id, []) if m.id == body.get("messageId")), None)
    if not message:
        raise not_found("message not found")
    key = (chat_id, user.id)
    if message.at > store.read_at.get(key, 0):
        store.read_at[key] = message.at
        # Their other devices stop counting it as new
        hub.send(user.id, {"type": "chat.read", "chatId": chat_id, "unread": unread_count(chat_id, user.id)})
    return Response(status_code=204)

