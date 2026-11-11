# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Who may do what: authentication, other people's things, blocks, uploads, files."""

import json

from conftest import LAT, LON, User, jpeg, new_event, token_for


# --- authentication ---

def test_no_or_bad_token_is_refused(client):
    for headers in ({}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer not.a.jwt"},
                    {"Authorization": "Bearer a.b.c"}, {"Authorization": "Bearer " + token_for("x", expires_in=-60)}):
        answer = client.get("/v1/me", headers=headers)
        assert answer.status_code == 401, headers
        assert answer.json()["code"] == "unauthorized"


def test_a_token_without_subject_is_refused(client):
    import jwt
    import time
    token = jwt.encode({"exp": int(time.time()) + 60}, "x", algorithm="HS256")
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


# --- other people's things ---

def test_only_the_organizer_changes_an_event(user, other):
    event = new_event(user).json()
    assert other.patch(f"/v1/events/{event['id']}", {"title": "Mine now"}).status_code == 403
    assert other.delete(f"/v1/events/{event['id']}").status_code == 403
    assert other.put(f"/v1/events/{event['id']}/photos/settings", {"whoCanPost": "everyone"}).status_code == 403
    assert user.get(f"/v1/events/{event['id']}").json()["title"] == "Test"


def test_a_chat_is_only_its_members(user, other):
    chat = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "direct")
    assert other.get(f"/v1/chats/{chat['id']}").status_code == 404
    assert other.get(f"/v1/chats/{chat['id']}/messages").status_code == 404
    assert other.post(f"/v1/chats/{chat['id']}/messages", {"text": "hi"}).status_code == 404
    assert other.post(f"/v1/chats/{chat['id']}/read", {"messageId": "x"}).status_code == 404


def test_groups_belong_to_their_owner(user, other):
    group = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "group" and c["ownerId"] == user.id)
    # Not a member at all
    assert other.patch(f"/v1/chats/{group['id']}", {"title": "x"}).status_code == 404
    # Only connections can be added
    assert user.post(f"/v1/chats/{group['id']}/members", {"userIds": [other.id]}).status_code == 403
    assert user.post("/v1/chats", {"title": "G", "color": "#2F7BFF", "memberIds": [other.id]}).status_code == 403
    # A member who is not the owner cannot rename or remove others
    joined = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "group" and c["ownerId"] != user.id)
    assert user.patch(f"/v1/chats/{joined['id']}", {"title": "x"}).status_code == 403
    owner = joined["ownerId"]
    assert user.delete(f"/v1/chats/{joined['id']}/members/{owner}").status_code == 403
    assert user.delete(f"/v1/chats/{joined['id']}").status_code == 403


def test_direct_chats_only_with_connections_or_nearby(user, other):
    assert user.post("/v1/chats/direct", {"userId": other.id}).status_code == 403
    assert user.post("/v1/chats/direct", {"userId": user.id}).status_code == 404
    assert user.post("/v1/chats/direct", {"userId": "nobody"}).status_code == 404


def test_photos_are_removed_by_their_author_or_the_organizer(user, other):
    event = new_event(user, dates={"startDate": _now_plus(-0.05), "endDate": _now_plus(1)}).json()
    other.put(f"/v1/events/{event['id']}/followers/me")
    photo = _add_photo(other, event["id"])
    stranger = User(user.client)
    assert stranger.delete(f"/v1/events/{event['id']}/photos/{photo['id']}").status_code == 403
    assert user.delete(f"/v1/events/{event['id']}/photos/{photo['id']}").status_code == 204


def test_rules_of_posting_photos(user, other):
    event = new_event(user, dates={"startDate": _now_plus(-0.05), "endDate": _now_plus(1)}).json()
    # Not saved: cannot post
    assert other.post("/v1/uploads", _ticket(event["id"])).status_code == 403
    other.put(f"/v1/events/{event['id']}/followers/me")
    assert other.post("/v1/uploads", _ticket(event["id"])).status_code == 200
    user.put(f"/v1/events/{event['id']}/photos/settings", {"whoCanPost": "organizer", "contributors": []})
    assert other.post("/v1/uploads", _ticket(event["id"])).status_code == 403
    # Contributors must be people who saved it
    assert user.put(f"/v1/events/{event['id']}/photos/settings", {"whoCanPost": "chosen", "contributors": ["nobody"]}).status_code == 400
    # Not yet started: no album
    later = new_event(user).json()
    assert user.post("/v1/uploads", _ticket(later["id"])).status_code == 403


def test_ratings(user, other):
    upcoming = new_event(user).json()
    assert other.post(f"/v1/events/{upcoming['id']}/ratings", {"rating": 8}).status_code == 403
    live = new_event(user, dates={"startDate": _now_plus(-0.05), "endDate": _now_plus(1)}).json()
    assert user.post(f"/v1/events/{live['id']}/ratings", {"rating": 8}).status_code == 403  # the organizer
    # Who never joined it has no say on it
    assert other.post(f"/v1/events/{live['id']}/ratings", {"rating": 8}).status_code == 403
    assert other.put(f"/v1/events/{live['id']}/followers/me").status_code == 200
    for bad in ({"rating": 11}, {"rating": -1}, {"rating": "8"}, {"rating": 8, "comment": "x" * 501}, {}):
        assert other.post(f"/v1/events/{live['id']}/ratings", bad).status_code == 400, bad
    assert other.post(f"/v1/events/{live['id']}/ratings", {"rating": 7.5, "comment": "ok"}).status_code == 201
    assert other.post(f"/v1/events/{live['id']}/ratings", {"rating": 9}).status_code == 409
    assert other.put(f"/v1/events/{live['id']}/ratings/me", {"rating": 9}).json()["rating"] == 9
    assert other.delete(f"/v1/events/{live['id']}/ratings/me").status_code == 204
    assert other.put(f"/v1/events/{live['id']}/ratings/me", {"rating": 9}).status_code == 404


def test_rating_totals_cover_every_rating(client, user, monkeypatch):
    # The list holds the newest ones only; the count and the average are over all
    from app import views
    monkeypatch.setattr(views, "MAX_RATINGS", 2)
    live = new_event(user, dates={"startDate": _now_plus(-0.05), "endDate": _now_plus(1)}).json()
    assert user.get(f"/v1/events/{live['id']}").json()["ratingAverage"] is None
    for value in (4, 6, 8):
        person = User(client)
        assert person.put(f"/v1/events/{live['id']}/followers/me").status_code == 200
        assert person.post(f"/v1/events/{live['id']}/ratings", {"rating": value}).status_code == 201
    detail = user.get(f"/v1/events/{live['id']}").json()
    assert len(detail["ratings"]) == 2
    assert detail["ratingCount"] == 3
    assert detail["ratingAverage"] == 6


# --- blocks ---

def test_blocking_hides_both_ways(user, other):
    event = new_event(other).json()
    assert user.put(f"/v1/me/blocks/{other.id}").status_code == 204
    # The blocked person no longer sees the blocker
    assert other.get(f"/v1/users/{user.id}").status_code == 404
    # The blocker still sees whom they blocked (to unblock), but not their events
    assert user.get(f"/v1/users/{other.id}").json()["relation"]["blocked"] is True
    assert user.get(f"/v1/events/{event['id']}").status_code == 404
    assert user.put(f"/v1/me/blocks/{user.id}").status_code == 404
    assert user.delete(f"/v1/me/blocks/{other.id}").status_code == 204
    assert user.get(f"/v1/events/{event['id']}").status_code == 200


# --- uploads and files ---

def _now_plus(hours):
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + hours * 3600))


def _ticket(event_id=None, purpose="event-photo", size=None):
    body = {"purpose": purpose, "mimeType": "image/jpeg", "fileSize": size or len(jpeg())}
    if event_id:
        body["eventId"] = event_id
    return body


def _storage_put(client, ticket, data):
    url = ticket["uploadUrl"].split("/v1/", 1)[1]
    return client.put("/v1/" + url, content=data, headers={"Content-Type": "image/jpeg"})


def _add_photo(user, event_id):
    ticket = user.post("/v1/uploads", _ticket(event_id)).json()
    assert _storage_put(user.client, ticket, jpeg()).status_code == 200
    answer = user.post(f"/v1/events/{event_id}/photos", {"uploadId": ticket["uploadId"]})
    assert answer.status_code == 201, answer.text
    return answer.json()


def test_upload_tickets_are_checked(user):
    for body, status in [
        ({"purpose": "profile-picture", "mimeType": "image/gif", "fileSize": 10}, 415),
        ({"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": 30 * 1024 * 1024}, 413),
        ({"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": -1}, 400),
        ({"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": "10"}, 400),
        ({"purpose": "anything", "mimeType": "image/jpeg", "fileSize": 10}, 400),
        ({"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": 10, "eventId": "x"}, 400),
    ]:
        assert user.post("/v1/uploads", body).status_code == status, body


def test_the_storage_accepts_only_signed_untampered_addresses(user):
    ticket = user.post("/v1/uploads", _ticket(purpose="profile-picture")).json()
    base, query = ticket["uploadUrl"].split("?")
    tampered = ticket | {"uploadUrl": base + "?" + query.replace("signature=", "signature=0")}
    assert _storage_put(user.client, tampered, jpeg()).status_code == 403
    expired = ticket | {"uploadUrl": base + "?" + query.replace("expires=", "expires=1")}
    assert _storage_put(user.client, expired, jpeg()).status_code == 403
    # Bigger than announced
    assert _storage_put(user.client, ticket, jpeg() + b"x" * 50_000).status_code == 413


def test_an_upload_is_used_once_by_its_owner_for_its_purpose(user, other):
    ticket = user.post("/v1/uploads", _ticket(purpose="profile-picture")).json()
    # Named before the file arrived
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 400
    _storage_put(user.client, ticket, jpeg())
    assert other.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 400
    me = user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]})
    assert me.status_code == 200 and "/v1/media/pictures/" in me.json()["pictureUrl"]
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 410


def test_not_an_image_is_refused(user):
    ticket = user.post("/v1/uploads", _ticket(purpose="profile-picture", size=200)).json()
    _storage_put(user.client, ticket, b"<html><script>alert(1)</script></html>")
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 422


def test_exif_is_stripped(user):
    from io import BytesIO

    from PIL import Image
    image = Image.new("RGB", (80, 60), (200, 10, 10))
    exif = Image.Exif()
    exif[0x8825] = {2: (41.0, 53.0, 43.0)}  # GPS latitude
    exif[0x010F] = "SecretCam"
    buffer = BytesIO()
    image.save(buffer, "JPEG", exif=exif)
    ticket = user.post("/v1/uploads", _ticket(purpose="profile-picture", size=len(buffer.getvalue()))).json()
    _storage_put(user.client, ticket, buffer.getvalue())
    url = user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).json()["pictureUrl"]
    served = user.client.get("/v1/media/" + url.split("/v1/media/", 1)[1])
    assert served.status_code == 200
    assert b"SecretCam" not in served.content
    assert not Image.open(BytesIO(served.content)).getexif()
    assert "immutable" in served.headers["cache-control"]


def test_files_outside_the_media_cannot_be_read(client):
    for path in ["/v1/media/../app/main.py", "/v1/media/..%2F..%2Fapp%2Fmain.py", "/v1/media/%2e%2e/%2e%2e/requirements.txt",
                 "/v1/media/uploads/anything", "/v1/media/", "/v1/media/pictures"]:
        assert client.get(path).status_code == 404, path


# --- input that is not what the API expects ---

def test_bodies_of_the_wrong_shape(user):
    assert user.client.patch("/v1/me", headers=user.headers, content=b"not json").status_code == 400
    assert user.client.patch("/v1/me", headers={**user.headers, "Content-Type": "application/json"}, content=b"[1,2]").status_code == 400
    assert user.patch("/v1/me", {}).status_code == 400
    for bad in ({"name": ""}, {"name": "x" * 51}, {"username": "A B"}, {"username": "ab"}, {"username": ".abc"}, {"username": "a..b"},
                {"bio": "x" * 201}, {"style": {"backdrop": "lava"}}, {"style": {"hack": "x"}}, {"settings": {"notifyMessages": "yes"}}, {"style": "x"}):
        assert user.patch("/v1/me", bad).status_code == 400, bad
    # Normalized like the app does: lowercase, without the @
    handle = f"valid.{user.id[2:10]}"
    assert user.patch("/v1/me", {"username": "@" + handle.upper()}).json()["username"] == handle


def test_events_input_and_queries(user):
    for bad in [{"title": ""}, {"title": "x" * 51}, {"categories": ["dragons"]}, {"categories": []},
                {"location": {"latitude": 91, "longitude": 0}}, {"location": {"latitude": "a"}},
                {"dates": {"startDate": _now_plus(2), "endDate": _now_plus(1)}}, {"dates": {"startDate": _now_plus(-5), "endDate": _now_plus(1)}},
                {"links": "javascript:alert(1)"}, {"spotsNeeded": 99}, {"theme": {"color": "red"}}, {"theme": {"beam": "red"}}, {"theme": {"beamStyle": "laser"}},
                {"flash": True, "dates": {"startDate": _now_plus(3), "endDate": _now_plus(4)}}]:
        assert new_event(user, **bad).status_code == 400, bad
    assert user.get("/v1/events?latitude=95&longitude=0").status_code == 400
    assert user.get("/v1/events?latitude=abc&longitude=0").status_code == 400
    assert user.get("/v1/events").status_code == 400
    assert user.get(f"/v1/events?latitude={LAT}&longitude={LON}&categories=dragons").status_code == 400
    # A huge range is capped, a tiny one widened: never an error, never the world
    assert user.get(f"/v1/events?latitude={LAT}&longitude={LON}&range=99999999").status_code == 200
    assert user.get(f"/v1/events?latitude={LAT}&longitude={LON}&range=-5").status_code == 200


def test_pagination_with_odd_cursors(user):
    chat = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "direct")
    for query in ["limit=-5", "limit=100000", "before=nonsense", "limit=abc"]:
        status = user.get(f"/v1/chats/{chat['id']}/messages?{query}").status_code
        assert status in (200, 400), query
    assert user.get(f"/v1/users/{user.id}/activity?cursor=-3&limit=0").status_code == 200


def test_messages(user):
    chat = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "direct" and c["canWrite"])
    nearby_only = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "direct" and not c["canWrite"])
    assert user.post(f"/v1/chats/{nearby_only['id']}/messages", {"text": "hi"}).status_code == 403
    for bad in ({"text": ""}, {"text": "   "}, {"text": "x" * 1001}, {"text": "hi", "clientId": "x" * 65}, {"text": "hi", "clientId": 5}):
        assert user.post(f"/v1/chats/{chat['id']}/messages", bad).status_code == 400, bad
    first = user.post(f"/v1/chats/{chat['id']}/messages", {"text": "<b>hi</b>", "clientId": "c-1"}).json()
    again = user.post(f"/v1/chats/{chat['id']}/messages", {"text": "<b>hi</b>", "clientId": "c-1"}).json()
    assert first["id"] == again["id"] and first["text"] == "<b>hi</b>"


def test_reports(user, other):
    assert user.post("/v1/reports", {"kind": "user", "targetId": other.id, "reasons": ["spam"]}).status_code == 201
    for bad in ({"kind": "user", "targetId": other.id, "reasons": ["made up"]}, {"kind": "user", "targetId": other.id, "reasons": []},
                {"kind": "planet", "targetId": "x", "reasons": ["spam"]}, {"kind": "user", "targetId": other.id, "reasons": ["spam"], "details": "x" * 501}):
        assert user.post("/v1/reports", bad).status_code == 400, bad
    assert user.post("/v1/reports", {"kind": "user", "targetId": "nobody", "reasons": ["spam"]}).status_code == 404


# --- connecting in person ---

def test_connect_codes_are_single_use_and_not_for_oneself(user, other):
    session = user.post("/v1/connections/sessions", {"location": None}).json()
    assert user.post("/v1/connections/claims", {"token": session["token"]}).json()["code"] == "self"
    session = user.post("/v1/connections/sessions", {"location": None}).json()
    assert other.post("/v1/connections/claims", {"token": session["token"]}).json()["status"] == "connected"
    answer = User(user.client).post("/v1/connections/claims", {"token": session["token"]})
    assert answer.status_code == 410
    assert other.post("/v1/connections/claims", {"token": "made-up-token-xxxxxxxxxxxxx"}).status_code == 410
    assert other.post("/v1/connections/claims", {"token": 42}).status_code == 400
    # Someone else's session is not theirs to read or close
    assert other.get(f"/v1/connections/sessions/{session['sessionId']}").status_code == 404
    assert other.delete(f"/v1/connections/sessions/{session['sessionId']}").status_code == 404


def test_connect_refuses_people_far_apart(user, other):
    import time
    now = int(time.time() * 1000)
    here = {"latitude": LAT, "longitude": LON, "accuracy": 5, "timestamp": now}
    far = {"latitude": LAT + 0.01, "longitude": LON, "accuracy": 5, "timestamp": now}
    session = user.post("/v1/connections/sessions", {"location": here}).json()
    answer = other.post("/v1/connections/claims", {"token": session["token"], "location": far})
    assert answer.status_code == 403 and answer.json()["code"] == "too_far"


def test_connect_rate_limit(user):
    statuses = [user.post("/v1/connections/sessions", {"location": None}).status_code for _ in range(12)]
    assert 429 in statuses


# --- the socket ---

def test_socket_needs_a_valid_first_frame(client):
    for first in ["not json", json.dumps({"type": "hello"}), json.dumps({"type": "auth", "token": "bad"}),
                  json.dumps({"type": "auth", "token": token_for("x", expires_in=-10)})]:
        with client.websocket_connect("/v1/ws") as ws:
            ws.send_text(first)
            message = ws.receive()
            assert message["type"] == "websocket.close" and message["code"] == 4001, first


def test_binary_frames_are_invalid_frames_not_a_crash(client, user):
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_bytes(b"\x00\x01")
        message = ws.receive()
        assert message["type"] == "websocket.close" and message["code"] == 4001
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": user.token}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_bytes(b"\x00\x01")
        assert json.loads(ws.receive_text())["code"] == "bad_request"
        # The socket goes on
        ws.send_text(json.dumps({"type": "ping"}))
        assert json.loads(ws.receive_text()) == {"type": "pong"}


def test_socket_answers_bad_frames_with_errors(client, user):
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": user.token}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        for frame in ["{", "[]", json.dumps({"type": "nope", "ref": "1"}), json.dumps({"type": "presence", "mode": "ghost"}),
                      json.dumps({"type": "presence", "mode": "visible", "position": {"latitude": 999, "longitude": 0}}),
                      json.dumps({"type": "gesture", "to": "nobody", "gesture": "wave"}), json.dumps({"type": "gesture", "to": user.id, "gesture": "slap"}),
                      json.dumps({"type": "broadcast", "text": ""}), json.dumps({"type": "broadcast", "text": "x" * 121})]:
            ws.send_text(frame)
            answer = json.loads(ws.receive_text())
            assert answer["type"] == "error", frame
        # Invisible users say nothing to anyone
        ws.send_text(json.dumps({"type": "presence", "mode": "invisible", "position": None}))
        assert json.loads(ws.receive_text()) == {"type": "presence.snapshot", "people": []}
        ws.send_text(json.dumps({"type": "broadcast", "text": "hello", "ref": "b"}))
        assert json.loads(ws.receive_text())["code"] == "forbidden"
        ws.send_text(json.dumps({"type": "ping"}))
        assert json.loads(ws.receive_text()) == {"type": "pong"}


def test_an_app_too_old_is_asked_to_update(user, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "MIN_APP_VERSION", "1.2.0")
    old = user.client.get("/v1/me", headers={**user.headers, "X-Client": "1.1.9 (ios)"})
    assert old.status_code == 426 and old.json()["code"] == "upgrade_required"
    assert user.client.get("/v1/me", headers={**user.headers, "X-Client": "1.2.0 (android)"}).status_code == 200
    # Nothing to compare: served as ever (a store's notice, a data export in a browser)
    assert user.client.get("/v1/me", headers={**user.headers, "X-Client": "junk"}).status_code == 200
    assert user.get("/v1/me").status_code == 200


def test_a_new_account_believes_only_what_logto_signed(client, monkeypatch):
    from conftest import token_for

    from app import auth, config
    from app.store import store

    monkeypatch.setattr(config, "PRODUCTION", True)
    monkeypatch.setattr(auth, "_id_token_claims", lambda token: {"sub": "t-signed-names", "name": "Signed Name", "email": "real@example.com"} if token == "good" else {"sub": "someone-else", "email": "stolen@example.com"})
    headers = {"Authorization": f"Bearer {token_for('t-signed-names')}", "X-Profile-Hint": '{"name": "Faked", "email": "ceo@example.com"}', "X-Id-Token": "good"}
    assert client.get("/v1/me", headers=headers).json()["email"] == "real@example.com"
    store.users.pop("t-signed-names", None)
    store.by_username.clear()
    # Another person's token names nobody, and the hint counts for nothing in production
    headers["X-Id-Token"] = "bad"
    answer = client.get("/v1/me", headers=headers).json()
    assert answer["email"] != "ceo@example.com" and answer["email"] != "stolen@example.com"
    store.users.pop("t-signed-names", None)


def test_a_sign_in_name_makes_a_handle_the_rules_allow():
    from app.auth import _handle_from
    from app.routes.people import _username_problem
    for name, handle in (("José García", "jose.garcia"), ("MÜLLER.hans", "muller.hans"), ("a" * 29 + ".b", "a" * 29), ("__x..y__", "x.y"), ("Алиса", ""), ("ab", "")):
        made = _handle_from(name.replace(" ", "."))
        assert made == handle
        assert made == "" or _username_problem(made) is None


def test_a_new_line_after_a_valid_value_makes_it_invalid(user):
    # `$` in a pattern also accepts one just before the end: the whole value must match
    assert user.patch("/v1/me", {"username": "sara_m\n"}).status_code == 400
    assert user.patch("/v1/me", {"username": "sara_m"}).status_code == 200


def test_a_sign_in_name_never_takes_a_reserved_handle(client):
    from app.store import store
    assert store.free_username("admin") != "admin" and store.free_username("support") != "support"

