# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""What happens when features meet, and when someone tries to get around them: every test
is something a person could do, and what must hold whatever they do."""

import asyncio
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import LAT, LON, User, iso_in, jpeg, new_event, token_for
from PIL import Image
from test_security import _storage_put

from app import auth, domain, notifications, promotions, realtime
from app.realtime import presences, update_presence
from app.store import store
from app.util import DAY, HOUR, now_ms, offset


def connect(a, b):
    store.connect(a.id, b.id, None)


def group(owner, *people):
    for person in people:
        connect(owner, person)
    return owner.post("/v1/chats", {"title": "G", "memberIds": [p.id for p in people]}).json()["id"]


def say(person, chat, text, cid=None):
    return person.post(f"/v1/chats/{chat}/messages", {"text": text, "clientId": cid or text})


def texts(person, chat):
    return [m["text"] for m in person.get(f"/v1/chats/{chat}/messages").json()["items"] if not m["system"]]


def stand(person, metres=0, base=(LAT, LON), mode="visible"):
    lat, lon = offset(base[0], base[1], metres, 0)
    update_presence(person.id, mode, {"latitude": lat, "longitude": lon})


def leave_map(*people):
    for person in people:
        update_presence(person.id, "invisible", None)


def started(user, event_id):
    store.events[event_id].start = now_ms() - 60_000


def next_frame(ws, seconds=3):
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return json.loads(pool.submit(ws.receive_text).result(timeout=seconds))
    finally:
        pool.shutdown(wait=False)


def open_socket(person):
    ws = person.client.websocket_connect("/v1/ws")
    ws.__enter__()
    ws.send_text(json.dumps({"type": "auth", "token": person.token}))
    assert next_frame(ws)["type"] == "ready"
    return ws


def frames_until(ws, kind, seconds=3):
    while True:
        frame = next_frame(ws, seconds)
        if frame.get("type") == kind:
            return frame


# --- blocking and running a group ---

def test_blocking_the_owner_of_a_group_is_leaving_it(client):
    # Otherwise whoever blocks the owner keeps writing to the others, unseen by who runs it
    owner, member, other = User(client), User(client), User(client)
    chat = group(owner, member, other)
    assert member.put(f"/v1/me/blocks/{owner.id}").status_code == 204
    assert member.get(f"/v1/chats/{chat}").status_code == 404
    assert say(member, chat, "you cannot see this").status_code == 404
    assert member.id not in [m["user"]["id"] for m in other.get(f"/v1/chats/{chat}").json()["members"]]


def test_blocking_leaves_no_role_behind(client):
    owner, admin = User(client), User(client)
    chat = group(owner, admin)
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    assert owner.put(f"/v1/me/blocks/{admin.id}").status_code == 204
    assert owner.delete(f"/v1/me/blocks/{admin.id}").status_code == 204
    connect(owner, admin)
    assert owner.post(f"/v1/chats/{chat}/members", {"userIds": [admin.id]}).status_code == 200
    assert admin.get(f"/v1/chats/{chat}").json()["role"] == "member"


def test_what_a_blocked_person_did_is_gone_from_the_notifications(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer).json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert organizer.get("/v1/me/notifications").json()["unread"] >= 1
    assert organizer.put(f"/v1/me/blocks/{guest.id}").status_code == 204
    answer = organizer.get("/v1/me/notifications").json()
    assert all(guest.id not in [a["id"] for a in n["actors"]] for n in answer["items"])
    assert answer["unread"] == sum(1 for n in answer["items"] if not n["read"])
    assert organizer.get("/v1/me").json()["unreadNotifications"] == answer["unread"]


def test_an_invitation_ends_with_a_block(client):
    a, b = User(client), User(client)
    stand(a), stand(b, 5)
    try:
        invite = realtime.send_invite(a.id, b.id)["invite"]
        assert b.put(f"/v1/me/blocks/{a.id}").status_code == 204
        with pytest.raises(Exception):
            realtime.answer_invite(b.id, invite, True)
    finally:
        leave_map(a, b)


def test_a_blocked_author_can_still_take_back_what_they_wrote_or_posted(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer).json()
    event_id = event["id"]
    assert guest.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    started(organizer, event_id)
    assert guest.post(f"/v1/events/{event_id}/ratings", {"rating": 3, "comment": "bad"}).status_code == 201
    ticket = guest.post("/v1/uploads", {"purpose": "event-photo", "eventId": event_id, "mimeType": "image/jpeg", "fileSize": len(jpeg())}).json()
    assert _storage_put(guest.client, ticket, jpeg()).status_code == 200
    photo = guest.post(f"/v1/events/{event_id}/photos", {"uploadId": ticket["uploadId"]}).json()
    assert organizer.put(f"/v1/me/blocks/{guest.id}").status_code == 204
    assert guest.delete(f"/v1/events/{event_id}/photos/{photo['id']}").status_code == 204
    assert guest.delete(f"/v1/events/{event_id}/ratings/me").status_code == 204


# --- who knows what someone does ---

def test_leaving_an_event_tells_nobody_who_may_not_know_they_were_going(client):
    organizer, private, stranger = User(client), User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    for person in (private, stranger):
        assert person.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert private.delete(f"/v1/events/{event_id}/followers/me").status_code == 200
    words = [m["text"] for m in stranger.get(f"/v1/chats/event:{event_id}/messages").json()["items"]]
    assert not any(store.users[private.id].name in text for text in words)


def test_being_removed_from_an_event_is_not_told_to_strangers_either(client):
    organizer, private, stranger = User(client), User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    for person in (private, stranger):
        assert person.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert organizer.delete(f"/v1/chats/event:{event_id}/members/{private.id}").status_code == 204
    words = [m["text"] for m in stranger.get(f"/v1/chats/event:{event_id}/messages").json()["items"]]
    assert not any(store.users[private.id].name in text for text in words)


def test_who_may_add_photos_says_nothing_about_who_is_going(client):
    organizer, chosen, stranger = User(client), User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    assert chosen.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert organizer.put(f"/v1/events/{event_id}/photos/settings", {"whoCanPost": "chosen", "contributors": [chosen.id]}).status_code == 200
    assert stranger.get(f"/v1/events/{event_id}").json()["album"]["contributors"] == []
    assert stranger.get(f"/v1/events/{event_id}/photos").json()["settings"]["contributors"] == []
    # Who was chosen knows it, and the organizer sees all
    assert chosen.get(f"/v1/events/{event_id}").json()["album"]["contributors"] == [chosen.id]
    assert organizer.get(f"/v1/events/{event_id}").json()["album"]["contributors"] == [chosen.id]


def test_a_handle_never_shows_the_email_it_was_made_from(client):
    sub = "t-email-handle"
    token = token_for(sub)
    # What Logto says: no username, no name, only the email
    answer = client.get("/v1/me", headers={"Authorization": f"Bearer {token}", "X-Profile-Hint": '{"email": "mario.rossi.1987@example.com"}'}).json()
    assert "mario" not in answer["username"] and "rossi" not in answer["username"]
    assert "Mario" not in answer["name"] and "Rossi" not in answer["name"]
    store.users.pop(sub, None)


# --- what a deleted account leaves ---

def test_a_code_of_a_deleted_account_connects_nobody(client):
    host, guest = User(client), User(client)
    token = host.post("/v1/connections/sessions", {"location": None}).json()["token"]
    assert host.delete("/v1/me").status_code == 204
    assert guest.post("/v1/connections/claims", {"token": token, "location": None}).status_code == 410
    assert host.id not in store.connections.get(guest.id, {})


def test_a_deleted_organizer_takes_their_event_off_the_maps_around(client):
    organizer, viewer = User(client), User(client)
    event = new_event(organizer).json()
    location = event["location"]
    assert viewer.get(f"/v1/events?latitude={location['latitude']}&longitude={location['longitude']}").status_code == 200
    ws = open_socket(viewer)
    try:
        assert organizer.delete("/v1/me").status_code == 204
        assert frames_until(ws, "events.stale")
    finally:
        ws.__exit__(None, None, None)


def test_a_deleted_person_stays_on_no_map_and_in_no_memory(client):
    gone, other = User(client), User(client)
    stand(gone), stand(other, 5)
    realtime._pinned.setdefault(other.id, {})[gone.id] = float("inf")
    assert gone.delete("/v1/me").status_code == 204
    try:
        assert gone.id not in presences
        assert gone.id not in realtime._pinned.get(other.id, {})
        assert gone.id not in realtime.seen
    finally:
        leave_map(other)
        realtime._pinned.pop(other.id, None)


# --- what a phone can say on the socket ---

@pytest.mark.parametrize("fields", [
    {"heading": 1e300}, {"speed": 1e300}, {"heading": -5}, {"speed": -3}, {"accuracy": -1}, {"heading": 720},
])
def test_numbers_out_of_their_range_reach_nobody(client, fields):
    # A heading of 10^300 used to stop the socket of everyone who could see that person
    attacker, viewer = User(client), User(client)
    base = (LAT + 0.5, LON + 0.5)
    stand(viewer, 0, base)
    ws = open_socket(viewer)
    try:
        ws.send_text(json.dumps({"type": "presence", "mode": "visible", "position": {"latitude": base[0], "longitude": base[1]}}))
        frames_until(ws, "presence.snapshot")
        update_presence(attacker.id, "visible", {"latitude": base[0], "longitude": base[1]})
        attack = open_socket(attacker)
        attack.send_text(json.dumps({"type": "presence", "mode": "visible", "position": {"latitude": base[0], "longitude": base[1], **fields}}))
        seen = None
        for _ in range(6):
            frame = next_frame(ws)
            person = next((p for p in frame.get("people", []) if p["userId"] == attacker.id), None)
            if person:
                seen = person
                break
        attack.__exit__(None, None, None)
        assert seen is not None
        for value, low, high in ((seen["heading"], 0, 360), (seen["speed"], 0, 150)):
            assert value is None or low <= value <= high
    finally:
        ws.__exit__(None, None, None)
        leave_map(attacker, viewer)


# --- how often one person can disturb everyone else ---

def test_running_a_chat_cannot_flood_it(client, monkeypatch):
    from app import limits
    owner, member = User(client), User(client)
    chat = group(owner, member)
    monkeypatch.setitem(limits.RULES, "chat-edit", (3, 3600))
    answers = [owner.patch(f"/v1/chats/{chat}", {"readOnly": n % 2 == 0}).status_code for n in range(5)]
    assert 429 in answers
    limits._hits.pop((owner.id, "chat-edit"), None)


def test_one_person_has_a_limit_of_connections_saved_events_and_blocks(client, monkeypatch):
    from app.routes import events as events_routes, social
    monkeypatch.setattr(social, "CONNECTIONS_MAX", 1)
    monkeypatch.setattr(social, "BLOCKS_MAX", 1)
    monkeypatch.setattr(events_routes, "SAVED_MAX", 1)
    a, b, c, organizer = User(client), User(client), User(client), User(client)
    # New accounts come with the demo world here: each starts with nobody
    for person in (a, b, c):
        store.blocks.pop(person.id, None)
        store.saved.pop(person.id, None)
    # Connections
    connect(a, b)
    token = a.post("/v1/connections/sessions", {"location": None}).json()["token"]
    answer = c.post("/v1/connections/claims", {"token": token, "location": None})
    assert answer.status_code == 409 and answer.json()["code"] == "too_many_connections"
    # Blocks
    assert c.put(f"/v1/me/blocks/{a.id}").status_code == 204
    assert c.put(f"/v1/me/blocks/{b.id}").status_code == 409
    # Saved events
    first, second = new_event(organizer).json()["id"], new_event(organizer).json()["id"]
    assert a.put(f"/v1/events/{first}/saved/me").status_code == 200
    assert a.put(f"/v1/events/{second}/saved/me").status_code == 409


# --- pictures that are built to hurt ---

@pytest.mark.parametrize("size", [(1, 1), (60000, 1), (1, 60000), (4, 8000)])
def test_strange_shapes_of_pictures_never_break_the_server(user, size):
    buffer = io.BytesIO()
    Image.new("L", size).save(buffer, "PNG", optimize=False)
    data = buffer.getvalue()
    ticket = user.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/png", "fileSize": len(data)}).json()
    assert _storage_put(user.client, ticket, data).status_code == 200
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code in (200, 422)


@pytest.mark.parametrize("data", [
    b"\xff\xd8\xff" + b"\x00" * 200,
    jpeg()[:200],
    b"\x89PNG\r\n\x1a\n" + b"\x00" * 200,
    b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 200,
])
def test_broken_files_are_refused_not_a_crash(user, data):
    ticket = user.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": len(data)}).json()
    assert _storage_put(user.client, ticket, data).status_code == 200
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 422


# --- money ---

def test_a_long_event_made_short_loses_its_discount(user):
    # Promoted as 8 days (30% off), then cut to one evening: not at that price any more
    event = new_event(user, dates={"startDate": iso_in(1), "endDate": iso_in(24 * 8)}).json()
    store.wallet(user.id).balance = 100_000
    assert user.put(f"/v1/events/{event['id']}/promotion", {"radius": 10000}).status_code == 200
    discounted = store.promotions[event["id"]].daily
    assert user.patch(f"/v1/events/{event['id']}", {"dates": {"startDate": iso_in(1), "endDate": iso_in(4)}}).status_code == 200
    assert store.promotions[event["id"]].daily > discounted
    # Nor is more paid than the event lasts: the rest came back
    assert store.promotions[event["id"]].paid_until == store.events[event["id"]].end


def test_a_refund_after_spending_never_makes_credits_out_of_nothing(user):
    wallet = store.wallet(user.id)
    assert promotions.credit_purchase(user.id, "ios", "tx-1", "promo.credits.999") is True
    # Sent again after a lost answer: credited once
    assert promotions.credit_purchase(user.id, "ios", "tx-1", "promo.credits.999") is False
    assert wallet.balance == 999
    wallet.balance -= 900
    promotions.reverse_purchase("ios", "tx-1")
    promotions.reverse_purchase("ios", "tx-1")
    assert wallet.balance == -900


# --- an event's life ---

def test_what_has_ended_or_was_cancelled_takes_nothing_new(user, other):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    assert other.put(f"{path}/followers/me").status_code == 200
    assert user.delete(path).status_code == 200
    assert user.patch(path, {"title": "again"}).status_code == 410
    assert user.patch(path, {"theme": {"beamStyle": "helix"}}).status_code == 410
    assert other.post(f"{path}/ratings", {"rating": 5, "comment": ""}).status_code == 403
    assert user.put(f"{path}/promotion", {"radius": 1000}).status_code in (402, 410)
    assert other.post("/v1/uploads", {"purpose": "event-photo", "eventId": event["id"], "mimeType": "image/jpeg", "fileSize": 10}).status_code == 403
    assert other.get(f"/v1/chats/event:{event['id']}").status_code == 404
    assert say(other, f"event:{event['id']}", "hello?").status_code == 404
    # Nor by the same Idempotency-Key, nor does it free more than its place
    assert user.delete(path).status_code == 200


def test_an_event_cannot_be_kept_alive_for_ever_by_moving_it(user):
    # Starting within 31 days and lasting 31: moved on again and again it would stay on the
    # map for good. An event not started yet may move; one under way keeps its start
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    store.events[event["id"]].start = now_ms() - HOUR
    moved = user.patch(path, {"dates": {"startDate": iso_in(24), "endDate": iso_in(25)}})
    assert moved.status_code == 400


# --- a second round: what those fixes make one think of ---

def test_an_admin_cannot_add_someone_the_owner_cannot_see(client):
    owner, admin, enemy = User(client), User(client), User(client)
    chat = group(owner, admin)
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    connect(admin, enemy)
    assert enemy.put(f"/v1/me/blocks/{owner.id}").status_code == 204
    assert admin.post(f"/v1/chats/{chat}/members", {"userIds": [enemy.id]}).status_code == 403


def test_who_joined_later_cannot_vote_a_poll_they_cannot_see(client):
    owner, late = User(client), User(client)
    chat = group(owner)
    poll = owner.post(f"/v1/chats/{chat}/polls", {"question": "Q", "options": ["a", "b"]}).json()
    connect(owner, late)
    assert owner.post(f"/v1/chats/{chat}/members", {"userIds": [late.id]}).status_code == 200
    assert late.post(f"/v1/chats/{chat}/polls/{poll['id']}/votes", {"optionIds": ["o1"]}).status_code == 404
    # Nor report a message they never saw
    said = owner.post(f"/v1/chats/{chat}/messages", {"text": "x", "clientId": "x"})
    assert said.status_code == 201


def test_joining_an_event_does_not_count_its_whole_chat_as_new(client):
    organizer, guest = User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    for n in range(5):
        assert say(organizer, f"event:{event_id}", f"m{n}").status_code == 201
    assert guest.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    chat = guest.get(f"/v1/chats/event:{event_id}").json()
    assert chat["unread"] == 0 and chat["lastMessage"]["text"] == "m4"
    assert say(organizer, f"event:{event_id}", "new").status_code == 201
    assert guest.get(f"/v1/chats/event:{event_id}").json()["unread"] == 1


def test_notifications_about_something_gone_do_not_break_the_list(client):
    organizer, guest = User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    assert guest.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert organizer.patch(f"/v1/events/{event_id}", {"location": {"latitude": LAT - 1, "longitude": LON - 1}}).status_code == 200
    assert guest.get("/v1/me/notifications").json()["unread"] >= 1
    assert organizer.delete("/v1/me").status_code == 204
    answer = guest.get("/v1/me/notifications")
    assert answer.status_code == 200
    assert all(n["event"] is None or n["event"]["id"] != event_id for n in answer.json()["items"])
    assert guest.get("/v1/me/events").json()["followed"] == []


def test_nobody_is_written_to_after_a_disconnection_even_standing_next_to_them(client):
    a, b = User(client), User(client)
    connect(a, b)
    chat = a.post("/v1/chats/direct", {"userId": b.id}).json()["id"]
    stand(a), stand(b, 5)
    try:
        assert a.delete(f"/v1/me/connections/{b.id}").status_code == 204
        assert say(a, chat, "still here?").status_code == 403
        assert say(b, chat, "and me?").status_code == 403
        # Unblocking does not give it back either
        assert a.put(f"/v1/me/blocks/{b.id}").status_code == 204
        assert a.delete(f"/v1/me/blocks/{b.id}").status_code == 204
        assert say(a, chat, "again?").status_code == 403
    finally:
        leave_map(a, b)


def test_an_invisible_person_can_be_reached_by_nobody_new(client):
    near, hidden = User(client), User(client)
    stand(near), stand(hidden, 5, mode="invisible")
    try:
        assert near.post("/v1/chats/direct", {"userId": hidden.id}).status_code == 403
        with pytest.raises(Exception):
            realtime.send_gesture(near.id, hidden.id, "wave")
        with pytest.raises(Exception):
            realtime.send_invite(near.id, hidden.id)
        assert near.get(f"/v1/users/{hidden.id}").json()["relation"]["canMessage"] is False
    finally:
        leave_map(near, hidden)


def test_an_approximate_person_never_gives_away_where_they_really_are(client):
    viewer, shy = User(client), User(client)
    stand(viewer), stand(shy, 120, mode="approximate")
    try:
        view = realtime.visible_to(viewer.id)
        entry = next(e for e in view if e[0].user_id == shy.id)
        assert entry[1] == "area"
        shown = realtime._shown(entry[0], entry[1])
        assert shown[3:] == (None, None, None)
        real = (presences[shy.id].latitude, presences[shy.id].longitude)
        assert (shown[1], shown[2]) != (round(real[0], 6), round(real[1], 6))
    finally:
        leave_map(viewer, shy)


def test_a_removed_person_cannot_come_back_through_another_door(client):
    organizer, guest = User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    assert guest.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert organizer.delete(f"/v1/chats/event:{event_id}/members/{guest.id}").status_code == 204
    assert guest.put(f"/v1/events/{event_id}/followers/me").status_code == 403
    assert guest.get(f"/v1/chats/event:{event_id}").status_code == 404
    assert say(guest, f"event:{event_id}", "hi").status_code == 404
    started(organizer, event_id)
    assert guest.post("/v1/uploads", {"purpose": "event-photo", "eventId": event_id, "mimeType": "image/jpeg", "fileSize": 10}).status_code == 403
    assert guest.post(f"/v1/events/{event_id}/ratings", {"rating": 1, "comment": ""}).status_code == 403


def test_a_role_cannot_climb(client):
    owner, admin, member = User(client), User(client), User(client)
    chat = group(owner, admin, member)
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    # An admin names nobody, touches no other admin nor the owner, deletes nothing of theirs
    assert admin.put(f"/v1/chats/{chat}/members/{member.id}/role", {"role": "admin"}).status_code == 403
    assert admin.delete(f"/v1/chats/{chat}/members/{owner.id}").status_code == 403
    assert admin.put(f"/v1/chats/{chat}/members/{owner.id}/mute", {"minutes": 60}).status_code == 403
    assert admin.delete(f"/v1/chats/{chat}").status_code == 403
    # A member nothing at all
    for call in (member.patch(f"/v1/chats/{chat}", {"title": "mine"}), member.delete(f"/v1/chats/{chat}/members/{admin.id}"),
                 member.put(f"/v1/chats/{chat}/pins/x"), member.post(f"/v1/chats/{chat}/polls", {"question": "q", "options": ["a", "b"]})):
        assert call.status_code == 403
    # Muted, an admin writes nothing either until someone unmutes them: only the owner can mute them
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/mute", {"minutes": 60}).status_code == 200
    assert say(admin, chat, "still me").status_code == 403


def test_what_someone_else_owns_stays_theirs(client):
    owner, other = User(client), User(client)
    event_id = new_event(owner).json()["id"]
    path = f"/v1/events/{event_id}"
    assert other.patch(path, {"title": "mine"}).status_code == 403
    assert other.delete(path).status_code == 403
    assert other.put(f"{path}/promotion", {"radius": 1000}).status_code == 403
    assert other.get(f"{path}/promotion/quote?radius=1000").status_code == 403
    assert other.put(f"{path}/photos/settings", {"whoCanPost": "everyone"}).status_code == 403
    session = owner.post("/v1/connections/sessions", {"location": None}).json()["sessionId"]
    for call in (other.get(f"/v1/connections/sessions/{session}"), other.delete(f"/v1/connections/sessions/{session}"),
                 other.post(f"/v1/connections/sessions/{session}/token", {"location": None})):
        assert call.status_code == 404
    # Another account's upload, purchase or token
    ticket = owner.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": len(jpeg())}).json()
    assert _storage_put(owner.client, ticket, jpeg()).status_code == 200
    assert other.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 400


def test_someone_who_keeps_it_private_is_named_nowhere(client):
    private, stranger, organizer = User(client), User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    assert private.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    assert stranger.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    page = stranger.get(f"/v1/events/{event_id}").json()
    assert private.id not in [p["id"] for p in page["followers"]]
    assert private.id not in [m["user"]["id"] for m in stranger.get(f"/v1/chats/event:{event_id}").json()["members"]]
    assert stranger.get(f"/v1/users/{private.id}/activity").json()["items"] == []
    assert stranger.get(f"/v1/users/{private.id}/events").json()["items"] == []
    assert stranger.get(f"/v1/users/{private.id}/connections").json()["items"] == []
    assert private.id not in json.dumps(page)


def test_a_chat_nobody_wrote_in_does_not_fill_the_list_of_who_never_heard_from_them(client):
    opener, other = User(client), User(client)
    stand(opener), stand(other, 5)
    try:
        chat = opener.post("/v1/chats/direct", {"userId": other.id}).json()["id"]
        assert chat in [c["id"] for c in opener.get("/v1/chats").json()["items"]]
        assert chat not in [c["id"] for c in other.get("/v1/chats").json()["items"]]
        assert say(opener, chat, "hello").status_code == 201
        assert chat in [c["id"] for c in other.get("/v1/chats").json()["items"]]
    finally:
        leave_map(opener, other)


def test_who_was_going_hears_when_an_organizer_deletes_their_account(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer, title="Picnic").json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert organizer.delete("/v1/me").status_code == 204
    notice = next(n for n in guest.get("/v1/me/notifications").json()["items"] if n["kind"] == "event.cancelled")
    assert notice["event"] is None and notice["data"]["title"] == "Picnic"


def test_nobody_joins_every_event_there_is(user, other, monkeypatch):
    from app.routes import events as events_routes
    monkeypatch.setattr(events_routes, "JOINED_MAX", 1)
    first, second = new_event(user).json()["id"], new_event(user).json()["id"]
    store.followers.update({k: v for k, v in store.followers.items() if other.id not in v})
    for followers in store.followers.values():
        followers.pop(other.id, None)
    assert other.put(f"/v1/events/{first}/followers/me").status_code == 200
    answer = other.put(f"/v1/events/{second}/followers/me")
    assert answer.status_code == 409 and answer.json()["code"] == "too_many_joined"


def test_the_beam_of_an_event_is_its_own_colour(user):
    theme = {"color": "#4D78BF", "beam": "#FF5FA2", "beamStyle": "helix"}
    event = new_event(user, theme=theme).json()
    assert event["theme"]["color"] == "#4D78BF" and event["theme"]["beam"] == "#FF5FA2"
    assert event["theme"]["beamStyle"] == "helix"
    assert user.get(f"/v1/events/{event['id']}").json()["theme"]["beam"] == "#FF5FA2"


def test_a_theme_is_replaced_whole_and_its_colours_kept_as_sent(user):
    theme = {"color": "#4d78bf", "beam": "#FF5FA2", "beamStyle": "veil", "emoji": "🎉", "background": "glow", "title": "bold"}
    event = new_event(user, theme=theme).json()
    assert event["theme"] == theme
    path = f"/v1/events/{event['id']}"
    answer = user.patch(path, {"theme": {"beam": "#22D3C5", "unknown": True}}).json()["theme"]
    assert answer == {"color": None, "beam": "#22D3C5", "beamStyle": "beam", "emoji": None, "background": "plain", "title": "classic"}
    assert user.patch(path, {"theme": None}).json()["theme"] is None


def test_changing_the_look_alone_tells_nobody(user, other):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    assert other.put(f"{path}/followers/me").status_code == 200
    notifications_of_other = lambda: other.get("/v1/me/notifications")
    before = notifications_of_other()
    assert before.status_code == 200
    assert user.patch(path, {"theme": {"beamStyle": "helix"}}).status_code == 200
    assert notifications_of_other().json() == before.json()
    # A new time is told: the check above would see it
    assert user.patch(path, {"dates": {"startDate": iso_in(3), "endDate": iso_in(4)}}).status_code == 200
    assert notifications_of_other().json() != before.json()


def test_the_look_of_what_took_place_stays_as_it_was(user):
    event = new_event(user).json()
    store.events[event["id"]].end = now_ms() - 1000
    answer = user.patch(f"/v1/events/{event['id']}", {"theme": {"beam": "#FF5FA2"}})
    assert answer.status_code == 410 and answer.json()["code"] == "gone"


@pytest.mark.parametrize("field", ["links", "theme"])
def test_values_of_the_wrong_type_are_refused_not_a_crash(user, field):
    bad = {"links": True, "theme": {"emoji": True}}[field]
    assert new_event(user, **{field: bad}).status_code in (400, 201)
    assert new_event(user, location={"latitude": 1.0, "longitude": 1.0, "address": True}).status_code in (400, 201)


# --- who takes a group over ---

def _owned_group(client):
    owner, senior, admin, junior = User(client), User(client), User(client), User(client)
    connect(owner, senior)
    chat = owner.post("/v1/chats", {"title": "G", "memberIds": [senior.id]}).json()["id"]
    for person in (admin, junior):
        connect(owner, person)
        assert owner.post(f"/v1/chats/{chat}/members", {"userIds": [person.id]}).status_code == 200
    return owner, senior, admin, junior, chat


def test_the_owner_leaving_hands_the_group_to_the_admin_here_longest(client):
    owner, senior, admin, junior, chat = _owned_group(client)
    assert owner.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    assert owner.put(f"/v1/chats/{chat}/members/{junior.id}/role", {"role": "admin"}).status_code == 200
    assert owner.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert owner.get(f"/v1/chats/{chat}").status_code == 404
    # An admin, the one here longest; not the member who came first
    view = admin.get(f"/v1/chats/{chat}").json()
    assert view["role"] == "owner" and view["ownerId"] == admin.id
    assert senior.get(f"/v1/chats/{chat}").json()["role"] == "member"
    said = [m["text"] for m in senior.get(f"/v1/chats/{chat}/messages").json()["items"] if m["system"]]
    # As it happened: who left, then who took over
    assert said[-2].endswith(" left") and said[-1].endswith(" now runs the group")


def test_without_admins_it_goes_to_who_has_been_there_longest(client):
    owner, senior, admin, junior, chat = _owned_group(client)
    assert owner.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert senior.get(f"/v1/chats/{chat}").json()["role"] == "owner"
    # The new owner runs it: they name admins and can leave in turn
    assert senior.put(f"/v1/chats/{chat}/members/{admin.id}/role", {"role": "admin"}).status_code == 200
    assert senior.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert admin.get(f"/v1/chats/{chat}").json()["role"] == "owner"


def test_the_last_one_leaving_ends_the_group(client):
    owner = User(client)
    chat = owner.post("/v1/chats", {"title": "Alone", "memberIds": []}).json()["id"]
    assert owner.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert chat not in store.chats


def test_a_deleted_owner_leaves_the_group_and_what_the_others_said(client):
    owner, senior, admin, junior, chat = _owned_group(client)
    assert say(senior, chat, "mine").status_code == 201
    assert say(owner, chat, "theirs").status_code == 201
    assert owner.delete("/v1/me").status_code == 204
    view = senior.get(f"/v1/chats/{chat}").json()
    assert view["role"] == "owner"
    words = texts(senior, chat)
    assert "mine" in words and "theirs" not in words


def test_who_has_a_block_with_the_new_owner_leaves_with_the_handover(client):
    owner, senior, admin, junior, chat = _owned_group(client)
    assert junior.put(f"/v1/me/blocks/{senior.id}").status_code == 204
    assert owner.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    assert junior.get(f"/v1/chats/{chat}").status_code == 404
    assert senior.get(f"/v1/chats/{chat}").json()["memberCount"] == 2


def test_an_organizer_cannot_hand_over_an_event_by_leaving_its_chat(client):
    organizer = User(client)
    event_id = new_event(organizer).json()["id"]
    assert organizer.delete(f"/v1/chats/event:{event_id}/members/me").status_code == 403



def test_a_poll_closed_again_tells_nobody_again(user, monkeypatch):
    from app import routes
    chat = user.post("/v1/chats", {"title": "Plans"}).json()
    poll = user.post(f"/v1/chats/{chat['id']}/polls", {"question": "When?", "options": ["Now", "Later"]}).json()
    path = f"/v1/chats/{chat['id']}/polls/{poll['id']}/close"
    told = []
    monkeypatch.setattr(routes.chats, "_poll_changed", lambda *args: told.append(args))
    assert user.post(path).status_code == 200
    assert user.post(path).status_code == 200
    assert len(told) == 1


def test_a_photo_does_not_say_who_went_to_who_may_not_know(client, user, other):
    event = new_event(user, dates={"startDate": iso_in(0.01), "endDate": iso_in(2)}).json()
    path = f"/v1/events/{event['id']}"
    assert other.put(f"{path}/followers/me").status_code == 200
    store.events[event["id"]].start = now_ms() - 60_000
    assert other.patch("/v1/me", {"storyAudience": "connections"}).status_code == 200
    ticket = other.post("/v1/uploads", {"purpose": "event-photo", "eventId": event["id"], "mimeType": "image/jpeg", "fileSize": len(jpeg())}).json()
    assert other.client.put(ticket["uploadUrl"], content=jpeg()).status_code == 200
    posted = other.post(f"{path}/photos", {"uploadId": ticket["uploadId"]})
    assert posted.status_code == 201 and posted.json()["author"]["id"] == other.id
    stranger = User(client)
    assert stranger.get(f"{path}/photos").json()["items"][0]["author"] is None
    assert user.get(f"{path}/photos").json()["items"][0]["author"]["id"] == other.id
    # Who was going when it was added is told of it, without the name
    third = User(client)
    assert third.put(f"{path}/followers/me").status_code == 200
    ticket = other.post("/v1/uploads", {"purpose": "event-photo", "eventId": event["id"], "mimeType": "image/jpeg", "fileSize": len(jpeg())}).json()
    assert other.client.put(ticket["uploadUrl"], content=jpeg()).status_code == 200
    assert other.post(f"{path}/photos", {"uploadId": ticket["uploadId"]}).status_code == 201
    entry = next(n for n in third.get("/v1/me/notifications").json()["items"] if n["kind"] == "album.photos")
    assert entry["actors"] == []
    organizer_entry = next(n for n in user.get("/v1/me/notifications").json()["items"] if n["kind"] == "album.photos")
    assert organizer_entry["actors"][0]["id"] == other.id


def test_a_theme_symbol_is_not_words(user):
    assert new_event(user, theme={"emoji": "BUY NOW"}).status_code == 400
    assert new_event(user, theme={"emoji": "🎉"}).status_code == 201
