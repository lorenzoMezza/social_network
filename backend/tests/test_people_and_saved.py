# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Saving and joining events, the Saved list, friends going, someone's connections,
the story's choices and the notifications (API.md: Events, People, Me, Notifications)."""

import json

from conftest import User, iso_in, new_event

from app import notifications
from app.store import store
from app.util import now_ms


def connect(a, b):
    store.connect(a.id, b.id, None)


def saved_ids(person):
    return {event["id"] for event in person.get("/v1/me/events").json()["followed"]}


def test_saving_and_joining_are_apart(user, other):
    event = new_event(other).json()
    path = f"/v1/events/{event['id']}"
    assert user.put(f"{path}/saved/me").json() == {"saved": True}
    mine = user.get(path).json()
    assert mine["saved"] is True and mine["following"] is False
    # Private: the organizer sees nobody going, and nothing saved of theirs
    theirs = other.get(path).json()
    assert theirs["followerCount"] == 0 and theirs["saved"] is False
    assert event["id"] in saved_ids(user)
    # Joining: on its people; still saved
    user.put(f"{path}/followers/me")
    mine = user.get(path).json()
    assert mine["following"] is True and mine["saved"] is True and mine["followerCount"] == 1


def test_an_upcoming_event_leaves_saved_when_neither_saved_nor_joined(user, other):
    event = new_event(other).json()
    path = f"/v1/events/{event['id']}"
    user.put(f"{path}/followers/me")
    assert event["id"] in saved_ids(user)
    user.delete(f"{path}/followers/me")
    assert event["id"] not in saved_ids(user)
    user.put(f"{path}/saved/me")
    user.delete(f"{path}/saved/me")
    assert event["id"] not in saved_ids(user)


def _ended(event_id):
    store.events[event_id].end = now_ms() - 1000


def test_an_event_that_took_place_stays_in_saved(user, other):
    """Saved or joined, once it happened it cannot be taken out, in any way."""
    joined = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    saved = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    user.put(f"/v1/events/{joined['id']}/followers/me")
    user.put(f"/v1/events/{saved['id']}/saved/me")
    _ended(joined["id"])
    _ended(saved["id"])
    for event in (joined, saved):
        answer = user.delete(f"/v1/events/{event['id']}/saved/me")
        assert answer.status_code == 409 and answer.json()["code"] == "past_event"
        assert event["id"] in saved_ids(user)
    assert user.delete(f"/v1/events/{joined['id']}/followers/me").json()["code"] == "past_event"
    assert joined["id"] in saved_ids(user)
    assert user.delete("/v1/me/saved/cancelled").status_code == 204
    assert {joined["id"], saved["id"]} <= saved_ids(user)
    # They went: their story keeps it
    story = user.get(f"/v1/users/{user.id}/activity").json()["items"]
    assert any(item["id"] == f"j-{joined['id']}" for item in story)


def test_an_event_cancelled_before_it_began_can_leave_saved(user, other):
    event = new_event(other).json()
    path = f"/v1/events/{event['id']}"
    user.put(f"{path}/followers/me")
    assert other.delete(path).status_code == 200
    assert event["id"] in saved_ids(user)
    assert user.delete(f"{path}/saved/me").json() == {"saved": False}
    assert event["id"] not in saved_ids(user)


def test_clearing_saved_takes_out_only_what_was_cancelled_before_it_began(user, other):
    happened = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    cancelled = new_event(other).json()
    later = new_event(other).json()
    for event in (happened, cancelled, later):
        user.put(f"/v1/events/{event['id']}/saved/me")
    _ended(happened["id"])
    assert other.delete(f"/v1/events/{cancelled['id']}").status_code == 200
    assert user.delete("/v1/me/saved/cancelled").status_code == 204
    assert saved_ids(user) == {happened["id"], later["id"]}


def test_an_event_cancelled_once_it_began_took_place(user, other):
    event = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    user.put(f"/v1/events/{event['id']}/saved/me")
    assert other.delete(f"/v1/events/{event['id']}").status_code == 200
    assert user.delete(f"/v1/events/{event['id']}/saved/me").json()["code"] == "past_event"
    assert event["id"] in saved_ids(user)


def test_the_organizer_clears_only_what_was_cancelled_before_it_began(user):
    happened = new_event(user, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    cancelled = new_event(user).json()
    _ended(happened["id"])
    # What is over cannot be cancelled either: nobody is told of something that happened
    assert user.delete(f"/v1/events/{happened['id']}").json()["code"] == "past_event"
    assert user.delete(f"/v1/events/{happened['id']}/saved/me").json()["code"] == "past_event"
    assert user.delete(f"/v1/events/{cancelled['id']}").status_code == 200
    created = lambda: {event["id"] for event in user.get("/v1/me/events").json()["created"]}  # noqa: E731
    assert cancelled["id"] in created()
    assert user.delete(f"/v1/events/{cancelled['id']}/saved/me").status_code == 200
    assert created() == {happened["id"]}


def test_what_is_over_cannot_be_saved_and_does_not_fill_the_list(user, other, monkeypatch):
    past = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    _ended(past["id"])
    assert user.put(f"/v1/events/{past['id']}/saved/me").json()["code"] == "past_event"
    # Saved before it ended: it stays, and leaves room for what is still to come
    from app.routes import events as routes
    monkeypatch.setattr(routes, "SAVED_MAX", 1)
    old = new_event(other, dates={"startDate": iso_in(-0.05), "endDate": iso_in(1)}).json()
    user.put(f"/v1/events/{old['id']}/saved/me")
    _ended(old["id"])
    assert user.put(f"/v1/events/{new_event(other).json()['id']}/saved/me").status_code == 200
    assert user.put(f"/v1/events/{new_event(other).json()['id']}/saved/me").json()["code"] == "too_many_saved"


def test_who_saved_an_event_hears_when_it_changes(client, user, other):
    event = new_event(user).json()
    assert other.put(f"/v1/events/{event['id']}/saved/me").status_code == 200
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": other.token}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        assert user.delete(f"/v1/events/{event['id']}").status_code == 200
        frame = json.loads(ws.receive_text())
    assert frame["type"] == "event" and frame["event"]["status"] == "cancelled" and frame["event"]["saved"] is True


def test_friends_going_come_first(client):
    organizer, me, friend, stranger = User(client), User(client), User(client), User(client)
    connect(me, friend)
    event = new_event(organizer).json()
    path = f"/v1/events/{event['id']}"
    # Someone who lets everyone know what they do
    stranger.patch("/v1/me", {"storyAudience": "everyone"})
    stranger.put(f"{path}/followers/me")
    friend.put(f"{path}/followers/me")
    seen = me.get(path).json()
    assert seen["followerCount"] == 2 and seen["friendsGoing"] == 1
    assert [p["id"] for p in seen["friends"]] == [friend.id]
    assert [p["id"] for p in seen["followers"]] == [friend.id, stranger.id]
    me.put(f"{path}/followers/me")
    assert [p["id"] for p in me.get(path).json()["followers"]] == [me.id, friend.id, stranger.id]
    # In the lists too (a summary)
    nearby = me.get("/v1/me/events").json()["followed"]
    assert next(e for e in nearby if e["id"] == event["id"])["friendsGoing"] == 1


def test_someones_connections_mutual_first(client):
    me, them, mutual, other_one, blocked = User(client), User(client, "Zed"), User(client, "Yan"), User(client, "Abe"), User(client)
    for person in (mutual, other_one, blocked):
        connect(them, person)
    connect(me, mutual)
    me.put(f"/v1/me/blocks/{blocked.id}")
    them.patch("/v1/me", {"storyAudience": "everyone"})
    answer = me.get(f"/v1/users/{them.id}/connections").json()
    # (new accounts also get the demo people as connections: only the test's matter)
    ours = [entry for entry in answer["items"] if entry["user"]["id"] in {mutual.id, other_one.id, blocked.id}]
    assert [entry["user"]["id"] for entry in ours] == [mutual.id, other_one.id]
    assert [entry["mutual"] for entry in ours] == [True, False]
    # The mutual ones come first
    flags = [entry["mutual"] for entry in answer["items"]]
    assert flags == sorted(flags, reverse=True)
    assert answer["total"] == len(store.connections[them.id])


def test_the_story_shows_what_its_owner_chose(client):
    owner, viewer = User(client), User(client)
    owner.patch("/v1/me", {"storyAudience": "everyone"})
    organized = new_event(owner).json()
    elsewhere = new_event(viewer).json()
    owner.put(f"/v1/events/{elsewhere['id']}/followers/me")
    story = lambda person: {item["id"]: item for item in person.get(f"/v1/users/{owner.id}/activity").json()["items"]}  # noqa: E731
    assert {f"o-{organized['id']}", f"j-{elsewhere['id']}"} <= set(story(viewer))
    # One moment hidden; every "going" hidden
    assert owner.put(f"/v1/me/story/hidden/o-{organized['id']}").status_code == 204
    assert owner.patch("/v1/me", {"story": {"going": False}}).json()["story"]["going"] is False
    assert story(viewer) == {}
    # The owner still sees them, marked
    own = story(owner)
    assert own[f"o-{organized['id']}"]["hidden"] is True and own[f"j-{elsewhere['id']}"]["hidden"] is True
    owner.delete(f"/v1/me/story/hidden/o-{organized['id']}")
    owner.patch("/v1/me", {"story": {"going": True}})
    assert len(story(viewer)) == 2
    assert owner.patch("/v1/me", {"story": {"dragons": True}}).status_code == 400
    assert owner.put("/v1/me/story/hidden/xx").status_code == 400


def test_notifications_gather_and_follow_the_settings(client):
    organizer, a, b, c = User(client), User(client, "Ann"), User(client, "Bob"), User(client, "Cy")
    event = new_event(organizer).json()
    path = f"/v1/events/{event['id']}"
    for person in (a, b):
        person.put(f"{path}/followers/me")
    mine = organizer.get("/v1/me/notifications").json()
    assert mine["unread"] == 1
    joined = mine["items"][0]
    assert joined["kind"] == "event.joined" and joined["count"] == 2
    assert [p["id"] for p in joined["actors"]] == [b.id, a.id] and joined["event"]["id"] == event["id"]
    # Read: the next one starts a new notification
    assert organizer.post("/v1/me/notifications/read").json() == {"unread": 0}
    organizer.patch("/v1/me", {"settings": {"notifyEventUpdates": False}})
    c.put(f"{path}/followers/me")
    assert organizer.get("/v1/me/notifications").json()["unread"] == 0


def test_its_people_hear_of_changes_and_cancellation(client):
    organizer, going, saver = User(client), User(client), User(client)
    event = new_event(organizer).json()
    path = f"/v1/events/{event['id']}"
    going.put(f"{path}/followers/me")
    saver.put(f"{path}/saved/me")
    organizer.patch(path, {"title": "Only the title"})
    assert going.get("/v1/me/notifications").json()["unread"] == 0
    organizer.patch(path, {"dates": {"startDate": iso_in(3), "endDate": iso_in(4)}})
    changed = going.get("/v1/me/notifications").json()["items"][0]
    assert changed["kind"] == "event.changed" and changed["data"]["changes"] == ["time"]
    organizer.delete(path)
    kinds = [n["kind"] for n in going.get("/v1/me/notifications").json()["items"]]
    assert kinds[0] == "event.cancelled"
    # A bookmark is private: nobody is told about it, and it hears nothing
    assert saver.get("/v1/me/notifications").json()["items"] == []


def test_starting_soon_once_and_nothing_from_the_blocked(client):
    organizer, going, blocker = User(client), User(client), User(client)
    event = new_event(organizer, dates={"startDate": iso_in(0.5), "endDate": iso_in(2)}).json()
    going.put(f"/v1/events/{event['id']}/followers/me")
    notifications.remind_starting(now_ms())
    notifications.remind_starting(now_ms())
    kinds = [n["kind"] for n in going.get("/v1/me/notifications").json()["items"]]
    assert kinds.count("event.starting") == 1
    # Blocked: their joining is not told
    organizer.put(f"/v1/me/blocks/{blocker.id}")
    before = organizer.get("/v1/me/notifications").json()["items"]
    blocker_event = new_event(organizer).json()
    assert blocker.put(f"/v1/events/{blocker_event['id']}/followers/me").status_code == 404
    assert organizer.get("/v1/me/notifications").json()["items"] == before


def test_the_story_of_someone_else_shows_no_event_of_who_blocked_the_user(client):
    viewer, owner, organizer = User(client), User(client), User(client)
    store.connect(viewer.id, owner.id, None)
    event = new_event(organizer).json()
    assert owner.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    story = lambda: [item["event"]["id"] for item in viewer.get(f"/v1/users/{owner.id}/activity").json()["items"] if item["event"]]  # noqa: E731
    assert event["id"] in story()
    assert organizer.put(f"/v1/me/blocks/{viewer.id}").status_code == 204
    assert event["id"] not in story()


def test_a_phone_is_one_persons_at_a_time(client):
    first, second = User(client), User(client)
    body = {"token": "ExponentPushToken[same-phone]", "platform": "ios"}
    assert first.post("/v1/me/push-tokens", body).status_code == 204
    assert second.post("/v1/me/push-tokens", body).status_code == 204
    assert body["token"] not in store.users[first.id].push_tokens
    assert body["token"] in store.users[second.id].push_tokens
    assert second.delete(f"/v1/me/push-tokens/{body['token']}").status_code == 204
    assert body["token"] not in store.users[second.id].push_tokens


def test_names_that_read_as_the_app_are_not_free(user):
    answer = user.patch("/v1/me", {"username": "support"})
    assert answer.status_code == 409 and answer.json()["code"] == "username_taken"


def test_you_can_see_whom_you_blocked_they_cannot_see_you(client):
    me, them = User(client), User(client)
    assert me.put(f"/v1/me/blocks/{them.id}").status_code == 204
    profile = me.get(f"/v1/users/{them.id}")
    assert profile.status_code == 200 and profile.json()["relation"]["blocked"] is True
    assert them.get(f"/v1/users/{me.id}").status_code == 404


def test_a_name_fits_the_page(user):
    assert user.patch("/v1/me", {"name": "x" * 30}).status_code == 200
    assert user.patch("/v1/me", {"name": "x" * 31}).status_code == 400
