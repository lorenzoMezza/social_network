# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""What can be uploaded and how much (API.md, Uploads, Albums): only pictures, with nothing
of what the file said about itself, and limits nobody can get around."""

import io
from pathlib import Path

from conftest import User, jpeg, new_event
from PIL import Image
from test_security import _storage_put

from app import config, media
from app.routes import events as events_routes
from app.store import Photo, store
from app.util import now_ms


def _sent(user, data, purpose="profile-picture", event_id=None):
    ticket = user.post("/v1/uploads", {"purpose": purpose, "eventId": event_id, "mimeType": "image/jpeg", "fileSize": len(data)}).json()
    assert _storage_put(user.client, ticket, data).status_code == 200
    return ticket["uploadId"]


def _files(name: str) -> list[Path]:
    return list((config.MEDIA_DIR / name).glob("*")) if (config.MEDIA_DIR / name).exists() else []


def test_only_four_formats_are_read(user):
    for fmt in ("TIFF", "GIF", "BMP", "PPM"):
        buffer = io.BytesIO()
        Image.new("RGB", (64, 48)).save(buffer, fmt)
        upload = _sent(user, buffer.getvalue())
        assert user.put("/v1/me/picture", {"uploadId": upload}).status_code == 422, fmt
    # Told it is a JPEG, it is something else: what counts is what the file is
    fake = _sent(user, b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 64 48\nshowpage\n")
    assert user.put("/v1/me/picture", {"uploadId": fake}).status_code == 422


def test_nothing_the_file_says_about_itself_stays(user):
    exif = Image.Exif()
    exif[0x010F] = "SecretCamera"
    xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description exif:GPSLatitude="41,53N"/></rdf:RDF></x:xmpmeta>'
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 200)).save(buffer, "JPEG", exif=exif, xmp=xmp, comment=b"SECRET-NOTE at home")
    upload = _sent(user, buffer.getvalue())
    url = user.put("/v1/me/picture", {"uploadId": upload}).json()["pictureUrl"]
    stored = (config.MEDIA_DIR / url.split("/v1/media/")[1]).read_bytes()
    for secret in (b"SECRET-NOTE", b"SecretCamera", b"GPSLatitude", b"Exif"):
        assert secret not in stored, secret


def test_the_original_goes_as_soon_as_it_is_used(user):
    upload = _sent(user, jpeg())
    path = Path(store.uploads[upload].path)
    assert path.exists()
    assert user.put("/v1/me/picture", {"uploadId": upload}).status_code == 200
    assert not path.exists()


def test_nobody_keeps_more_than_a_few_files_waiting(client):
    person = User(client)
    for _ in range(media.PENDING_MAX):
        assert person.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": 1000}).status_code == 200
    answer = person.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": 1000})
    assert answer.status_code == 429 and answer.headers["retry-after"]
    # Tickets and files not used run out: then there is room again
    for upload in store.uploads.values():
        if upload.user_id == person.id:
            upload.expires_at = now_ms() - 1
    assert person.post("/v1/uploads", {"purpose": "profile-picture", "mimeType": "image/jpeg", "fileSize": 1000}).status_code == 200


def _album_event(user, other):
    event = new_event(user).json()
    assert other.put(f"/v1/events/{event['id']}/followers/me").status_code == 200
    # Under way: its album is open
    store.events[event["id"]].start = now_ms() - 60_000
    return event["id"]


def _past_photos(event_id, author, count, created=None):
    album = store.album(event_id)
    for n in range(count):
        album.photos.insert(0, Photo(id=f"ph_{author}{n}", event_id=event_id, url="media:x", thumb_url="media:y", width=1, height=1,
                                     author_id=author, created_at=created or now_ms()))


def _ask_room(person, event_id):
    return person.post("/v1/uploads", {"purpose": "event-photo", "eventId": event_id, "mimeType": "image/jpeg", "fileSize": 1000})


def test_how_many_photos_one_person_adds(user, other, monkeypatch):
    event_id = _album_event(user, other)
    _past_photos(event_id, other.id, events_routes.PHOTOS_PER_PERSON)
    # Refused before the file is sent, and again if one was on its way
    answer = _ask_room(other, event_id)
    assert answer.status_code == 409 and answer.json()["code"] == "photo_limit"
    assert other.get(f"/v1/events/{event_id}/photos").json()["room"] == 0
    # The organizer has more room in their own album; someone else's photos do not count
    assert _ask_room(user, event_id).status_code == 200
    assert user.get(f"/v1/events/{event_id}/photos").json()["room"] == events_routes.PHOTOS_BY_ORGANIZER


def test_a_photo_removed_makes_room(user, other):
    event_id = _album_event(user, other)
    _past_photos(event_id, other.id, events_routes.PHOTOS_PER_PERSON)
    photo = store.album(event_id).photos[0]
    assert other.delete(f"/v1/events/{event_id}/photos/{photo.id}").status_code == 204
    assert other.get(f"/v1/events/{event_id}/photos").json()["room"] == 1


def test_an_album_fills_up(user, other, monkeypatch):
    event_id = _album_event(user, other)
    monkeypatch.setattr(events_routes, "PHOTOS_PER_EVENT", 3)
    _past_photos(event_id, user.id, 3)
    answer = _ask_room(other, event_id)
    assert answer.status_code == 409 and answer.json()["code"] == "album_full"


def test_photos_a_day_and_in_all_across_albums(client, monkeypatch):
    owner, person = User(client), User(client)
    first, second = _album_event(owner, person), _album_event(owner, person)
    monkeypatch.setattr(events_routes, "PHOTOS_PER_DAY", 2)
    _past_photos(first, person.id, 2)
    answer = _ask_room(person, second)
    assert answer.status_code == 409 and answer.json()["code"] == "photo_limit"
    monkeypatch.setattr(events_routes, "PHOTOS_PER_DAY", 100)
    monkeypatch.setattr(events_routes, "PHOTOS_PER_ACCOUNT", 2)
    assert _ask_room(person, second).status_code == 409


def test_a_refused_change_of_an_event_changes_nothing_at_all(user):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    answer = user.patch(path, {"title": "Another title", "images": [{"uploadId": "nope"}]})
    assert answer.status_code == 400
    assert user.get(path).json()["title"] == event["title"]


def test_a_picture_that_cannot_be_read_leaves_nothing_behind(user):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    good = _sent(user, jpeg(), "event-cover", event["id"])
    bad = _sent(user, b"not a picture", "event-cover", event["id"])
    before = _files("covers")
    assert user.patch(path, {"title": "Another title", "images": [{"uploadId": good}, {"uploadId": bad}]}).status_code == 422
    assert _files("covers") == before
    answer = user.get(path).json()
    assert answer["imageUrls"] == [] and answer["title"] == event["title"]
