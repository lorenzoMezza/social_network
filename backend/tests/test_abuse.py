# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""What a hostile or broken client may try: oversized bodies and files, floods, image
bombs, server errors; and that what expires is forgotten."""

import io
import json

from fastapi.testclient import TestClient
from PIL import Image

from conftest import User, jpeg, new_event
from app import janitor
from app.main import app
from app.routes import social


def _ticket(user, size):
    return user.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/png", "fileSize": size}).json()


def _put(user, ticket, data, headers=None):
    path = "/v1/" + ticket["uploadUrl"].split("/v1/", 1)[1]
    return user.client.put(path, content=data, headers=headers or {})


def test_a_file_announced_bigger_than_allowed_is_refused_before_reading(user):
    ticket = _ticket(user, 1000)
    answer = _put(user, ticket, b"x" * 10, headers={"content-length": str(50 * 1024 * 1024)})
    assert answer.status_code in (413, 400)


def test_a_file_bigger_than_announced_is_cut_and_dropped(user):
    ticket = _ticket(user, 1000)

    def chunks():
        for _ in range(100):
            yield b"x" * 4096

    assert _put(user, ticket, chunks()).status_code == 413
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 400  # nothing kept


def test_an_image_bomb_is_refused(user):
    buffer = io.BytesIO()
    Image.new("1", (12000, 12000)).save(buffer, "PNG", optimize=True)
    data = buffer.getvalue()
    assert len(data) < 2_000_000
    ticket = _ticket(user, len(data))
    assert _put(user, ticket, data).status_code == 200
    answer = user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]})
    assert answer.status_code == 422 and answer.json()["code"] == "moderated"


def test_huge_json_bodies_are_refused(user):
    answer = user.client.patch("/v1/me", headers={**user.headers, "Content-Type": "application/json"}, content=json.dumps({"bio": "x" * 300_000}))
    assert answer.status_code == 413


def test_message_floods_are_slowed_down(user):
    chat = next(c for c in user.get("/v1/chats").json()["items"] if c["kind"] == "group" and c["canWrite"])
    statuses = [user.post(f"/v1/chats/{chat['id']}/messages", {"text": f"spam {n}"}).status_code for n in range(25)]
    assert statuses.count(201) == 20 and statuses[-1] == 429
    answer = user.post(f"/v1/chats/{chat['id']}/messages", {"text": "again"})
    assert int(answer.headers["retry-after"]) >= 1
    # A retry of a message already sent is not a new one
    assert user.post(f"/v1/chats/{chat['id']}/messages", {"text": "spam", "clientId": "x"}).status_code == 429


def test_socket_floods_are_closed(client):
    user = User(client)
    with client.websocket_connect("/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": user.token}))
        assert json.loads(ws.receive_text())["type"] == "ready"
        closed = False
        for _ in range(200):
            ws.send_text(json.dumps({"type": "ping"}))
        for _ in range(200):
            message = ws.receive()
            if message["type"] == "websocket.close":
                closed = message["code"] == 1008
                break
        assert closed


def test_unexpected_errors_reveal_nothing(monkeypatch):
    user_client = TestClient(app, raise_server_exceptions=False)
    user = User(user_client)
    assert new_event(user).status_code == 201

    def broken(*_args, **_kwargs):
        raise RuntimeError("secret internals /etc/passwd")

    monkeypatch.setattr("app.routes.events.event_summary", broken)
    answer = user.get("/v1/me/events")
    assert answer.status_code == 500
    assert answer.json() == {"code": "internal", "message": "something went wrong"}
    assert "secret" not in answer.text


def test_the_janitor_forgets_what_expired(user):
    session = user.post("/v1/connections/sessions", {"location": None}).json()
    social.sessions[session["sessionId"]]["created"] = 0
    social.tokens[session["token"]]["expiresAt"] = 0
    janitor.sweep()
    assert session["sessionId"] not in social.sessions
    assert session["token"] not in social.tokens


def test_good_uploads_still_work(user):
    data = jpeg()
    ticket = user.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": len(data)}).json()
    assert _put(user, ticket, data).status_code == 200
    assert user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]}).status_code == 200
