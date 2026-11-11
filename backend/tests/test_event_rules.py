# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Room between events and events on at once (API.md, Events): no event within 15 m of
another not over (the map shows every event until it ends); at most 5 events on per
organizer."""

import itertools

from conftest import LAT, LON, User, iso_in, new_event

# Metres to degrees of latitude
METRE = 1 / 111_320
_places = itertools.count()


def place(north_m=0.0):
    """A place of the test's own (1 km apart, 10 km north of LAT, LON), moved north_m"""
    return {"latitude": LAT + 0.09 + next(_places) * 0.01 + north_m * METRE, "longitude": LON}


def near(location, north_m):
    return {"latitude": location["latitude"] + north_m * METRE, "longitude": location["longitude"]}


def dates(start_h, end_h):
    return {"startDate": iso_in(start_h), "endDate": iso_in(end_h)}


def test_no_event_within_15_m_of_another_at_the_same_time(user, other):
    here = place()
    assert new_event(user, location=here).status_code == 201
    # Someone else, a few metres away, at the same time
    answer = new_event(other, location=near(here, 10))
    assert answer.status_code == 409
    assert answer.json()["code"] == "too_close"
    # 16 m away: room enough
    assert new_event(other, location=near(here, 16)).status_code == 201


def test_the_place_is_taken_until_the_event_ends_whenever_the_other_is(user, other):
    here = place()
    assert new_event(user, location=here, dates=dates(1, 3)).status_code == 201
    # Every event is on the map from its creation: tomorrow's or next week's would be
    # drawn on top of this one
    assert new_event(other, location=here, dates=dates(20, 22)).json()["code"] == "too_close"
    assert new_event(other, location=here, dates=dates(24 * 7, 24 * 7 + 2)).json()["code"] == "too_close"
    # An event far ahead takes the place now too
    later = place()
    assert new_event(user, location=later, dates=dates(24 * 30, 24 * 30 + 2)).status_code == 201
    assert new_event(other, location=near(later, 5), dates=dates(1, 2)).json()["code"] == "too_close"


def test_cancelled_and_ended_events_leave_the_place(user, other):
    here = place()
    first = new_event(user, location=here).json()
    assert new_event(other, location=here).status_code == 409
    assert user.delete(f"/v1/events/{first['id']}").status_code == 200
    assert new_event(other, location=here).status_code == 201


def test_moving_an_event_next_to_another_is_refused(user, other):
    here = place()
    assert new_event(user, location=here).status_code == 201
    theirs = new_event(other, location=place()).json()
    path = f"/v1/events/{theirs['id']}"
    answer = other.patch(path, {"location": near(here, 5)})
    assert answer.status_code == 409 and answer.json()["code"] == "too_close"
    # Nothing changed
    assert other.get(path).json()["location"] == theirs["location"]
    # Other changes do not need the check, and an event never blocks itself
    assert other.patch(path, {"title": "Renamed"}).status_code == 200
    assert other.patch(path, {"location": near(theirs["location"], 3)}).status_code == 200


def test_a_refused_change_changes_nothing(user):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    assert user.patch(path, {"title": "", "description": "New words"}).status_code == 400
    kept = user.get(path).json()
    assert (kept["title"], kept["description"]) == (event["title"], event["description"])


def test_at_most_five_events_on_at_once(client):
    organizer = User(client)
    made = [new_event(organizer, location=place()) for _ in range(5)]
    assert all(answer.status_code == 201 for answer in made)
    answer = new_event(organizer, location=place())
    assert answer.status_code == 409 and answer.json()["code"] == "too_many_events"
    # A flash event counts as well
    flash = new_event(organizer, location=place(), flash=True, dates=dates(0.1, 1))
    assert flash.json()["code"] == "too_many_events"
    # Editing one still works; cancelling one makes room
    first = made[0].json()["id"]
    assert organizer.patch(f"/v1/events/{first}", {"title": "Still mine"}).status_code == 200
    assert organizer.delete(f"/v1/events/{first}").status_code == 200
    assert new_event(organizer, location=place()).status_code == 201
    # Someone else is not affected
    assert new_event(User(client), location=place()).status_code == 201


def test_events_start_at_most_a_month_ahead(user):
    assert new_event(user, location=place(), dates=dates(24 * 30, 24 * 30 + 2)).status_code == 201
    answer = new_event(user, location=place(), dates=dates(24 * 32, 24 * 32 + 2))
    assert answer.status_code == 400
    # Moving one there is refused too; its other changes are not
    event = new_event(user, location=place(), dates=dates(1, 3)).json()
    path = f"/v1/events/{event['id']}"
    assert user.patch(path, {"dates": dates(24 * 40, 24 * 40 + 2)}).status_code == 400
    assert user.patch(path, {"dates": dates(24 * 20, 24 * 20 + 2)}).status_code == 200


def test_a_flash_event_is_made_only_near_its_organizer(user):
    here = place()
    # Where the user is comes with it (invisible: the server keeps no position)
    assert new_event(user, location=near(here, 400), flash=True, dates=dates(0.1, 1), **{"from": here}).status_code == 201
    far = new_event(user, location=near(here, 650), flash=True, dates=dates(0.1, 1), **{"from": here})
    assert far.status_code == 409
    assert far.json()["code"] == "too_far"
    # Without it, and with no presence on the map, there is nothing to check against
    unknown = user.post("/v1/events", {
        "title": "Test", "description": "A test event", "categories": ["party"], "flash": True,
        "location": place(), "dates": dates(0.1, 1),
    })
    assert unknown.status_code == 409
    assert unknown.json()["code"] == "position_needed"
    # Other events are not concerned
    assert new_event(user, location=place()).status_code == 201

