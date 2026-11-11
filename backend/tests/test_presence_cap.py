# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""At most MAX_SHOWN people on one map (API.md, Presence rules): connections first, then
the nearest, without flicker; being around someone does not depend on it."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import LAT, LON
from conftest import User as PersonOnTest

from app import realtime
from app.realtime import MAX_SHOWN, are_near, presences, seen, update_presence, visible_to
from app.store import User, store
from app.util import offset

VIEWER = "cap-viewer"


def stand(user_id, metres, mode="visible"):
    lat, lon = offset(LAT, LON, metres, 0)
    update_presence(user_id, mode, {"latitude": lat, "longitude": lon})


@pytest.fixture
def crowd():
    """A viewer, and people a metre apart going away from them, the first at 1 m"""
    stand(VIEWER, 0)
    ids = [f"cap-{n}" for n in range(1, 81)]
    for n, user_id in enumerate(ids, start=1):
        stand(user_id, n)
    yield ids
    for user_id in [VIEWER, *ids, "cap-friend"]:
        update_presence(user_id, "invisible", None)
        seen.pop(user_id, None)
    store.connections.pop(VIEWER, None)
    store.connections.pop("cap-friend", None)


def shown(user_id=VIEWER):
    return [entry[0].user_id for entry in visible_to(user_id)]


def test_the_map_shows_the_nearest_only(crowd):
    assert shown() == crowd[:MAX_SHOWN]


def test_few_people_are_all_shown():
    # Far from the demo people, who stand around where a user last was
    update_presence(VIEWER, "visible", {"latitude": 10.0, "longitude": 10.0})
    update_presence("cap-1", "visible", {"latitude": 10.0001, "longitude": 10.0})
    assert shown() == ["cap-1"]
    update_presence(VIEWER, "invisible", None)
    update_presence("cap-1", "invisible", None)


def test_a_connection_comes_first_however_far(crowd):
    stand("cap-friend", 900)
    store.connect(VIEWER, "cap-friend", None)
    people = shown()
    assert "cap-friend" in people and len(people) == MAX_SHOWN
    # Still nearest first, with the farthest of the others left out
    assert people[-1] == "cap-friend" and crowd[MAX_SHOWN - 1] not in people


def test_someone_shown_is_not_replaced_by_someone_just_closer(crowd):
    seen[VIEWER] = {user_id: () for user_id in crowd[:MAX_SHOWN]}
    last = crowd[MAX_SHOWN - 1]  # at 50 m
    stand(crowd[-1], MAX_SHOWN - 2)  # someone new, at 48 m: a little closer
    assert last in shown() and crowd[-1] not in shown()
    stand(crowd[-1], 10)  # really closer: takes the place
    assert crowd[-1] in shown()


def test_writing_to_someone_does_not_depend_on_being_shown(crowd):
    assert crowd[-1] not in shown()
    assert are_near(VIEWER, crowd[-1])


def test_who_waves_enters_the_map_of_who_they_wave_at(crowd):
    # The map plays a gesture only on someone it shows (webview/map nearbyPeople.gesture)
    far = crowd[-1]
    assert far not in shown()
    for user_id in (VIEWER, far):
        store.users[user_id] = User(id=user_id, username=user_id, name=user_id)
    realtime.send_gesture(far, VIEWER, "wave")
    for user_id in (VIEWER, far):
        del store.users[user_id]
    people = shown()
    assert far in people and len(people) == MAX_SHOWN
    # A minute later they are one of the crowd again
    realtime._pinned[VIEWER][far] = 0
    assert far not in shown()
    realtime.sweep()
    assert VIEWER not in realtime._pinned


def test_words_reach_only_who_has_the_speaker_on_their_map(crowd):
    # Everyone stands in a line: the viewer is among the nearest only for those close by
    heard = realtime._audience(VIEWER)
    assert crowd[0] in heard and crowd[-1] not in heard
    assert all(VIEWER in shown(person) for person in heard)


def next_frame(ws, seconds=4):
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        return json.loads(pool.submit(ws.receive_text).result(timeout=seconds))
    finally:
        pool.shutdown(wait=False)


def on_socket(person, metres):
    ws = person.client.websocket_connect("/v1/ws")
    ws.__enter__()
    ws.send_text(json.dumps({"type": "auth", "token": person.token}))
    assert next_frame(ws)["type"] == "ready"
    lat, lon = offset(LAT, LON, metres, 0)
    ws.send_text(json.dumps({"type": "presence", "mode": "visible", "position": {"latitude": lat, "longitude": lon}}))
    return ws


def test_on_real_sockets_a_wave_arrives_after_the_person_and_the_audience_is_exact(client, crowd):
    # Who stands around is known to the server: the janitor and the presence loop read them
    for user_id in [VIEWER, *crowd]:
        store.users[user_id] = User(id=user_id, username=user_id, name=user_id)
    me, far = PersonOnTest(client), PersonOnTest(client)
    mine, theirs = on_socket(me, 0), on_socket(far, 400)
    try:
        snapshot = next_frame(mine)
        assert snapshot["type"] == "presence.snapshot" and len(snapshot["people"]) <= MAX_SHOWN
        theirs.send_text(json.dumps({"type": "gesture", "to": me.id, "gesture": "wave", "ref": "w"}))
        frames = []
        while not frames or frames[-1]["type"] != "gesture":
            frames.append(next_frame(mine))
        appears = [i for i, frame in enumerate(frames) if frame["type"] == "presence.delta"
                   and any(person["userId"] == far.id for person in frame["people"])]
        assert appears and frames[-1]["from"] == far.id
        told = None
        while True:
            frame = next_frame(theirs)
            if frame["type"] == "presence.delta" and frame.get("audience") is not None:
                told = frame["audience"]
            if told is not None and told >= 1:
                break
        theirs.send_text(json.dumps({"type": "broadcast", "text": "Hi", "ref": "b"}))
        while (frame := next_frame(theirs)).get("ref") != "b":
            if frame["type"] == "presence.delta" and frame.get("audience") is not None:
                told = frame["audience"]
        assert frame["type"] == "ack" and frame["recipients"] == told
    finally:
        mine.__exit__(None, None, None)
        theirs.__exit__(None, None, None)
        for user_id in [VIEWER, *crowd]:
            update_presence(user_id, "invisible", None)
            store.users.pop(user_id, None)



def test_the_map_shows_twenty_five_people():
    assert MAX_SHOWN == 25


def test_strangers_waving_never_hide_a_connection(crowd):
    friends = [f"cap-friend-{n}" for n in range(MAX_SHOWN)]
    try:
        for n, friend in enumerate(friends):
            stand(friend, 200 + n)
            store.connect(VIEWER, friend, None)
        # All the crowd, closer, waves at the viewer: the map still shows the connections
        for stranger in crowd[:30]:
            realtime._pinned.setdefault(VIEWER, {})[stranger] = float("inf")
        assert set(shown()) == set(friends)
    finally:
        realtime._pinned.pop(VIEWER, None)
        for friend in friends:
            update_presence(friend, "invisible", None)
            store.connections.pop(friend, None)


def test_nobody_waves_at_the_whole_square(crowd, monkeypatch):
    from app import limits
    from app.errors import ApiError

    for user_id in crowd:
        store.users[user_id] = User(id=user_id, username=user_id, name=user_id)
    monkeypatch.setitem(limits.RULES, "gesture", (3, 60))
    sender = crowd[0]
    try:
        for target in crowd[1:4]:
            realtime.send_gesture(sender, target, "wave")
        with pytest.raises(ApiError) as refused:
            realtime.send_gesture(sender, crowd[4], "wave")
        assert refused.value.status == 429
    finally:
        limits._hits.pop((sender, "gesture"), None)
        for user_id in crowd:
            store.users.pop(user_id, None)
