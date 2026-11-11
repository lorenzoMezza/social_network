# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""A group's picture, and what makes messaging hold up (API.md, Chats): who sees what since
when, what is sent twice, what other devices hear, reports."""

import json

from conftest import User
from test_privacy import jpeg
from test_security import _storage_put

from app import config
from app.routes import chats as chats_routes
from app.store import store
from app.util import plain_text


def _group(owner, *people):
    for person in people:
        store.connect(owner.id, person.id, None)
    return owner.post("/v1/chats", {"title": "Friends", "memberIds": [person.id for person in people]}).json()


def test_what_was_said_in_the_same_millisecond_as_joining_stays_out(client, monkeypatch):
    owner, late = User(client), User(client)
    chat = _group(owner)
    path = f"/v1/chats/{chat['id']}"
    secret = owner.post(f"{path}/messages", {"text": "before", "clientId": "a"}).json()
    # The clock of the join reads what the message's did
    at = store.messages[chat["id"]][-1].at
    monkeypatch.setattr(chats_routes, "now_ms", lambda: at)
    store.connect(owner.id, late.id, None)
    assert owner.post(f"{path}/members", {"userIds": [late.id]}).status_code == 200
    assert secret["id"] not in [m["id"] for m in late.get(f"{path}/messages").json()["items"]]


def _picture_upload(person, chat_id):
    ticket = person.post("/v1/uploads", {"purpose": "group-picture", "chatId": chat_id, "mimeType": "image/jpeg", "fileSize": 2000}).json()
    assert _storage_put(person.client, ticket, jpeg()).status_code == 200
    return ticket["uploadId"]


def test_the_owner_and_admins_choose_the_picture(client):
    owner, admin, member, stranger = User(client), User(client), User(client), User(client)
    chat = _group(owner, admin, member)
    path = f"/v1/chats/{chat['id']}"
    assert owner.put(f"{path}/members/{admin.id}/role", {"role": "admin"}).status_code == 200

    # Asking for the ticket is already refused to everyone else
    for person, status in ((member, 403), (stranger, 404)):
        answer = person.post("/v1/uploads", {"purpose": "group-picture", "chatId": chat["id"], "mimeType": "image/jpeg", "fileSize": 2000})
        assert answer.status_code == status

    first = admin.put(f"{path}/picture", {"uploadId": _picture_upload(admin, chat["id"])})
    assert first.status_code == 200 and first.json()["pictureUrl"]
    # Everyone sees it, it is said in the chat, and the old file goes when replaced
    assert member.get(path).json()["pictureUrl"] == first.json()["pictureUrl"]
    assert any("photo" in m["text"] for m in member.get(f"{path}/messages").json()["items"] if m["system"])
    old = config.MEDIA_DIR / first.json()["pictureUrl"].split("/v1/media/")[1]
    assert old.exists()
    second = owner.put(f"{path}/picture", {"uploadId": _picture_upload(owner, chat["id"])}).json()
    assert second["pictureUrl"] != first.json()["pictureUrl"] and not old.exists()

    # An upload for another group, or another purpose, is not taken
    other = _group(owner, member)
    wrong = _picture_upload(owner, other["id"])
    assert owner.put(f"{path}/picture", {"uploadId": wrong}).status_code == 403

    # Removing it, and the file is gone with the group too
    assert member.delete(f"{path}/picture").status_code == 403
    assert owner.delete(f"{path}/picture").json()["pictureUrl"] is None
    kept = owner.put(f"{path}/picture", {"uploadId": _picture_upload(owner, chat["id"])}).json()["pictureUrl"]
    file = config.MEDIA_DIR / kept.split("/v1/media/")[1]
    assert owner.delete(path).status_code == 204 and not file.exists()


def test_a_direct_chat_or_an_event_has_no_picture_of_its_own(user, other):
    store.connect(user.id, other.id, None)
    chat = user.post("/v1/chats/direct", {"userId": other.id}).json()
    assert chat["pictureUrl"] is None
    assert user.delete(f"/v1/chats/{chat['id']}/picture").status_code == 404


def test_a_group_has_a_size_and_nobody_owns_too_many(client, monkeypatch):
    owner, a, b = User(client), User(client), User(client)
    monkeypatch.setattr(chats_routes, "GROUP_MEMBERS_MAX", 2)
    store.connect(owner.id, a.id, None)
    store.connect(owner.id, b.id, None)
    assert owner.post("/v1/chats", {"title": "Big", "memberIds": [a.id, b.id]}).json()["code"] == "group_full"
    chat = owner.post("/v1/chats", {"title": "Two", "memberIds": [a.id]}).json()
    assert owner.post(f"/v1/chats/{chat['id']}/members", {"userIds": [b.id]}).json()["code"] == "group_full"
    monkeypatch.setattr(chats_routes, "GROUPS_OWNED_MAX", 1)
    assert owner.post("/v1/chats", {"title": "Again", "memberIds": []}).json()["code"] == "too_many_groups"


def test_who_joins_a_group_reads_from_then_on(client):
    owner, early, late = User(client), User(client), User(client)
    chat = _group(owner, early)
    path = f"/v1/chats/{chat['id']}"
    secret = owner.post(f"{path}/messages", {"text": "before you came", "clientId": "a"}).json()
    store.connect(owner.id, late.id, None)
    assert owner.post(f"{path}/members", {"userIds": [late.id]}).status_code == 200
    after = owner.post(f"{path}/messages", {"text": "welcome", "clientId": "b"}).json()

    page = late.get(f"{path}/messages").json()
    ids = [m["id"] for m in page["items"]]
    assert secret["id"] not in ids and after["id"] in ids and page["nextCursor"] is None
    # Nor as the first thing in the chat, among the new ones, or asked for by its id
    summary = late.get(path).json()
    assert summary["unread"] == 1 and summary["lastMessage"]["id"] == after["id"]
    assert late.get(f"{path}/messages?after={secret['id']}").status_code == 404
    # Who was there still reads everything
    assert secret["id"] in [m["id"] for m in early.get(f"{path}/messages").json()["items"]]

    # Out and back in: what was said meanwhile stays out too
    assert owner.delete(f"{path}/members/{late.id}").status_code == 204
    missed = owner.post(f"{path}/messages", {"text": "while you were out", "clientId": "c"}).json()
    assert owner.post(f"{path}/members", {"userIds": [late.id]}).status_code == 200
    assert missed["id"] not in [m["id"] for m in late.get(f"{path}/messages").json()["items"]]


def test_sent_twice_after_it_stopped_being_allowed_is_still_the_same_message(client):
    owner, member = User(client), User(client)
    chat = _group(owner, member)
    path = f"/v1/chats/{chat['id']}"
    sent = member.post(f"{path}/messages", {"text": "hello", "clientId": "same"}).json()
    # The answer was lost; meanwhile the chat became read-only
    assert owner.patch(path, {"readOnly": True}).status_code == 200
    again = member.post(f"{path}/messages", {"text": "hello", "clientId": "same"})
    assert again.status_code == 201 and again.json()["id"] == sent["id"]
    assert member.post(f"{path}/messages", {"text": "new", "clientId": "other"}).status_code == 403


def test_what_was_read_reaches_the_other_devices(client):
    owner, member = User(client), User(client)
    chat = _group(owner, member)
    path = f"/v1/chats/{chat['id']}"
    message = owner.post(f"{path}/messages", {"text": "hi", "clientId": "a"}).json()
    with client.websocket_connect("/v1/ws") as other_device:
        other_device.send_text(json.dumps({"type": "auth", "token": member.token}))
        assert json.loads(other_device.receive_text())["type"] == "ready"
        assert member.post(f"{path}/read", {"messageId": message["id"]}).status_code == 204
        frame = json.loads(other_device.receive_text())
    assert frame == {"type": "chat.read", "chatId": chat["id"], "unread": 0}


def test_only_who_could_see_it_reports_a_message_and_it_is_kept_as_it_was(client):
    owner, member, stranger = User(client), User(client), User(client)
    chat = _group(owner, member)
    message = owner.post(f"/v1/chats/{chat['id']}/messages", {"text": "something bad", "clientId": "a"}).json()
    body = {"kind": "message", "targetId": message["id"], "reasons": ["harassment"]}
    assert stranger.post("/v1/reports", body).status_code == 404
    assert member.post("/v1/reports", body).status_code == 201
    assert store.reports[-1]["snapshot"]["text"] == "something bad"
    group = {"kind": "group", "targetId": chat["id"], "reasons": ["hate"]}
    assert stranger.post("/v1/reports", group).status_code == 404
    assert member.post("/v1/reports", group).status_code == 201


def test_nothing_hidden_in_what_people_write(client):
    assert plain_text("a‮b​c\u0007d") == "abcd"
    assert plain_text("👨‍👩‍👧 line\nnext") == "👨‍👩‍👧 line\nnext"
    owner, member = User(client), User(client)
    assert owner.patch("/v1/me", {"name": "Ad‮min​"}).json()["name"] == "Admin"
    chat = _group(owner, member)
    sent = owner.post(f"/v1/chats/{chat['id']}/messages", {"text": "‮hi⁦", "clientId": "a"}).json()
    assert sent["text"] == "hi"
    assert owner.post(f"/v1/chats/{chat['id']}/messages", {"text": "‮​", "clientId": "b"}).status_code == 400
    assert owner.post(f"/v1/chats/{chat['id']}/messages", {"text": 42, "clientId": "c"}).status_code == 400


def test_a_message_taken_back_or_removed(client):
    owner, admin, member = User(client), User(client), User(client)
    chat = _group(owner, admin, member)
    path = f"/v1/chats/{chat['id']}"
    assert owner.put(f"{path}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    own = member.post(f"{path}/messages", {"text": "oops", "clientId": "a"}).json()
    theirs = member.post(f"{path}/messages", {"text": "bad", "clientId": "b"}).json()
    from_owner = owner.post(f"{path}/messages", {"text": "rule", "clientId": "c"}).json()

    # Their own, always; someone else's only from a higher role
    assert member.delete(f"{path}/messages/{from_owner['id']}").status_code == 403
    assert admin.delete(f"{path}/messages/{from_owner['id']}").status_code == 403
    answer = member.delete(f"{path}/messages/{own['id']}").json()
    assert answer["deleted"] is True and answer["text"] == ""
    assert admin.delete(f"{path}/messages/{theirs['id']}").status_code == 200

    # Gone on the server for everyone; its place stays, and a pin goes with it
    assert owner.put(f"{path}/pins/{from_owner['id']}").status_code == 200
    assert owner.delete(f"{path}/messages/{from_owner['id']}").status_code == 200
    summary = member.get(path).json()
    assert summary["pinned"] == [] and summary["lastMessage"]["deleted"] is True
    page = member.get(f"{path}/messages").json()["items"]
    assert [m["text"] for m in page if m["deleted"]] == ["", "", ""]


def test_a_direct_chat_has_only_authors(user, other):
    store.connect(user.id, other.id, None)
    chat = user.post("/v1/chats/direct", {"userId": other.id}).json()
    message = user.post(f"/v1/chats/{chat['id']}/messages", {"text": "hi", "clientId": "a"}).json()
    assert other.delete(f"/v1/chats/{chat['id']}/messages/{message['id']}").status_code == 404
    assert user.delete(f"/v1/chats/{chat['id']}/messages/{message['id']}").status_code == 200


def test_a_poll_says_how_many_and_only_to_each_what_they_chose(client):
    owner, member = User(client), User(client)
    chat = _group(owner, member)
    path = f"/v1/chats/{chat['id']}"
    poll = owner.post(f"{path}/polls", {"question": "Where?", "options": ["Here", "There"]}).json()
    answer = member.post(f"{path}/polls/{poll['id']}/votes", {"optionIds": ["o2"]}).json()["poll"]
    assert answer["mine"] == ["o2"] and [o["votes"] for o in answer["options"]] == [0, 1]
    assert all("voters" not in option for option in answer["options"])
    seen = next(m for m in owner.get(f"{path}/messages").json()["items"] if m["id"] == poll["id"])["poll"]
    assert seen["mine"] == [] and seen["voterCount"] == 1
