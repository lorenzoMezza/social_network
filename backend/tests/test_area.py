# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Approximate mode (API.md presence): the point shown never gives the real place away,
neither by watching it for hours nor by computing it from public data."""

import random

from app import realtime
from app.realtime import Presence, _area_point
from app.util import distance_m

LAT, LON = 41.8953, 12.4918


def presence(user_id, lat, lon):
    return Presence(user_id=user_id, mode="approximate", latitude=lat, longitude=lon)


def test_within_about_300_m():
    rng = random.Random(7)
    for i in range(500):
        lat, lon = LAT + rng.uniform(-0.05, 0.05), LON + rng.uniform(-0.05, 0.05)
        shown = _area_point(presence(f"u{i}", lat, lon))
        assert distance_m(lat, lon, *shown) < 320


def test_moving_inside_the_square_shows_nothing_new():
    # Wherever they stand in their square, the same point: averaging reveals no more than the square
    shown = {_area_point(presence("same", LAT + d, LON + d)) for d in (0.0, 0.0002, 0.0004, 0.0006)}
    rows = {int(round(point[0], 6) * 1e6) for point in shown}
    assert len(shown) <= 2 and len(rows) <= 2


def test_not_computable_from_public_data(monkeypatch):
    first = _area_point(presence("someone", LAT, LON))
    # Another server key, another point: the jitter is the server's secret
    monkeypatch.setattr(realtime, "_AREA_KEY", b"another key" * 3)
    assert _area_point(presence("someone", LAT, LON)) != first


def test_people_differ_in_the_same_square():
    points = {_area_point(presence(f"p{i}", LAT, LON)) for i in range(20)}
    assert len(points) == 20
