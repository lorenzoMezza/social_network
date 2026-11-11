# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Who may know what someone does (Settings › Privacy, Store.sees_story): every answer that
says so follows the one setting, from the first request; and nobody earns points yet."""

import json

from conftest import User, iso_in, new_event

from app.store import User as StoredUser, store


def connect(a, b):
    store.connect(a.id, b.id, None)


def on_socket(person):
    ws = person.client.websocket_connect("/v1/ws")
    ws.__enter__()
    ws.send_text(json.dumps({"type": "auth", "token": person.token}))
    assert json.loads(ws.receive_text())["type"] == "ready"
    return ws


def a_stranger_and_a_friend(client):
    owner, stranger, friend = User(client), User(client), User(client)
    connect(owner, friend)
    return owner, stranger, friend


def test_only_connections_by_default(client):
    owner, stranger, friend = a_stranger_and_a_friend(client)
    assert owner.me["storyAudience"] == "connections"
    event = new_event(owner).json()

    for path in ("activity", "events", "connections"):
        assert stranger.get(f"/v1/users/{owner.id}/{path}").json()["items"] == []
        assert friend.get(f"/v1/users/{owner.id}/{path}").json()["items"] != []
    profile = stranger.get(f"/v1/users/{owner.id}").json()
    assert profile["relation"]["seesStory"] is False
    assert profile["stats"] == {"organized": None, "connections": None}
    # Who they are stays: they appear by name on events, chats and the map
    assert profile["name"] == owner.me["name"]
    assert friend.get(f"/v1/users/{owner.id}").json()["relation"]["seesStory"] is True
    # Their own always
    assert owner.get(f"/v1/users/{owner.id}").json()["stats"]["organized"] == 1
    assert any(item["event"]["id"] == event["id"] for item in owner.get(f"/v1/users/{owner.id}/activity").json()["items"])


def test_the_setting_opens_and_closes_at_once(client):
    owner, stranger, _ = a_stranger_and_a_friend(client)
    new_event(owner)
    assert owner.patch("/v1/me", {"storyAudience": "everyone"}).json()["storyAudience"] == "everyone"
    assert stranger.get(f"/v1/users/{owner.id}/activity").json()["items"]
    assert stranger.get(f"/v1/users/{owner.id}/events").json()["items"]
    assert stranger.get(f"/v1/users/{owner.id}/connections").json()["total"] is not None
    assert owner.patch("/v1/me", {"storyAudience": "connections"}).status_code == 200
    assert stranger.get(f"/v1/users/{owner.id}/activity").json()["items"] == []
    assert stranger.get(f"/v1/users/{owner.id}/connections").json()["total"] is None
    assert owner.patch("/v1/me", {"storyAudience": "friends of friends"}).status_code == 400


def test_a_disconnection_closes_it_too(client):
    owner, _, friend = a_stranger_and_a_friend(client)
    new_event(owner)
    assert friend.get(f"/v1/users/{owner.id}/activity").json()["items"]
    assert owner.delete(f"/v1/me/connections/{friend.id}").status_code == 204
    assert friend.get(f"/v1/users/{owner.id}/activity").json()["items"] == []


def test_an_event_does_not_say_who_goes_to_a_stranger(client):
    organizer, private, stranger, friend = User(client), User(client), User(client), User(client)
    connect(private, friend)
    path = f"/v1/events/{new_event(organizer).json()['id']}"
    assert private.put(f"{path}/followers/me").status_code == 200

    seen = stranger.get(path).json()
    assert seen["followerCount"] == 1 and seen["followers"] == []
    assert [p["id"] for p in friend.get(path).json()["followers"]] == [private.id]
    # Who runs the event knows who comes
    assert [p["id"] for p in organizer.get(path).json()["followers"]] == [private.id]
    assert [p["id"] for p in private.get(path).json()["followers"]] == [private.id]


def test_nor_who_rated_it(client):
    organizer, private, stranger = User(client), User(client), User(client)
    path = f"/v1/events/{new_event(organizer, dates={'startDate': iso_in(-0.05), 'endDate': iso_in(1)}).json()['id']}"
    assert private.put(f"{path}/followers/me").status_code == 200
    assert private.post(f"{path}/ratings", {"rating": 8, "comment": "Nice"}).status_code == 201

    seen = stranger.get(path).json()
    assert seen["ratings"][0]["user"] is None and seen["ratings"][0]["comment"] == "Nice"
    assert seen["ratingCount"] == 1
    assert organizer.get(path).json()["ratings"][0]["user"]["id"] == private.id
    assert private.get(path).json()["myRating"]["user"]["id"] == private.id


def test_nor_does_its_chat_list_them_to_who_only_joined(client):
    organizer, private, stranger = User(client), User(client), User(client)
    event_id = new_event(organizer).json()["id"]
    for person in (private, stranger):
        assert person.put(f"/v1/events/{event_id}/followers/me").status_code == 200
    chat = f"/v1/chats/event:{event_id}"

    seen = stranger.get(chat).json()
    assert {entry["user"]["id"] for entry in seen["members"]} == {organizer.id, stranger.id}
    assert seen["memberCount"] == 3
    # Who runs it sees everyone, to moderate
    assert {entry["user"]["id"] for entry in organizer.get(chat).json()["members"]} == {organizer.id, private.id, stranger.id}


def test_an_account_saved_before_the_setting_is_private_a_demo_person_public():
    person = StoredUser.__new__(StoredUser)
    person.__setstate__({"id": "x", "username": "x", "name": "X", "style": {}})
    assert person.story_audience == "connections"
    demo = StoredUser.__new__(StoredUser)
    demo.__setstate__({"id": "y", "username": "y", "name": "Y", "style": {}, "bot": True})
    assert demo.story_audience == "everyone"


def test_the_export_says_who_sees_the_story(user):
    url = user.post("/v1/me/export").json()["url"]
    assert user.client.get(url[url.index("/v1/"):]).json()["story"]["audience"] == "connections"


def test_nobody_has_points_yet(client):
    organizer, guest = User(client), User(client)
    connect(organizer, guest)
    path = f"/v1/events/{new_event(organizer, dates={'startDate': iso_in(-0.05), 'endDate': iso_in(1)}).json()['id']}"
    guest.put(f"{path}/followers/me")
    guest.post(f"{path}/ratings", {"rating": 10, "comment": ""})
    assert set(organizer.get("/v1/me").json()["stats"]) == {"organized", "connections"}
    assert set(guest.get(f"/v1/users/{organizer.id}").json()["stats"]) == {"organized", "connections"}
