# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""'Connect' on someone nearby: the server invites the other; one shows the code, the other scans it."""

import json
from contextlib import contextmanager

from conftest import LAT, LON


@contextmanager
def on_the_map(person, mode="visible"):
    """A phone with the app open: signed in, on the map at LAT, LON."""
    with person.client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": person.token}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "presence", "mode": mode, "position": {"latitude": LAT, "longitude": LON}}))
        if mode != "invisible":
            next_of(ws, "presence.snapshot")
        yield ws


def next_of(ws, kind, ref=None):
    """The next frame of a kind (presences of the demo people come in between)."""
    for _ in range(50):
        frame = json.loads(ws.receive_text())
        if frame["type"] == kind and (ref is None or frame.get("ref") == ref):
            return frame
    raise AssertionError(f"no {kind}")


def invite(ws, to, ref="i"):
    ws.send_text(json.dumps({"type": "connect.invite", "to": to, "ref": ref}))
    for _ in range(50):
        frame = json.loads(ws.receive_text())
        if frame.get("ref") == ref:
            return frame
    raise AssertionError("no answer")


def test_an_invitation_reaches_the_other_and_comes_back_with_the_answer(user, other):
    with on_the_map(user) as mine, on_the_map(other) as theirs:
        sent = invite(mine, other.me["id"])
        assert sent["type"] == "ack" and "method" not in sent
        received = next_of(theirs, "connect.invite")
        assert received["from"]["id"] == user.me["id"] and received["id"] == sent["invite"]
        # Accepting tells the one who invited
        theirs.send_text(json.dumps({"type": "connect.answer", "invite": received["id"], "accept": True, "ref": "a"}))
        assert next_of(theirs, "ack", "a")
        answer = next_of(mine, "connect.answer")
        assert answer["accept"] is True and answer["by"]["id"] == other.me["id"]
        # Answered once
        theirs.send_text(json.dumps({"type": "connect.answer", "invite": received["id"], "accept": True, "ref": "b"}))
        assert next_of(theirs, "error")["code"] == "expired"


def test_only_someone_who_sees_you_once_in_a_while(user, other):
    with on_the_map(user) as mine:
        # Not on the map: invisible
        with on_the_map(other, mode="invisible"):
            assert invite(mine, other.me["id"], "x")["code"] == "forbidden"
        assert invite(mine, "user-nobody", "y")["code"] == "not_found"
        assert invite(mine, user.me["id"], "z")["code"] == "not_found"
        with on_the_map(other) as theirs:
            assert invite(mine, other.me["id"], "1")["type"] == "ack"
            assert invite(mine, other.me["id"], "2")["code"] == "rate_limited"
            # The invitation is theirs to answer, not anyone's
            received = next_of(theirs, "connect.invite")
            mine.send_text(json.dumps({"type": "connect.answer", "invite": received["id"], "accept": True, "ref": "w"}))
            assert next_of(mine, "error")["code"] == "expired"


def test_connected_people_are_not_invited(user, other):
    session = user.post("/v1/connections/sessions", {"location": None}).json()
    assert other.post("/v1/connections/claims", {"token": session["token"]}).status_code == 200
    with on_the_map(user) as mine, on_the_map(other):
        assert invite(mine, other.me["id"])["code"] == "already"


def test_blocked_people_are_not_invited(user, other):
    assert other.put(f"/v1/me/blocks/{user.me['id']}").status_code in (200, 204)
    with on_the_map(user) as mine, on_the_map(other):
        assert invite(mine, other.me["id"])["code"] == "forbidden"


def test_new_events_reach_the_maps_around(user, other, client):
    from conftest import User
    stranger = User(client, "Far Away")
    blocked = User(client, "Blocked")
    assert blocked.put(f"/v1/me/blocks/{user.me['id']}").status_code in (200, 204)
    # Watching: one on the map nearby, one asked for events here, one far away, one blocked
    assert stranger.get("/v1/events", params={"latitude": LAT + 1, "longitude": LON, "range": 2000}).status_code == 200
    assert blocked.get("/v1/events", params={"latitude": LAT, "longitude": LON, "range": 2000}).status_code == 200
    with on_the_map(other) as theirs, \
            stranger.client.websocket_connect("/v1/ws") as far, blocked.client.websocket_connect("/v1/ws") as hidden:
        for ws, person in ((far, stranger), (hidden, blocked)):
            ws.send_text(json.dumps({"type": "auth", "token": person.token}))
            assert json.loads(ws.receive_text())["type"] == "ready"
        from datetime import datetime, timedelta, timezone
        start = datetime.now(timezone.utc) + timedelta(minutes=5)
        made = user.post("/v1/events", {
            "title": "Five-a-side", "description": "Two missing", "categories": ["sports"], "flash": True,
            "location": {"latitude": LAT + 0.001, "longitude": LON},
            "from": {"latitude": LAT, "longitude": LON},
            "dates": {"startDate": start.isoformat(), "endDate": (start + timedelta(hours=1)).isoformat()},
        })
        assert made.status_code == 201, made.text
        assert next_of(theirs, "event")["event"]["id"] == made.json()["id"]
        # Cancelled: the same people hear it, to take it off their maps
        assert user.delete(f"/v1/events/{made.json()['id']}").status_code == 200
        assert next_of(theirs, "event")["event"]["id"] == made.json()["id"]
        for ws in (far, hidden):
            ws.send_text(json.dumps({"type": "ping"}))
            assert json.loads(ws.receive_text())["type"] == "pong"
