# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""An event's pictures (PATCH /events/{id} images): ordered, at most six, the first
its cover; kept by url or added from uploads; checked before anything is used."""

from conftest import new_event
from test_privacy import upload


def test_pictures_in_order(user):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    first, second = upload(user, "event-cover", event["id"]), upload(user, "event-cover", event["id"])
    urls = user.patch(path, {"images": [{"uploadId": first}, {"uploadId": second}]}).json()["imageUrls"]
    assert len(urls) == 2
    # Reordered and one dropped: the same files, no new upload needed
    assert user.patch(path, {"images": [{"url": urls[1]}, {"url": urls[0]}]}).json()["imageUrls"] == [urls[1], urls[0]]
    assert user.patch(path, {"images": [{"url": urls[0]}]}).json()["imageUrls"] == [urls[0]]
    assert user.patch(path, {"images": []}).json()["imageUrls"] == []


def test_bad_pictures_change_nothing(user, other):
    event = new_event(user).json()
    path = f"/v1/events/{event['id']}"
    good = upload(user, "event-cover", event["id"])
    for bad in ([{"url": "https://elsewhere.example/x.jpg"}], [{"uploadId": "nope"}], [{"nothing": 1}], "x",
                [{"uploadId": good, "url": "x"}], [{"uploadId": good}, {"uploadId": good}]):
        assert user.patch(path, {"images": bad}).status_code == 400, bad
    # A bad second item left the good first upload unused: it still works
    assert user.patch(path, {"images": [{"uploadId": good}, {"uploadId": "nope"}]}).status_code == 400
    assert len(user.patch(path, {"images": [{"uploadId": good}]}).json()["imageUrls"]) == 1
    # Used once only
    assert user.patch(path, {"images": [{"uploadId": good}]}).status_code == 410
    # At most six
    many = [{"uploadId": upload(user, "event-cover", event["id"])} for _ in range(7)]
    assert user.patch(path, {"images": many}).status_code == 400


def test_only_the_organizer_and_their_uploads(user, other):
    event = new_event(user).json()
    mine = upload(user, "event-cover", event["id"])
    assert other.patch(f"/v1/events/{event['id']}", {"images": [{"uploadId": mine}]}).status_code == 403
    # An upload made for another event is not taken
    elsewhere = new_event(user).json()
    theirs = upload(user, "event-cover", elsewhere["id"])
    assert user.patch(f"/v1/events/{event['id']}", {"images": [{"uploadId": theirs}]}).status_code == 400


def test_an_iphone_heic_photo_is_read(user):
    """iOS can hand over the HEIC original whatever the app asked for"""
    import io
    from PIL import Image
    from test_privacy import _storage_put, _ticket
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 80, 40)).save(buffer, format="HEIF")
    heic = buffer.getvalue()
    event = new_event(user).json()
    ticket = user.post("/v1/uploads", {**_ticket(event["id"], "event-cover"), "fileSize": len(heic)}).json()
    assert _storage_put(user.client, ticket, heic).status_code == 200
    assert len(user.patch(f"/v1/events/{event['id']}", {"images": [{"uploadId": ticket["uploadId"]}]}).json()["imageUrls"]) == 1
