# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""When someone stops being on the map (API.md, `presence`): the app says so a minute after
the user left the map screen, and the socket ending (background, app closed) does it by
itself, at once."""

import json
import time

from conftest import LAT, LON, User

from app import realtime
from app.realtime import presences


def on_socket(person):
    ws = person.client.websocket_connect("/v1/ws")
    ws.__enter__()
    ws.send_text(json.dumps({"type": "auth", "token": person.token}))
    assert json.loads(ws.receive_text())["type"] == "ready"
    return ws


def tell(ws, mode="visible", position=True):
    point = {"latitude": LAT, "longitude": LON, "accuracy": 5} if position else None
    ws.send_text(json.dumps({"type": "presence", "mode": mode, "position": point}))
    # The answer to a ping comes after the frame before it was handled
    ws.send_text(json.dumps({"type": "ping"}))
    while json.loads(ws.receive_text())["type"] != "pong":
        pass


def until(condition, seconds=3):
    limit = time.monotonic() + seconds
    while time.monotonic() < limit:
        if condition():
            return True
        time.sleep(0.02)
    return False


def test_closing_the_socket_ends_the_presence_at_once(client):
    person = User(client)
    ws = on_socket(person)
    tell(ws)
    assert person.id in presences
    ws.__exit__(None, None, None)
    # Long before the 45 s for a connection lost without a word
    assert until(lambda: person.id not in presences)


def test_a_second_device_closing_leaves_the_presence_of_the_first(client):
    person = User(client)
    on_map, other_device = on_socket(person), on_socket(person)
    tell(on_map)
    other_device.__exit__(None, None, None)
    tell(on_map)
    assert person.id in presences
    on_map.__exit__(None, None, None)
    assert until(lambda: person.id not in presences)


def test_the_device_on_the_map_closing_ends_it_with_another_still_open(client):
    person = User(client)
    on_map, other_device = on_socket(person), on_socket(person)
    tell(on_map)
    on_map.__exit__(None, None, None)
    assert until(lambda: person.id not in presences)
    other_device.__exit__(None, None, None)


def test_no_position_takes_them_off_the_map_and_comes_back_with_a_snapshot(client):
    person = User(client)
    ws = on_socket(person)
    tell(ws)
    tell(ws, position=False)
    assert person.id not in presences
    ws.send_text(json.dumps({"type": "presence", "mode": "visible", "position": {"latitude": LAT, "longitude": LON}}))
    frame = json.loads(ws.receive_text())
    while frame["type"] != "presence.snapshot":
        frame = json.loads(ws.receive_text())
    assert person.id in presences
    ws.__exit__(None, None, None)


def test_someone_off_the_map_sees_nobody(client):
    watcher, walker = User(client), User(client)
    watching, walking = on_socket(watcher), on_socket(walker)
    tell(walking)
    tell(watching)
    assert any(entry[0].user_id == walker.id for entry in realtime.visible_to(watcher.id))
    tell(watching, position=False)
    assert realtime.visible_to(watcher.id) == []
    assert not any(entry[0].user_id == watcher.id for entry in realtime.visible_to(walker.id))
    watching.__exit__(None, None, None)
    walking.__exit__(None, None, None)
