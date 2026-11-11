# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Settings of the development server, from the environment."""

import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent

PORT = int(os.environ.get("PORT", "7777"))

# Logto (docs/API.md, Conventions)
LOGTO_ISSUER = os.environ.get("LOGTO_ISSUER", "https://bl5ooc.logto.app/oidc")
LOGTO_JWKS_URL = os.environ.get("LOGTO_JWKS_URL", f"{LOGTO_ISSUER}/jwks")
LOGTO_USERINFO_URL = os.environ.get("LOGTO_USERINFO_URL", f"{LOGTO_ISSUER}/me")
# The API resource (the `aud` of access tokens): checked when set
API_RESOURCE = os.environ.get("API_RESOURCE") or None
# The app's client ID at Logto: the `aud` of its ID tokens (X-Id-Token)
LOGTO_APP_ID = os.environ.get("LOGTO_APP_ID", "n5b35te70myyr7cafk5ed")
# The oldest app still served, "1.2.0": older ones answer 426 and ask to update
MIN_APP_VERSION = os.environ.get("MIN_APP_VERSION") or None
# Development only, off unless asked for (scripts/dev.mjs): accept tokens whose signature
# cannot be checked because Logto cannot be reached (offline), reading their `sub`. On a
# public server this would let anyone sign in as anyone.
TRUST_UNVERIFIED_TOKENS = os.environ.get("TRUST_UNVERIFIED_TOKENS", "0") == "1"

# Public addresses in answers (pictures, upload URLs). Unset: taken from the request,
# so a phone on the LAN gets the computer's address.
PUBLIC_URL = os.environ.get("PUBLIC_URL") or None
# The avatar assets (catalog, item files, preset pictures): the local avatar server
ASSETS_URL = os.environ.get("ASSETS_URL") or None
ASSETS_PORT = int(os.environ.get("ASSETS_PORT", "8092"))
AVATAR_LIBRARY = Path(os.environ.get("AVATAR_LIBRARY", REPO / "avatar-server" / "library"))
# Who makes the map avatars (avatar-server: POST /v1/map-avatars), reached from this
# server; empty: none are made (people show as the stand-in). The secret, when that
# server is not on this computer (AVATAR_BAKE_SECRET there too)
AVATAR_BAKER_URL = os.environ.get("AVATAR_BAKER_URL", f"http://127.0.0.1:{ASSETS_PORT}")
AVATAR_BAKE_SECRET = os.environ.get("AVATAR_BAKE_SECRET", "")
AVATAR_BAKE_TIMEOUT_S = float(os.environ.get("AVATAR_BAKE_TIMEOUT_S", "30"))

# Where the server keeps its files: uploads and the saved state (persistence.py)
# PERSIST=0 (start empty, save nothing) never touches the saved folder: a temporary one
DATA_DIR = Path(os.environ.get("DATA_DIR") or (
    ROOT / ".data" if os.environ.get("PERSIST", "1") == "1" else tempfile.mkdtemp(prefix="api-volatile-")))
MEDIA_DIR = DATA_DIR / "media"
UPLOAD_MAX_BYTES = 20 * 1024 * 1024

# The development world, off unless asked for (scripts/dev.mjs): test purchases (free
# credits, platform "dev"), the API's documentation, the demo people and events. A server started with nothing set has none of it.
DEV_TOOLS = os.environ.get("DEV_TOOLS", "0") == "1"
# The showcase recordings (show-case/tools/ready.sh): the app signs in without Logto, with a
# token "showcase.<name>" this server takes as that person. Development only
SHOWCASE = os.environ.get("SHOWCASE", "0") == "1"
# PRODUCTION=1: the server does not start unless all of this holds (API.md, Security)
PRODUCTION = os.environ.get("PRODUCTION", "0") == "1"


def production_problems() -> list[str]:
    """What makes this configuration unsafe for real users"""
    return [problem for unsafe, problem in (
        (not API_RESOURCE, "API_RESOURCE is not set: tokens meant for other services would be accepted"),
        (TRUST_UNVERIFIED_TOKENS, "TRUST_UNVERIFIED_TOKENS is on: anyone could sign in as anyone"),
        (SHOWCASE, "SHOWCASE is on: anyone could sign in as a showcase person"),
        (DEV_TOOLS, "DEV_TOOLS is on: free credits and demo people"),
        (APPLE_ALLOW_SANDBOX, "APPLE_ALLOW_SANDBOX is on: free credits from sandbox purchases"),
        (GOOGLE_ALLOW_TEST_PURCHASES, "GOOGLE_ALLOW_TEST_PURCHASES is on: free credits from test purchases"),
        (not (PUBLIC_URL or "").startswith("https://"), "PUBLIC_URL is not https: addresses would be taken from the request's Host"),
        (not (ASSETS_URL or "").startswith("https://"), "ASSETS_URL is not https"),
        (not AVATAR_BAKE_SECRET, "AVATAR_BAKE_SECRET is not set: the avatar server takes anyone behind a local proxy"),
        (not (AVATAR_LIBRARY / "catalog.json").is_file(), "AVATAR_LIBRARY has no catalog.json: avatars could not be checked against it"),
    ) if unsafe]

# The fastest anyone really travels (m/s, a plane): a position farther than this from the
# last one is refused (position_guard.py). To jump around on a simulator while
# developing: a huge value here, or restart the server (it remembers in memory only).
MAX_TRAVEL_SPEED_MPS = float(os.environ.get("MAX_TRAVEL_SPEED_MPS", "340"))

# Store purchases of promotion credits, checked here before they are credited
# (stores.py, PROMOTIONS.md). Unset: purchases of that store answer 503 unavailable.
# Apple: the app's bundle id and Apple Root CA - G3 (DER, from apple.com/certificateauthority),
# the root every StoreKit 2 transaction is signed under; sandbox transactions (TestFlight,
# development builds) only when APPLE_ALLOW_SANDBOX=1
APPLE_BUNDLE_ID = os.environ.get("APPLE_BUNDLE_ID") or None
APPLE_ROOT_CA = os.environ.get("APPLE_ROOT_CA") or None
APPLE_ALLOW_SANDBOX = os.environ.get("APPLE_ALLOW_SANDBOX", "0") == "1"
# Google Play: the app's package name and a service account (JSON key) allowed to read
# its orders (Play Console › Users and permissions)
GOOGLE_PACKAGE_NAME = os.environ.get("GOOGLE_PACKAGE_NAME") or None
GOOGLE_SERVICE_ACCOUNT_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE") or None
# Real-time developer notifications (refunds), pushed by Pub/Sub to
# /v1/store/google/notifications?secret=…
GOOGLE_RTDN_SECRET = os.environ.get("GOOGLE_RTDN_SECRET") or None
# Purchases of licence-testing accounts, which pay nothing: only on a test server
GOOGLE_ALLOW_TEST_PURCHASES = os.environ.get("GOOGLE_ALLOW_TEST_PURCHASES", "0") == "1"
