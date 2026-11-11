# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Map avatars (API.md Avatars): the backend asks the avatar server for the key of an
avatar's map files, keeps it per look, and never passes on what is not a key."""

import asyncio

import httpx

from app import avatars, config

REAL_CLIENT = httpx.AsyncClient

AVATAR = {
    "format": "masterkey.avatar",
    "version": 1,
    "bodyShape": "base-avatars:BaseFemale",
    "colors": {"skin": "#DDA77F", "hair": "#5A3A24", "eyes": "#5A3A24"},
    "wearables": {"eyes": "base-avatars:f_eyes_00"},
    "updatedAt": "2026-10-16T00:00:00.000Z",
}


def baker(monkeypatch, answer):
    """The avatar server replaced: `answer(request)` → httpx.Response; answers the calls"""
    calls = []

    def handler(request):
        calls.append(request)
        return answer(request)

    monkeypatch.setattr(avatars.httpx, "AsyncClient", lambda **kwargs: REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(config, "AVATAR_BAKER_URL", "http://baker.test")
    avatars._map_keys.clear()
    return calls


def test_disabled_without_baker(client, user):
    response = user.get(f"/v1/users/{user.get('/v1/me').json()['id']}/avatar")
    assert response.status_code == 200
    assert response.json()["mapAvatar"] is None


def test_key_kept_per_look(monkeypatch):
    calls = baker(monkeypatch, lambda request: httpx.Response(200, json={"key": "a" * 32}))
    assert asyncio.run(avatars.map_avatar(AVATAR)) == "a" * 32
    # The same look again, saved at another time: no new request
    assert asyncio.run(avatars.map_avatar({**AVATAR, "updatedAt": "later"})) == "a" * 32
    assert len(calls) == 1
    # Only the look is sent
    assert b"updatedAt" not in calls[0].content


def test_never_passes_on_a_bad_answer(monkeypatch):
    for answer in (
        lambda request: httpx.Response(200, json={"key": "../../etc/passwd"}),
        lambda request: httpx.Response(200, json={"key": "A" * 32}),
        lambda request: httpx.Response(200, content=b"not json"),
        lambda request: httpx.Response(503, json={"error": "busy"}),
    ):
        baker(monkeypatch, answer)
        assert asyncio.run(avatars.map_avatar(AVATAR)) is None


def test_baker_down_is_not_an_error(monkeypatch, client, user):
    def down(request):
        raise httpx.ConnectError("refused", request=request)

    baker(monkeypatch, down)
    response = user.get(f"/v1/users/{user.get('/v1/me').json()['id']}/avatar")
    assert response.status_code == 200
    assert response.json()["mapAvatar"] is None
