# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""In-process tests of the API: an empty server in a temporary folder, tokens signed
locally (the JWKS is never reached), one fresh user per test."""

import io
import itertools
import os
import tempfile
import time
import uuid

os.environ["PERSIST"] = "0"
# The development world is off unless asked for: these tests try it too
os.environ["DEV_TOOLS"] = "1"
os.environ["TRUST_UNVERIFIED_TOKENS"] = "1"
# No avatar server in the tests: map avatars are tested with a stand-in transport
os.environ["AVATAR_BAKER_URL"] = ""
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="api-tests-")

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app import auth  # noqa: E402
from app.main import app  # noqa: E402


def _offline(_token):
    raise jwt.PyJWKClientConnectionError("tests run offline")


auth._verify_jwt = _offline

LAT, LON = 41.8953, 12.4918


def token_for(sub: str, expires_in: int = 3600) -> str:
    return jwt.encode({"sub": sub, "exp": int(time.time()) + expires_in}, "tests", algorithm="HS256")


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client


class User:
    def __init__(self, client, name="Test User"):
        self.id = f"t-{uuid.uuid4().hex[:12]}"
        self.token = token_for(self.id)
        self.client = client
        self.headers = {"Authorization": f"Bearer {self.token}", "X-Profile-Hint": '{"name": "%s"}' % name}
        self.me = self.get("/v1/me").json()
        # New accounts get demo credits (seed.CREDITS): the tests count from none
        from app.store import Wallet, store
        store.wallets[self.id] = Wallet()

    def get(self, path, **kw):
        return self.client.get(path, headers=self.headers, **kw)

    def post(self, path, json=None, **kw):
        return self.client.post(path, headers=self.headers, json=json, **kw)

    def put(self, path, json=None, **kw):
        return self.client.put(path, headers=self.headers, json=json, **kw)

    def patch(self, path, json=None, **kw):
        return self.client.patch(path, headers=self.headers, json=json, **kw)

    def delete(self, path, **kw):
        return self.client.delete(path, headers=self.headers, **kw)


@pytest.fixture
def user(client):
    return User(client)


@pytest.fixture
def other(client):
    return User(client, "Other Person")


def jpeg(width=64, height=48) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buffer, "JPEG")
    return buffer.getvalue()


def iso_in(hours: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + hours * 3600))


_spots = itertools.count()


def new_event(user, **fields):
    """An event of the user. Each one in a place of its own (110 m apart, 3 km south of
    LAT, LON), as two events within 15 m on the map at once are refused."""
    spot = next(_spots)
    body = {
        "title": "Test", "description": "A test event", "categories": ["party"],
        "location": {"latitude": LAT - 0.03 - spot * 0.001, "longitude": LON},
        "dates": {"startDate": iso_in(1), "endDate": iso_in(2)},
    }
    body.update(fields)
    # A flash event comes with where the user is (the app sends it): right there
    if body.get("flash") and "from" not in body:
        body["from"] = body["location"]
    return user.post("/v1/events", body)
