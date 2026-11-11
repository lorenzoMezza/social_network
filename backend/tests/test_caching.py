# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""What the app keeps on the phone stays right (API.md, Caching): every GET answer has
an ETag and an unchanged one costs a 304; a chat's missed messages come exactly with
`after`; a person's new name or picture reaches the map's viewers."""

from conftest import User
from app.realtime import Client, Presence, _payload


def connect(host, guest):
    session = host.post("/v1/connections/sessions", {"location": None}).json()
    assert guest.post("/v1/connections/claims", {"token": session["token"]}).status_code == 200


# --- ETags ---

def test_an_unchanged_answer_costs_a_304(user):
    first = user.get("/v1/me")
    tag = first.headers["etag"]
    assert "no-cache" in first.headers["cache-control"]
    again = user.client.get("/v1/me", headers={**user.headers, "If-None-Match": tag})
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == tag


def test_a_change_gives_a_new_etag(user):
    tag = user.get("/v1/me").headers["etag"]
    assert user.patch("/v1/me", {"bio": "Changed"}).status_code == 200
    after = user.client.get("/v1/me", headers={**user.headers, "If-None-Match": tag})
    assert after.status_code == 200 and after.headers["etag"] != tag and after.json()["bio"] == "Changed"


def test_routes_with_their_own_etag_keep_it(user, other):
    answer = user.get(f"/v1/users/{other.id}/avatar")
    assert answer.headers["etag"].startswith(f'"{other.id}:')
    again = user.client.get(f"/v1/users/{other.id}/avatar", headers={**user.headers, "If-None-Match": answer.headers["etag"]})
    assert again.status_code == 304


def test_errors_and_writes_have_no_etag(user):
    assert "etag" not in user.get("/v1/users/nobody").headers
    assert "etag" not in user.patch("/v1/me", {"bio": "x"}).headers


# --- missed messages ---

def test_messages_after_one_the_app_has(client):
    alice, bob = User(client, "Alice"), User(client, "Bob")
    connect(alice, bob)
    chat = alice.post("/v1/chats/direct", {"userId": bob.id}).json()["id"]
    ids = [alice.post(f"/v1/chats/{chat}/messages", {"text": f"m{i}"}).json()["id"] for i in range(7)]

    page = bob.get(f"/v1/chats/{chat}/messages?after={ids[2]}").json()
    assert [m["id"] for m in page["items"]] == ids[3:]
    assert page["nextCursor"] is None

    # A page at a time, oldest first, until there are no more
    seen, cursor = [], ids[0]
    while cursor:
        page = bob.get(f"/v1/chats/{chat}/messages?after={cursor}&limit=2").json()
        seen += [m["id"] for m in page["items"]]
        cursor = page["nextCursor"]
    assert seen == ids[1:]

    assert bob.get(f"/v1/chats/{chat}/messages?after={ids[-1]}").json() == {"items": [], "nextCursor": None}
    assert bob.get(f"/v1/chats/{chat}/messages?after=unknown").status_code == 404
    assert bob.get(f"/v1/chats/{chat}/messages?after={ids[0]}&before={ids[3]}").status_code == 400


# --- people on the map ---

def test_a_changed_summary_is_sent_again(user, other):
    viewer = Client.__new__(Client)
    viewer.known = {}
    presence = Presence(user_id=other.id, mode="visible", latitude=41.9, longitude=12.5)
    shown = ("precise", 41.9, 12.5, None, None, None)

    assert _payload(viewer, presence, shown)["user"]["name"] == "Other Person"
    assert "user" not in _payload(viewer, presence, shown)

    assert other.patch("/v1/me", {"name": "New Name"}).status_code == 200
    assert _payload(viewer, presence, shown)["user"]["name"] == "New Name"
    assert "user" not in _payload(viewer, presence, shown)
