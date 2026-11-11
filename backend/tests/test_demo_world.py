# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The demo world (seed.py) follows the app's own rules and has something for every
screen: what a new account sees around it, in Saved, in Social and in the bell."""

from conftest import LAT, LON, User

from app import seed
from app.routes.events import MAX_ACTIVE, MIN_SPACING_M
from app.store import store
from app.util import distance_m, now_ms

# Far from every other test's events: a demo area of its own
HERE = {"latitude": LAT + 2.0, "longitude": LON + 2.0}


def demo_account(client):
    user = User(client)
    events = user.get("/v1/events", params={**HERE, "range": 10_000}).json()["items"]
    return user, events


def test_a_new_account_has_its_world(client):
    user, nearby = demo_account(client)
    assert len(nearby) >= 10
    sponsored = [e for e in nearby if e["sponsored"]]
    assert len(sponsored) == 3  # the list shows the nearest 2 on top
    assert any(e["flash"] for e in nearby) and any(e["status"] == "ongoing" for e in nearby)
    assert any(e["friendsGoing"] for e in nearby)
    # Everything shown is within its reach (800 m free, else its promotion)
    for event in nearby:
        metres = distance_m(HERE["latitude"], HERE["longitude"], event["location"]["latitude"], event["location"]["longitude"])
        assert metres <= event["reach"], event["title"]

    mine = user.get("/v1/me/events").json()
    statuses = {e["status"] for e in mine["followed"]}
    assert {"upcoming", "ongoing", "concluded", "cancelled"} <= statuses
    assert any(e["saved"] and not e["following"] for e in mine["followed"])
    assert any(e["following"] and not e["saved"] for e in mine["followed"])
    assert {e["status"] for e in mine["created"]} >= {"upcoming", "concluded"}

    chats = user.get("/v1/chats").json()["items"]
    assert {c["kind"] for c in chats} >= {"direct", "group"}
    assert sum(1 for c in chats if c["unread"]) >= 2

    notes = user.get("/v1/me/notifications").json()
    kinds = {n["kind"] for n in notes["items"]}
    assert notes["unread"] >= 3
    assert {"event.joined", "event.changed", "connect.invite", "event.cancelled", "album.photos", "event.rated"} <= kinds

    story = {item["kind"] for item in user.get(f"/v1/users/{user.id}/activity?limit=100").json()["items"]}
    assert {"organized", "going", "went", "reviewed", "connected"} <= story

    me = user.get("/v1/me").json()
    assert me["stats"]["connections"] == len(seed.CONNECTIONS)
    assert len(user.get("/v1/me/blocks").json()["items"]) == len(seed.BLOCKED)
    assert user.get("/v1/me/wallet").json()["balance"] == 0  # (the tests start from none: conftest)


def test_the_demo_events_follow_the_rules(client):
    demo_account(client)
    now = now_ms()
    # Every event not over is on the map at once: none within MIN_SPACING_M of another
    events = [e for e in store.events.values() if not e.cancelled and e.end > now]
    for a in events:
        for b in events:
            if a.id < b.id:
                assert distance_m(a.latitude, a.longitude, b.latitude, b.longitude) >= MIN_SPACING_M, (a.title, b.title)
    by_organizer = {}
    for event in events:
        by_organizer[event.creator_id] = by_organizer.get(event.creator_id, 0) + 1
    assert max(by_organizer.values()) <= MAX_ACTIVE


def test_someone_s_connections_have_some_in_common(client):
    user, _ = demo_account(client)
    answer = user.get(f"/v1/users/{seed.bot_id('disco_rotto')}/connections").json()
    assert answer["total"] >= 5 and answer["mutual"] >= 1
