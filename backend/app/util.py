# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Small helpers: time, ids, geometry, text."""

import math
import re
import secrets
import time
from datetime import datetime, timezone

METRES_PER_DEGREE = 111_320
HOUR = 3600 * 1000
DAY = 24 * HOUR


# Controls, and what turns or hides text on screen: a name reading as someone else's, a
# link reading backwards. The joiner of emoji (U+200D) stays.
_HIDDEN = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]")


def plain_text(value: str) -> str:
    """Text people wrote, without what they should not be able to hide in it"""
    return _HIDDEN.sub("", value)


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms % 1000):03d}Z"


def parse_iso(value) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(9)}"


def distance_m(lat1, lon1, lat2, lon2) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    h = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def offset(lat, lon, east_m, north_m):
    return (
        lat + north_m / METRES_PER_DEGREE,
        lon + east_m / (METRES_PER_DEGREE * math.cos(math.radians(lat))),
    )


def offset_bearing(lat, lon, metres, bearing_deg):
    b = math.radians(bearing_deg)
    return offset(lat, lon, math.sin(b) * metres, math.cos(b) * metres)


def unit_hash(text: str) -> float:
    """0–1, the same for the same text (FNV-1a, like the app's mocks)."""
    h = 2166136261
    for char in text:
        h = ((h ^ ord(char)) * 16777619) & 0xFFFFFFFF
    return h / 4294967296
