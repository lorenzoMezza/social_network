# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Groups and event chats run by their owner and admins (API.md, Moderation): roles,
removing, muting, read-only, pins, polls. Each rule is also tried by everyone it does
not allow (privilege escalation)."""

import pytest

from conftest import User, new_event
from app.store import store


def connect(host, guest):
    session = host.post("/v1/connections/sessions", {"location": None}).json()
    assert guest.post("/v1/connections/claims", {"token": session["token"]}).status_code == 200


@pytest.fixture
def team(client):
    """A group of four: its owner, an admin, two members."""
    owner, admin, ann, bob = (User(client, name) for name in ("Owner", "Admin", "Ann", "Bob"))
    for person in (admin, ann, bob):
        connect(owner, person)
    group = owner.post("/v1/chats", {"title": "Team", "color": "#2F7BFF", "memberIds": [admin.id, ann.id, bob.id]}).json()
    assert owner.put(f"/v1/chats/{group['id']}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    return group["id"], owner, admin, ann, bob


def roles(user, chat_id):
    return {m["user"]["id"]: m["role"] for m in user.get(f"/v1/chats/{chat_id}").json()["members"]}


def say(user, chat_id, text="hi"):
    return user.post(f"/v1/chats/{chat_id}/messages", {"text": text})


# --- roles ---

def test_only_the_owner_names_admins(team):
    chat, owner, admin, ann, bob = team
    assert roles(ann, chat)[admin.id] == "admin"
    assert ann.get(f"/v1/chats/{chat}").json()["role"] == "member"
    assert admin.get(f"/v1/chats/{chat}").json()["role"] == "admin"
    # Neither an admin nor a member names anyone, themselves included
    for actor in (admin, ann):
        for target in (ann.id, bob.id, actor.id):
            assert actor.put(f"/v1/chats/{chat}/members/{target}/role", {"role": "admin"}).status_code == 403
    assert owner.put(f"/v1/chats/{chat}/members/{owner.id}/role", {"role": "member"}).status_code == 403
    assert owner.put(f"/v1/chats/{chat}/members/{ann.id}/role", {"role": "owner"}).status_code == 400
    assert owner.put(f"/v1/chats/{chat}/members/nobody/role", {"role": "admin"}).status_code == 404
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "member"}).status_code == 200
    assert roles(owner, chat)[admin.id] == "member"
    assert any("no longer an admin" in m["text"] for m in owner.get(f"/v1/chats/{chat}/messages").json()["items"])


def test_removing_needs_a_higher_role(team):
    chat, owner, admin, ann, bob = team
    assert ann.delete(f"/v1/chats/{chat}/members/{bob.id}").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/members/{owner.id}").status_code == 403
    assert ann.delete(f"/v1/chats/{chat}/members/{owner.id}").status_code == 403
    # (the owner leaving: test_scenarios, it passes on)
    assert admin.delete(f"/v1/chats/{chat}/members/{ann.id}").status_code == 204
    # Out: the chat is gone for them
    assert ann.get(f"/v1/chats/{chat}").status_code == 404
    assert say(ann, chat).status_code == 404
    assert ann.delete(f"/v1/chats/{chat}/members/{bob.id}").status_code == 404
    # An admin cannot remove another admin; the owner can
    assert owner.put(f"/v1/chats/{chat}/members/{bob.id}/role", {"role": "admin"}).status_code == 200
    assert admin.delete(f"/v1/chats/{chat}/members/{bob.id}").status_code == 403
    assert owner.delete(f"/v1/chats/{chat}/members/{bob.id}").status_code == 204
    # A removed admin is no admin anywhere in the chat
    assert bob.id not in store.moderation[chat].admins


def test_a_member_leaves(team):
    chat, owner, admin, ann, bob = team
    assert bob.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert bob.get(f"/v1/chats/{chat}").status_code == 404
    assert any(m["text"] == "Bob left" for m in owner.get(f"/v1/chats/{chat}/messages").json()["items"])


def test_admins_add_their_own_connections(team, client):
    chat, owner, admin, ann, bob = team
    friend = User(client, "Friend")
    connect(admin, friend)
    assert ann.post(f"/v1/chats/{chat}/members", {"userIds": [admin.id]}).status_code == 403
    assert owner.post(f"/v1/chats/{chat}/members", {"userIds": [friend.id]}).status_code == 403  # not the owner's connection
    assert admin.post(f"/v1/chats/{chat}/members", {"userIds": [friend.id]}).status_code == 200
    assert friend.get(f"/v1/chats/{chat}").json()["role"] == "member"


def test_only_the_owner_deletes_the_group(team):
    chat, owner, admin, ann, bob = team
    assert ann.delete(f"/v1/chats/{chat}").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}").status_code == 403
    assert owner.delete(f"/v1/chats/{chat}").status_code == 204
    assert owner.get(f"/v1/chats/{chat}").status_code == 404
    assert chat not in store.moderation


# --- muting ---

def test_muting(team):
    chat, owner, admin, ann, bob = team
    assert ann.put(f"/v1/chats/{chat}/members/{bob.id}/mute", {"minutes": 60}).status_code == 403
    assert admin.put(f"/v1/chats/{chat}/members/{owner.id}/mute", {"minutes": 60}).status_code == 403
    assert admin.put(f"/v1/chats/{chat}/members/{admin.id}/mute", {"minutes": 60}).status_code == 403
    for bad in (5, 0, -60, "60", True, 999999):
        assert admin.put(f"/v1/chats/{chat}/members/{bob.id}/mute", {"minutes": bad}).status_code == 400, bad
    assert admin.put(f"/v1/chats/{chat}/members/{bob.id}/mute", {"minutes": 60}).status_code == 200
    summary = bob.get(f"/v1/chats/{chat}").json()
    assert (summary["canWrite"], summary["why"], summary["muted"]) == (False, "muted", True)
    assert summary["mutedUntil"]
    assert say(bob, chat).status_code == 403
    # Only the owner and admins see who is muted
    assert [m["muted"] for m in ann.get(f"/v1/chats/{chat}").json()["members"]] == [False] * 4
    assert next(m for m in admin.get(f"/v1/chats/{chat}").json()["members"] if m["user"]["id"] == bob.id)["muted"]
    # Until it ends
    store.moderation[chat].muted[bob.id] = 1
    assert say(bob, chat).status_code == 201
    # Until unmuted
    assert admin.put(f"/v1/chats/{chat}/members/{bob.id}/mute", {"minutes": None}).status_code == 200
    assert bob.get(f"/v1/chats/{chat}").json()["mutedUntil"] is None
    assert say(bob, chat).status_code == 403
    assert ann.delete(f"/v1/chats/{chat}/members/{bob.id}/mute").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/members/{bob.id}/mute").status_code == 200
    assert say(bob, chat).status_code == 201
    # The owner mutes an admin; making someone an admin unmutes them
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/mute", {"minutes": 480}).status_code == 200
    assert say(admin, chat).status_code == 403
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "member"}).status_code == 200
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    assert say(admin, chat).status_code == 201


# --- read-only ---

def test_read_only(team):
    chat, owner, admin, ann, bob = team
    assert ann.patch(f"/v1/chats/{chat}", {"readOnly": True}).status_code == 403
    assert admin.patch(f"/v1/chats/{chat}", {"readOnly": "yes"}).status_code == 400
    assert admin.patch(f"/v1/chats/{chat}", {"readOnly": True}).status_code == 200
    summary = ann.get(f"/v1/chats/{chat}").json()
    assert (summary["readOnly"], summary["canWrite"], summary["why"]) == (True, False, "readonly")
    assert say(ann, chat).status_code == 403
    assert say(admin, chat).status_code == 201
    assert say(owner, chat).status_code == 201
    # Members still vote
    poll = admin.post(f"/v1/chats/{chat}/polls", {"question": "When?", "options": ["Sat", "Sun"]}).json()
    assert ann.post(f"/v1/chats/{chat}/polls/{poll['id']}/votes", {"optionIds": ["o1"]}).status_code == 200
    assert admin.patch(f"/v1/chats/{chat}", {"readOnly": False}).status_code == 200
    assert say(ann, chat).status_code == 201


def test_renaming(team):
    chat, owner, admin, ann, bob = team
    assert ann.patch(f"/v1/chats/{chat}", {"title": "Mine"}).status_code == 403
    assert admin.patch(f"/v1/chats/{chat}", {"title": "Renamed"}).status_code == 200
    assert bob.get(f"/v1/chats/{chat}").json()["title"] == "Renamed"


# --- pins ---

def test_pins(team):
    chat, owner, admin, ann, bob = team
    ids = [say(ann, chat, f"m{i}").json()["id"] for i in range(4)]
    assert ann.put(f"/v1/chats/{chat}/pins/{ids[0]}").status_code == 403
    assert admin.put(f"/v1/chats/{chat}/pins/nope").status_code == 404
    system = next(m for m in owner.get(f"/v1/chats/{chat}/messages").json()["items"] if m["system"])
    assert admin.put(f"/v1/chats/{chat}/pins/{system['id']}").status_code == 400
    for message_id in ids:
        assert admin.put(f"/v1/chats/{chat}/pins/{message_id}").status_code == 200
    # At most three, the newest first: the first pin went
    pinned = [m["id"] for m in bob.get(f"/v1/chats/{chat}").json()["pinned"]]
    assert pinned == [ids[3], ids[2], ids[1]]
    assert ann.delete(f"/v1/chats/{chat}/pins/{ids[3]}").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/pins/{ids[3]}").status_code == 200
    assert [m["id"] for m in bob.get(f"/v1/chats/{chat}").json()["pinned"]] == [ids[2], ids[1]]


# --- polls ---

def test_polls(team):
    chat, owner, admin, ann, bob = team
    body = {"question": "Where do we go?", "options": ["Park", "Beach", "Cinema"], "multiple": False}
    assert ann.post(f"/v1/chats/{chat}/polls", body).status_code == 403
    for bad in ({**body, "options": ["One"]}, {**body, "options": ["A", "a"]}, {**body, "question": ""},
                {**body, "options": ["x" * 81, "y"]}, {**body, "options": [1, 2]}, {**body, "multiple": "no"},
                {**body, "options": [str(i) for i in range(11)]}):
        assert admin.post(f"/v1/chats/{chat}/polls", bad).status_code == 400, bad
    poll = admin.post(f"/v1/chats/{chat}/polls", body).json()
    assert poll["poll"]["options"][0] == {"id": "o1", "text": "Park", "votes": 0}
    votes = f"/v1/chats/{chat}/polls/{poll['id']}/votes"
    assert ann.post(votes, {"optionIds": ["o1", "o2"]}).status_code == 400  # one option only
    assert ann.post(votes, {"optionIds": ["o9"]}).status_code == 400
    assert ann.post(votes, {"optionIds": ["o2"]}).json()["poll"]["mine"] == ["o2"]
    assert ann.post(votes, {"optionIds": ["o3"]}).json()["poll"]["voterCount"] == 1  # changed, not added
    assert ann.post(votes, {"optionIds": []}).json()["poll"]["voterCount"] == 0  # taken back
    # Muted: no vote
    assert admin.put(f"/v1/chats/{chat}/members/{bob.id}/mute", {"minutes": 60}).status_code == 200
    assert bob.post(votes, {"optionIds": ["o1"]}).status_code == 403
    # Closing: its author or the owner; not a member
    assert ann.post(f"/v1/chats/{chat}/polls/{poll['id']}/close").status_code == 403
    assert owner.post(f"/v1/chats/{chat}/polls/{poll['id']}/close").json()["poll"]["closed"] is True
    assert ann.post(votes, {"optionIds": ["o1"]}).status_code == 409
    # Several choices when the poll allows it
    multi = admin.post(f"/v1/chats/{chat}/polls", {**body, "multiple": True}).json()
    answer = ann.post(f"/v1/chats/{chat}/polls/{multi['id']}/votes", {"optionIds": ["o1", "o3"]}).json()
    assert answer["poll"]["mine"] == ["o1", "o3"] and [o["votes"] for o in answer["poll"]["options"]] == [1, 0, 1]
    # Another chat's poll is not reachable from here
    assert ann.post(f"/v1/chats/other/polls/{multi['id']}/votes", {"optionIds": ["o1"]}).status_code == 404


def test_nothing_of_this_in_direct_chats(client):
    a, b = User(client, "A"), User(client, "B")
    connect(a, b)
    direct = a.post("/v1/chats/direct", {"userId": b.id}).json()
    assert direct["role"] is None and direct["pinned"] == []
    assert a.post(f"/v1/chats/{direct['id']}/polls", {"question": "?", "options": ["x", "y"]}).status_code == 404
    assert a.put(f"/v1/chats/{direct['id']}/members/{b.id}/mute", {"minutes": 60}).status_code == 404
    assert a.delete(f"/v1/chats/{direct['id']}/members/{b.id}").status_code == 404


# --- event chats ---

def test_event_chats(client):
    organizer, admin, guest = User(client, "Organizer"), User(client, "Helper"), User(client, "Guest")
    event = new_event(organizer).json()
    chat = f"event:{event['id']}"
    for person in (admin, guest):
        assert person.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert organizer.get(f"/v1/chats/{chat}").json()["role"] == "owner"
    assert guest.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 403
    assert organizer.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    assert admin.patch(f"/v1/chats/{chat}", {"title": "New"}).status_code == 400  # named after its event
    assert admin.patch(f"/v1/chats/{chat}", {"readOnly": True}).status_code == 200
    assert admin.patch(f"/v1/chats/{chat}", {"readOnly": False}).status_code == 200
    # Removed from the chat: out of the event, for good
    assert guest.delete(f"/v1/chats/{chat}/members/{admin.id}").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/members/{organizer.id}").status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/members/{guest.id}").status_code == 204
    assert guest.get(f"/v1/chats/{chat}").status_code == 404
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 403
    assert guest.get(f"/v1/events/{event['id']}").json()["following"] is False
    # Leaving the chat leaves the event, and one may come back
    assert admin.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert admin.get(f"/v1/events/{event['id']}").json()["following"] is False
    assert admin.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert admin.get(f"/v1/chats/{chat}").json()["role"] == "member"  # no role kept from before
    # The organizer cannot leave their own event's chat, nor be deleted as a group
    assert organizer.delete(f"/v1/chats/{chat}/members/me").status_code == 403
    assert organizer.delete(f"/v1/chats/{chat}").status_code == 404


def test_a_huge_chat_lists_the_people_who_run_it_first(user, other, monkeypatch):
    from app import domain
    monkeypatch.setattr(domain, "MAX_MEMBERS_SHOWN", 1)
    event = new_event(user).json()
    assert other.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    chat = user.get(f"/v1/chats/event:{event['id']}").json()
    assert [member["user"]["id"] for member in chat["members"]] == [user.id]
    assert chat["memberCount"] == 2

