# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Where someone is cannot be made up: a position no plane could have reached is refused
wherever a phone claims one (position_guard.py), and connecting in person really means in
person. And what an event says about people stays true: who joined, who rated, how many
it still looks for."""

import itertools
import json
import time

import pytest

from conftest import LAT, LON, User, iso_in, new_event

from app import position_guard
from app.realtime import presences

ROME = {"latitude": 41.9, "longitude": 12.5}
NEW_YORK = {"latitude": 40.7, "longitude": -74.0}
_places = itertools.count()


def place():
    return {"latitude": LAT + 0.5 + next(_places) * 0.01, "longitude": LON}


def live_dates():
    return {"startDate": iso_in(-0.05), "endDate": iso_in(1)}


def next_of(ws, kind):
    for _ in range(200):
        frame = json.loads(ws.receive_text())
        if frame["type"] == kind:
            return frame
    raise AssertionError(f"no {kind}")


def test_the_guard_refuses_what_no_plane_can_do(user):
    assert position_guard.plausible(user.id, **ROME)
    assert position_guard.plausible(user.id, ROME["latitude"] + 0.001, ROME["longitude"])
    assert not position_guard.plausible(user.id, **NEW_YORK)
    # Still where it was: a refused position is not remembered
    assert position_guard.plausible(user.id, **ROME)


def test_hopping_a_little_at_a_time_gets_nowhere(user):
    # 1.5 km at a time, as fast as a script can send: the margin is not a way across
    assert position_guard.plausible(user.id, **ROME)
    answers = [position_guard.plausible(user.id, ROME["latitude"] + n * 0.0135, ROME["longitude"]) for n in range(1, 20)]
    assert answers[0] is True
    assert answers[-1] is False


def test_a_real_journey_is_fine(user, monkeypatch):
    # A flight to New York: 8 h later the phone is there
    clock = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])
    assert position_guard.plausible(user.id, **ROME)
    clock[0] += 8 * 3600
    assert position_guard.plausible(user.id, **NEW_YORK)


def test_presence_cannot_jump_across_the_world(user):
    with user.client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": user.token}))
        next_of(ws, "ready")
        ws.send_text(json.dumps({"type": "presence", "mode": "visible", "position": ROME}))
        next_of(ws, "presence.snapshot")
        ws.send_text(json.dumps({"type": "presence", "mode": "visible", "position": NEW_YORK}))
        assert next_of(ws, "error")["code"] == "position_rejected"
        # On the map they stay where they were
        assert presences[user.id].latitude == ROME["latitude"]


def test_events_cannot_be_asked_from_across_the_world(user):
    assert user.get(f"/v1/events?latitude={ROME['latitude']}&longitude={ROME['longitude']}").status_code == 200
    far = user.get(f"/v1/events?latitude={NEW_YORK['latitude']}&longitude={NEW_YORK['longitude']}")
    assert far.status_code == 409
    assert far.json()["code"] == "position_rejected"


def test_a_flash_event_cannot_come_from_a_made_up_place(user):
    assert user.get(f"/v1/events?latitude={ROME['latitude']}&longitude={ROME['longitude']}").status_code == 200
    answer = new_event(user, location=NEW_YORK, flash=True, dates=live_dates(), **{"from": NEW_YORK})
    assert answer.status_code == 409
    assert answer.json()["code"] == "too_far"


def test_an_event_cannot_be_turned_into_a_flash_one(user):
    event = new_event(user, location=place()).json()
    assert user.patch(f"/v1/events/{event['id']}", {"flash": True}).json()["flash"] is False


# --- connecting in person ---

def session_of(user, location):
    return user.post("/v1/connections/sessions", {"location": location}).json()


def here(**fields):
    return {**ROME, "accuracy": 10, "timestamp": int(time.time() * 1000), **fields}


@pytest.mark.parametrize("host_fields, guest_fields", [
    ({"mocked": True}, {}),
    ({}, {"mocked": True}),
])
def test_a_fake_position_never_connects(user, other, host_fields, guest_fields):
    session = session_of(user, here(**host_fields))
    answer = other.post("/v1/connections/claims", {"token": session["token"], "location": here(**guest_fields)})
    assert answer.status_code == 403
    assert answer.json()["code"] == "too_far"


def test_a_huge_accuracy_does_not_excuse_the_distance(user, other):
    session = session_of(user, here(accuracy=100_000))
    away = here(latitude=ROME["latitude"] + 0.01, accuracy=100_000)  # 1.1 km
    answer = other.post("/v1/connections/claims", {"token": session["token"], "location": away})
    assert answer.status_code == 403


def test_a_position_left_out_does_not_hide_the_map_one(user, other):
    # The guest sends none, but the map knows they are 1.1 km away
    from app.realtime import Presence
    presences[other.id] = Presence(user_id=other.id, mode="visible", latitude=ROME["latitude"] + 0.01, longitude=ROME["longitude"])
    try:
        session = session_of(user, here())
        assert other.post("/v1/connections/claims", {"token": session["token"]}).status_code == 403
    finally:
        del presences[other.id]


def test_together_connects_and_no_position_at_all_is_not_stopped(client):
    host, guest = User(client), User(client)
    session = session_of(host, here())
    assert guest.post("/v1/connections/claims", {"token": session["token"], "location": here(accuracy=5)}).json()["status"] == "connected"
    # No permission, indoors: nobody gets an extra step for it
    host, guest = User(client), User(client)
    session = session_of(host, None)
    assert guest.post("/v1/connections/claims", {"token": session["token"]}).json()["status"] == "connected"


@pytest.mark.parametrize("bad", [
    {"latitude": 1000, "longitude": 12},
    {"latitude": True, "longitude": False},
    {"latitude": "41.9", "longitude": "12.5"},
    {"latitude": 41.9},
    "here",
    [],
])
def test_nonsense_positions_do_not_break_connecting(client, bad):
    host, guest = User(client), User(client)
    session = session_of(host, bad)
    assert guest.post("/v1/connections/claims", {"token": session["token"], "location": bad}).status_code == 200


# --- what an event says stays true ---

def ended(user, monkeypatch, **fields):
    """An event, then the clock moved past its end"""
    event = new_event(user, location=place(), **fields).json()
    from app.store import store
    store.events[event["id"]].end = int(time.time() * 1000) - 1000
    store.events[event["id"]].start = store.events[event["id"]].end - 3_600_000
    return event


def test_nobody_joins_an_event_that_is_over(user, other, monkeypatch):
    event = ended(user, monkeypatch)
    answer = other.put(f"/v1/events/{event['id']}/followers/me")
    assert answer.status_code == 410
    # So nobody "went" to it, and nobody rates it from outside
    assert other.post(f"/v1/events/{event['id']}/ratings", {"rating": 10}).status_code == 403


def test_who_joined_can_still_rate_it_once_over(user, other, monkeypatch):
    event = new_event(user, location=place()).json()
    assert other.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    from app.store import store
    store.events[event["id"]].end = int(time.time() * 1000) - 1000
    store.events[event["id"]].start = store.events[event["id"]].end - 3_600_000
    assert other.post(f"/v1/events/{event['id']}/ratings", {"rating": 9}).status_code == 201


def test_an_event_that_is_over_cannot_be_rewritten(user, monkeypatch):
    event = ended(user, monkeypatch)
    answer = user.patch(f"/v1/events/{event['id']}", {"title": "Another event", "dates": {"startDate": iso_in(1), "endDate": iso_in(2)}})
    assert answer.status_code == 410
    assert user.get(f"/v1/events/{event['id']}").json()["title"] == event["title"]


def test_dates_cannot_be_moved_into_the_past(user):
    event = new_event(user, location=place()).json()
    path = f"/v1/events/{event['id']}"
    assert user.patch(path, {"dates": {"startDate": iso_in(-3), "endDate": iso_in(-2)}}).status_code == 400
    assert user.patch(path, {"dates": {"startDate": iso_in(-3), "endDate": iso_in(1)}}).status_code == 400
    # A live event keeps its start while its end moves
    live = new_event(user, location=place(), dates=live_dates()).json()
    assert user.patch(f"/v1/events/{live['id']}", {"dates": {"startDate": live["dates"]["startDate"], "endDate": iso_in(2)}}).status_code == 200


def test_an_event_lasts_at_most_a_month(user):
    too_long = new_event(user, location=place(), dates={"startDate": iso_in(1), "endDate": iso_in(24 * 40)})
    assert too_long.status_code == 400
    assert new_event(user, location=place(), dates={"startDate": iso_in(1), "endDate": iso_in(24 * 30)}).status_code == 201


def test_a_flash_event_has_the_people_it_asked_for(client):
    organizer, first, second, third = User(client), User(client), User(client), User(client)
    spot = place()
    event = new_event(organizer, location=spot, flash=True, spotsNeeded=2, dates=live_dates(), **{"from": spot}).json()
    path = f"/v1/events/{event['id']}/followers/me"
    assert first.put(path).status_code == 200
    assert second.put(path).status_code == 200
    answer = third.put(path)
    assert answer.status_code == 409
    assert answer.json()["code"] == "full"
    # Who is in stays in, and joining again is the same; who leaves makes room
    assert first.put(path).status_code == 200
    assert second.delete(path).status_code == 200
    assert third.put(path).status_code == 200


def test_joining_a_live_event_does_not_tell_where_someone_is_now(user, other):
    event = new_event(user, location=place(), dates=live_dates()).json()
    assert other.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    other.patch("/v1/me", {"storyAudience": "everyone"})
    items = user.get(f"/v1/users/{other.id}/activity").json()["items"]
    kinds = {item["kind"] for item in items if item["event"] and item["event"]["id"] == event["id"]}
    assert kinds == {"going"}
