# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""GDPR rights in the API: deleting an account removes everything that is the user's
(files too), and the copy of one's data comes through a one-time link."""

from conftest import iso_in, jpeg, new_event
from test_security import _add_photo, _storage_put, _ticket

from app import config
from app.store import store


def media_files():
    return {path for path in config.MEDIA_DIR.rglob("*.jpg") if "uploads" not in path.parts}


def upload(user, purpose, event_id=None):
    ticket = user.post("/v1/uploads", _ticket(event_id, purpose)).json()
    assert _storage_put(user.client, ticket, jpeg()).status_code == 200
    return ticket["uploadId"]


def live_event(user):
    return new_event(user, dates={"startDate": iso_in(-0.05), "endDate": iso_in(2)}).json()


def test_replaced_picture_leaves_no_file(user):
    before = media_files()
    user.put("/v1/me/picture", {"uploadId": upload(user, "profile-picture")})
    first = media_files() - before
    assert first
    user.put("/v1/me/picture", {"uploadId": upload(user, "profile-picture")})
    assert not (first & media_files()), "the old picture is still on disk"
    user.delete("/v1/me/picture")
    assert media_files() == before


def test_removed_photo_leaves_no_file(user):
    event = live_event(user)
    before = media_files()
    photo = _add_photo(user, event["id"])
    assert user.delete(f"/v1/events/{event['id']}/photos/{photo['id']}").status_code == 204
    assert media_files() == before


def test_delete_account_removes_everything(user, other):
    before = media_files()
    uid = user.me["id"]
    user.put("/v1/me/picture", {"uploadId": upload(user, "profile-picture")})
    # Their own event, with a cover and a photo
    mine = live_event(user)
    assert user.patch(f"/v1/events/{mine['id']}", {"coverUploadId": upload(user, "event-cover", mine["id"])}).status_code == 200
    _add_photo(user, mine["id"])
    # On someone else's event: saved, a photo in its album, a message in its chat
    theirs = live_event(other)
    user.put(f"/v1/events/{theirs['id']}/followers/me")
    _add_photo(user, theirs["id"])
    assert user.post(f"/v1/chats/event:{theirs['id']}/messages", {"text": "hello", "clientId": "c1"}).status_code == 201
    # A block, a report filed, an upload never used
    user.put(f"/v1/me/blocks/{other.me['id']}")
    assert user.post("/v1/reports", {"kind": "user", "targetId": other.me["id"], "reasons": ["spam"]}).status_code == 201
    upload(user, "profile-picture")

    assert user.delete("/v1/me").status_code == 204
    assert uid not in store.users
    assert mine["id"] not in store.events and mine["id"] not in store.albums
    assert media_files() == before, "files of the deleted account are still on disk"
    assert all(photo.author_id != uid for album in store.albums.values() for photo in album.photos)
    assert all(message.sender != uid for messages in store.messages.values() for message in messages)
    assert uid not in store.blocks and all(uid not in blocked for blocked in store.blocks.values())
    assert all(uid not in followers for followers in store.followers.values())
    assert all(report.get("by") != uid for report in store.reports)
    assert all(item.user_id != uid for item in store.uploads.values())
    # Their event is gone for the others too
    assert other.get(f"/v1/events/{mine['id']}").status_code == 404


def test_export_is_a_one_time_link(user, client):
    answer = user.post("/v1/me/export")
    assert answer.status_code == 200
    path = "/v1/" + answer.json()["url"].split("/v1/", 1)[1]
    copy = client.get(path)
    assert copy.status_code == 200
    assert "attachment" in copy.headers["content-disposition"]
    assert copy.headers["cache-control"] == "no-store"
    data = copy.json()
    assert data["account"]["id"] == user.me["id"]
    for key in ("settings", "avatar", "connections", "blocked", "eventsOrganized", "chats", "reportsFiled"):
        assert key in data
    # Once only, and never for a made-up token
    assert client.get(path).status_code == 410
    assert client.get("/v1/exports/" + "x" * 43).status_code == 410


def test_export_needs_sign_in(client):
    assert client.post("/v1/me/export").status_code == 401


def test_consent_is_recorded_and_exported(user, client):
    assert user.put("/v1/me/consents/location-sharing", {"version": 1, "mode": "visible"}).status_code == 204
    assert user.put("/v1/me/consents/marketing", {"version": 1}).status_code == 400
    assert user.put("/v1/me/consents/location-sharing", {"version": "1"}).status_code == 400
    url = user.post("/v1/me/export").json()["url"]
    data = client.get("/v1/" + url.split("/v1/", 1)[1]).json()
    [entry] = data["consents"]["location-sharing"]
    assert entry["version"] == 1 and entry["mode"] == "visible" and entry["at"].endswith("Z")


def test_uploaded_pictures_lose_their_metadata(user):
    import io

    from PIL import Image

    # A photo that says where it was taken (EXIF GPS)
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (41.0, 53.0, 43.0), 3: "E", 4: (12.0, 29.0, 30.0)}
    exif[0x010F] = "PhoneMaker"
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 10, 10)).save(buffer, "JPEG", exif=exif)
    data = buffer.getvalue()
    ticket = user.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": len(data)}).json()
    assert _storage_put(user.client, ticket, data).status_code == 200
    before = media_files()
    user.put("/v1/me/picture", {"uploadId": ticket["uploadId"]})
    [stored] = media_files() - before
    kept = Image.open(stored)
    assert not kept.getexif(), "the stored picture still carries EXIF"
    assert "exif" not in kept.info


def test_retention_policy(user):
    from app import privacy

    event = live_event(user)
    user.post(f"/v1/chats/event:{event['id']}/messages", {"text": "see you", "clientId": "r1"})
    photo = _add_photo(user, event["id"])
    store.reports.append({"id": "old", "by": None, "kind": "user", "targetId": "x", "reasons": ["spam"], "details": "", "at": 0})
    stored = store.events[event["id"]]
    # A month after the end: the chat goes, the event stays
    later = stored.end + privacy.EVENT_CHAT_KEPT_MS + 1
    privacy.retention_sweep(later)
    assert f"event:{event['id']}" not in store.messages
    assert event["id"] in store.events
    assert all(report["id"] != "old" for report in store.reports)
    # A year after: the event, its album and their files go
    before = {path for path in media_files()}
    privacy.retention_sweep(stored.end + privacy.EVENT_KEPT_MS + 1)
    assert event["id"] not in store.events and event["id"] not in store.albums
    assert not any(photo["id"] in str(path) for path in media_files())
    assert len(media_files()) < len(before)
