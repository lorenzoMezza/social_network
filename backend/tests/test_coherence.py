# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Each of these was a real hole: who can sign in, what a block means everywhere, what
happens to an event's chat and album when someone leaves, and what stays of a deleted
account."""

import itertools
import json
import time

import jwt
import pytest

from conftest import LAT, LON, User, iso_in, new_event, token_for

from app import auth, config, domain, janitor
from app.store import store
from app.util import now_ms

_places = itertools.count()


def place():
    return {"latitude": LAT - 0.5 - next(_places) * 0.01, "longitude": LON}


def live_dates():
    return {"startDate": iso_in(-0.05), "endDate": iso_in(1)}


def connect(a, b):
    store.connect(a.id, b.id, None)


def frames_until(ws, kind, limit=200):
    seen = []
    for _ in range(limit):
        frame = json.loads(ws.receive_text())
        seen.append(frame)
        if frame["type"] == kind:
            return frame, seen
    raise AssertionError(f"no {kind} among {[f['type'] for f in seen]}")


def on_socket(person):
    ws = person.client.websocket_connect("/v1/ws")
    ws.__enter__()
    ws.send_text(json.dumps({"type": "auth", "token": person.token}))
    assert json.loads(ws.receive_text())["type"] == "ready"
    return ws


# --- who can sign in ---

@pytest.fixture
def real_verification(monkeypatch):
    """Tokens checked for real, with a Logto that does not know the token's key"""
    def unknown_key(_token):
        raise jwt.PyJWKClientError("Unable to find a signing key that matches")
    monkeypatch.setattr(auth, "_verify_jwt", unknown_key)


def test_a_made_up_token_never_signs_in(client, user, real_verification):
    # Written by anyone, naming a real person, with a key Logto does not know. Even on a
    # server trusting tokens while offline: Logto answered, it does not know this key
    assert config.TRUST_UNVERIFIED_TOKENS
    forged = jwt.encode({"sub": user.id, "exp": int(time.time()) + 3600}, "not-logto", algorithm="HS256", headers={"kid": "made-up"})
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_offline_trust_is_off_unless_asked_for(client, monkeypatch):
    def unreachable(_token):
        raise jwt.PyJWKClientConnectionError("no network")
    monkeypatch.setattr(auth, "_verify_jwt", unreachable)
    monkeypatch.setattr(config, "TRUST_UNVERIFIED_TOKENS", False)
    token = token_for("someone-new-" + str(time.time()))
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_with_an_api_resource_only_its_jwts_are_accepted(client, monkeypatch):
    monkeypatch.setattr(config, "API_RESOURCE", "https://api.example")
    assert client.get("/v1/me", headers={"Authorization": "Bearer opaque-token"}).status_code == 401


def test_the_defaults_are_safe(monkeypatch):
    import subprocess
    import sys
    code = "from app import config; print(config.DEV_TOOLS, config.TRUST_UNVERIFIED_TOKENS)"
    env = {key: value for key, value in __import__("os").environ.items() if key not in ("DEV_TOOLS", "TRUST_UNVERIFIED_TOKENS")}
    answer = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, check=True)
    assert answer.stdout.split() == ["False", "False"]


def test_production_refuses_an_unsafe_configuration(monkeypatch, tmp_path):
    problems = config.production_problems()
    assert any("TRUST_UNVERIFIED_TOKENS" in problem for problem in problems)
    assert any("DEV_TOOLS" in problem for problem in problems)
    assert any("API_RESOURCE" in problem for problem in problems)
    monkeypatch.setattr(config, "API_RESOURCE", "https://api.example")
    monkeypatch.setattr(config, "TRUST_UNVERIFIED_TOKENS", False)
    monkeypatch.setattr(config, "DEV_TOOLS", False)
    monkeypatch.setattr(config, "PUBLIC_URL", "https://api.example")
    monkeypatch.setattr(config, "ASSETS_URL", "https://assets.example")
    monkeypatch.setattr(config, "AVATAR_BAKE_SECRET", "secret")
    # Without the catalog any avatar would be taken as sent, and reach other people's phones
    monkeypatch.setattr(config, "AVATAR_LIBRARY", tmp_path)
    assert any("AVATAR_LIBRARY" in problem for problem in config.production_problems())
    (tmp_path / "catalog.json").write_text("{}")
    assert config.production_problems() == []


# --- a deleted account stays deleted ---

def test_a_deleted_account_is_not_made_again_by_an_old_token(client):
    person = User(client)
    token_before = person.token
    assert person.get("/v1/me").status_code == 200
    assert person.delete("/v1/me").status_code == 204
    # Another device, with a token that is still valid
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {token_before}"}).status_code == 401
    assert store.user(person.id) is None


def test_deleting_leaves_nothing_of_them_in_polls_or_roles(client):
    owner, gone = User(client), User(client)
    connect(owner, gone)
    chat = owner.post("/v1/chats", {"title": "Team", "memberIds": [gone.id]}).json()["id"]
    assert owner.put(f"/v1/chats/{chat}/members/{gone.id}/role", {"role": "admin"}).status_code == 200
    poll = owner.post(f"/v1/chats/{chat}/polls", {"question": "Where?", "options": ["A", "B"]}).json()["id"]
    assert gone.post(f"/v1/chats/{chat}/polls/{poll}/votes", {"optionIds": ["o1"]}).status_code == 200
    assert gone.delete("/v1/me").status_code == 204
    assert gone.id not in store.polls[poll].votes
    assert gone.id not in store.moderation[chat].admins


def test_a_deleted_owners_polls_go_and_the_group_goes_on(client):
    owner, member = User(client), User(client)
    connect(owner, member)
    chat = owner.post("/v1/chats", {"title": "Team", "memberIds": [member.id]}).json()["id"]
    poll = owner.post(f"/v1/chats/{chat}/polls", {"question": "Where?", "options": ["A", "B"]}).json()["id"]
    assert owner.delete("/v1/me").status_code == 204
    assert poll not in store.polls
    assert member.get(f"/v1/chats/{chat}").json()["role"] == "owner"


def test_a_deleted_owner_alone_in_a_group_ends_it(client):
    owner = User(client)
    chat = owner.post("/v1/chats", {"title": "Alone", "memberIds": []}).json()["id"]
    assert owner.delete("/v1/me").status_code == 204
    assert chat not in store.chats and chat not in store.moderation


# --- blocking means it everywhere ---

def test_nothing_of_a_blocked_person_shows_in_the_chat_list(client):
    organizer, a, b = User(client), User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    chat = f"event:{event['id']}"
    for person in (a, b):
        assert person.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert a.post(f"/v1/chats/{chat}/messages", {"text": "From a"}).status_code == 201
    assert b.post(f"/v1/chats/{chat}/messages", {"text": "From b"}).status_code == 201
    before = a.get(f"/v1/chats/{chat}").json()
    assert before["lastMessage"]["text"] == "From b"
    assert before["unread"] == 1
    assert a.put(f"/v1/me/blocks/{b.id}").status_code == 204
    after = a.get(f"/v1/chats/{chat}").json()
    assert after["lastMessage"]["text"] != "From b"
    assert after["unread"] == 0


def test_blocking_the_organizer_ends_going_to_their_events(client):
    organizer, guest = User(client), User(client)
    live = new_event(organizer, location=place(), dates=live_dates()).json()
    assert guest.put(f"/v1/events/{live['id']}/followers/me").status_code == 200
    assert guest.put(f"/v1/me/blocks/{organizer.id}").status_code == 204
    # Not left in the chat of an event they can no longer open
    assert guest.get(f"/v1/chats/event:{live['id']}").status_code == 404
    assert guest.id not in store.followers[live["id"]]
    # Nor the other way: the organizer who blocks a guest
    other_guest = User(client)
    assert other_guest.put(f"/v1/events/{live['id']}/followers/me").status_code == 200
    assert organizer.put(f"/v1/me/blocks/{other_guest.id}").status_code == 204
    assert other_guest.id not in store.followers[live["id"]]


# --- leaving and being removed from an event ---

def test_leaving_from_the_page_or_the_chat_is_the_same(client):
    organizer, by_page, by_chat = User(client), User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    chat = f"event:{event['id']}"
    for person in (by_page, by_chat):
        assert person.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert by_page.delete(f"/v1/events/{event['id']}/followers/me").json()["following"] is False
    assert by_chat.delete(f"/v1/chats/{chat}/members/me").status_code == 204
    # The same, and nobody told: naming them would say who was going
    assert not by_page.get(f"/v1/events/{event['id']}").json()["following"]
    assert not by_chat.get(f"/v1/events/{event['id']}").json()["following"]
    texts = [m["text"] for m in organizer.get(f"/v1/chats/{chat}/messages").json()["items"]]
    assert sum(text.endswith(" left") for text in texts) == 0


def test_who_is_removed_is_told_and_their_phone_knows(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    ws = on_socket(guest)
    try:
        assert organizer.delete(f"/v1/chats/event:{event['id']}/members/{guest.id}").status_code == 204
        frame, _ = frames_until(ws, "event")
        assert frame["event"]["following"] is False
    finally:
        ws.__exit__(None, None, None)
    kinds = [n["kind"] for n in guest.get("/v1/me/notifications").json()["items"]]
    assert "event.removed" in kinds
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 403


def test_who_left_adds_no_more_photos_even_if_chosen(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert organizer.put(f"/v1/events/{event['id']}/photos/settings", {"whoCanPost": "chosen", "contributors": [guest.id]}).status_code == 200
    ticket = {"purpose": "event-photo", "eventId": event["id"], "mimeType": "image/jpeg", "fileSize": 1000}
    assert guest.post("/v1/uploads", ticket).status_code == 200
    assert guest.delete(f"/v1/events/{event['id']}/followers/me").status_code == 200
    assert guest.post("/v1/uploads", ticket).status_code == 403
    assert guest.id not in store.album(event["id"]).contributors


# --- a chat that closed with its event ---

def over(event_id):
    store.events[event_id].end = now_ms() - 1000
    store.events[event_id].start = store.events[event_id].end - 3_600_000


def test_a_closed_event_chat_cannot_be_run(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    over(event["id"])
    chat = f"event:{event['id']}"
    # Removing someone now would also erase that they went
    assert organizer.delete(f"/v1/chats/{chat}/members/{guest.id}").status_code == 404
    assert organizer.put(f"/v1/chats/{chat}/members/{guest.id}/mute", {"minutes": 60}).status_code == 404
    assert organizer.patch(f"/v1/chats/{chat}", {"readOnly": True}).status_code == 404
    assert guest.id in store.followers[event["id"]]


def test_the_chat_leaves_the_phones_when_the_event_ends(client):
    organizer, guest = User(client), User(client)
    event = new_event(organizer, location=place(), dates=live_dates()).json()
    assert guest.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    ws = on_socket(guest)
    try:
        store.events[event["id"]].end = now_ms() - 1000
        store.events[event["id"]].start = now_ms() - 3_600_000
        janitor.sweep()
        frame, _ = frames_until(ws, "chat.removed")
        assert frame["chatId"] == f"event:{event['id']}"
    finally:
        ws.__exit__(None, None, None)


# --- groups, connections, reminders ---

def test_adding_someone_is_said_in_the_group(client):
    owner, admin, friend = User(client), User(client), User(client)
    connect(owner, admin)
    connect(owner, friend)
    chat = owner.post("/v1/chats", {"title": "Team", "memberIds": [admin.id]}).json()["id"]
    assert owner.post(f"/v1/chats/{chat}/members", {"userIds": [friend.id]}).status_code == 200
    assert any(store.users[friend.id].name in m["text"] and "added" in m["text"] for m in admin.get(f"/v1/chats/{chat}/messages").json()["items"])


def test_nonsense_members_are_refused_not_a_crash(user):
    for bad in ([{"a": 1}], [["x"]], [1], "x"):
        assert user.post("/v1/chats", {"title": "T", "memberIds": bad}).status_code == 403, bad


def test_disconnecting_reaches_the_other_phone(client):
    a, b = User(client), User(client)
    connect(a, b)
    ws = on_socket(b)
    try:
        assert a.delete(f"/v1/me/connections/{b.id}").status_code == 204
        frame, _ = frames_until(ws, "connection.removed")
        assert frame["userId"] == a.id
    finally:
        ws.__exit__(None, None, None)


def test_moved_to_another_time_it_is_reminded_again(user):
    event = new_event(user, location=place()).json()
    store.reminded.add(event["id"])
    assert user.patch(f"/v1/events/{event['id']}", {"dates": {"startDate": iso_in(5), "endDate": iso_in(6)}}).status_code == 200
    assert event["id"] not in store.reminded


def test_a_report_leaves_no_empty_album_behind(user):
    fields = {"kind": "photo", "targetId": "x", "reasons": ["unrelated"]}
    assert user.post("/v1/reports", {**fields, "eventId": "no-such-event"}).status_code == 404
    assert "no-such-event" not in store.albums
    assert user.post("/v1/reports", {**fields, "eventId": {"a": 1}}).status_code == 404


def test_only_https_links_as_the_app_only_opens_those(user):
    assert new_event(user, location=place(), links="http://example.com").status_code == 400
    assert new_event(user, location=place(), links="https://example.com").status_code == 201


# --- a lost answer ---

def test_creating_twice_with_the_same_key_is_one_event(client):
    person = User(client)
    fields = {
        "title": "Test", "description": "A test event", "categories": ["party"], "location": place(),
        "dates": {"startDate": iso_in(1), "endDate": iso_in(2)},
    }
    first = client.post("/v1/events", json=fields, headers={"Authorization": f"Bearer {person.token}", "Idempotency-Key": "k1"})
    second = client.post("/v1/events", json=fields, headers={"Authorization": f"Bearer {person.token}", "Idempotency-Key": "k1"})
    assert first.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    # Without a key, it would be "too close" to the user's own event
    assert client.post("/v1/events", json=fields, headers={"Authorization": f"Bearer {person.token}"}).json()["code"] == "too_close"
    # Someone else's key is another thing
    other = User(client)
    answer = client.post("/v1/events", json={**fields, "location": place()}, headers={"Authorization": f"Bearer {other.token}", "Idempotency-Key": "k1"})
    assert answer.json()["id"] != first.json()["id"]


def test_a_photo_sent_twice_with_the_same_key_is_one_photo(client):
    from conftest import jpeg
    from test_scenarios import started
    from test_security import _storage_put, _ticket
    organizer = User(client)
    event_id = new_event(organizer).json()["id"]
    started(organizer, event_id)
    ticket = organizer.post("/v1/uploads", _ticket(event_id)).json()
    assert _storage_put(organizer.client, ticket, jpeg()).status_code == 200
    path = f"/v1/events/{event_id}/photos"
    headers = {"Authorization": f"Bearer {organizer.token}", "Idempotency-Key": "upload-k1"}
    first = client.post(path, json={"uploadId": ticket["uploadId"]}, headers=headers)
    # The answer was lost: the app names the same upload again, with the same key
    second = client.post(path, json={"uploadId": ticket["uploadId"]}, headers=headers)
    assert first.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    assert organizer.get(path).json()["total"] == 1
    # Without the key the upload is simply used: 410, which the app takes as "it was added"
    answer = organizer.post(path, {"uploadId": ticket["uploadId"]})
    assert (answer.status_code, answer.json()["code"]) == (410, "expired")


# --- abuse ---

def test_voting_without_end_is_limited(client):
    owner = User(client)
    chat = owner.post("/v1/chats", {"title": "Team", "memberIds": []}).json()["id"]
    poll = owner.post(f"/v1/chats/{chat}/polls", {"question": "Where?", "options": ["A", "B"]}).json()["id"]
    answers = [owner.post(f"/v1/chats/{chat}/polls/{poll}/votes", {"optionIds": ["o1"]}).status_code for _ in range(40)]
    assert 429 in answers


def test_sockets_per_user_are_limited(client):
    person = User(client)
    sockets = [on_socket(person) for _ in range(5)]
    extra = on_socket(person)
    try:
        from app.realtime import MAX_SOCKETS_PER_USER, hub
        assert len(hub.clients[person.id]) == MAX_SOCKETS_PER_USER
    finally:
        for ws in [*sockets, extra]:
            try:
                ws.__exit__(None, None, None)
            except Exception:  # noqa: BLE001 (one already closed by the limit)
                pass


def test_a_watch_is_forgotten_when_nobody_is_there(user):
    domain.watch_events(user.id, 41.9, 12.5, 1000)
    domain.forget_old_watches(now_ms())
    assert user.id in domain.event_watch
    domain.forget_old_watches(now_ms() + domain.WATCH_KEPT_OFFLINE_MS + 1000)
    assert user.id not in domain.event_watch


# --- what comes from the app, on its way to someone else ---

def test_a_purchase_token_cannot_reach_another_address(monkeypatch):
    from app import stores
    asked = []

    class Client:
        def __init__(self, **_):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, url, **_):
            asked.append(url)
            return type("Answer", (), {"status_code": 404})()

    async def token():
        return "service-token"

    monkeypatch.setattr(config, "GOOGLE_PACKAGE_NAME", "com.example")
    monkeypatch.setattr(config, "GOOGLE_SERVICE_ACCOUNT_FILE", "unused")
    monkeypatch.setattr(stores, "_play_access_token", token)
    monkeypatch.setattr(stores.httpx, "AsyncClient", Client)
    with pytest.raises(stores.ApiError):
        __import__("asyncio").run(stores.verify_google("promo.credits.099", "../../../../reviews?x=1", "account"))
    assert "../" not in asked[0] and "?x=1" not in asked[0]


def test_an_unknown_product_never_reaches_a_store(user):
    answer = user.post("/v1/me/wallet/purchases", {"platform": "android", "productId": "../../other", "purchaseToken": "t"})
    assert answer.status_code == 400


@pytest.mark.parametrize("bad", [
    {"bodyShape": ["x"]},
    {"bodyShape": {"a": 1}},
    {"bodyShape": "x", "colors": "red"},
    {"bodyShape": "x", "wearables": ["hat"]},
    {"bodyShape": "x", "wearables": {"hat": ["y"]}},
])
def test_a_nonsense_avatar_is_refused_not_a_crash(user, bad):
    assert user.put("/v1/me/avatar", {"format": "masterkey.avatar", "version": 1, **bad}).status_code in (200, 400)


def test_a_message_in_the_same_millisecond_is_still_unread(client, monkeypatch):
    # Two people writing at once: the first one's own message is what they read last
    owner, friend = User(client), User(client)
    connect(owner, friend)
    chat = owner.post("/v1/chats", {"title": "Team", "memberIds": [friend.id]}).json()["id"]
    frozen = now_ms() + 60_000
    monkeypatch.setattr(domain, "now_ms", lambda: frozen)
    assert owner.post(f"/v1/chats/{chat}/messages", {"text": "One"}).status_code == 201
    assert friend.post(f"/v1/chats/{chat}/messages", {"text": "Two"}).status_code == 201
    assert owner.get(f"/v1/chats/{chat}").json()["unread"] == 1
    times = [message.at for message in store.messages[chat]]
    assert times == sorted(set(times))
