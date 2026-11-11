# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The contract stays one: what the server does, what API.md says and what the app knows
are the same list. A route, an error code, a limit or an allowed value added on one side
and not on the others fails here."""

import glob
import re
from pathlib import Path

from app import limits
from app.routes.events import CATEGORIES, THEME_VALUES
from app.routes.people import STYLE_VALUES
from app.routes.social import REPORT_REASONS

BACKEND = Path(__file__).resolve().parent.parent
API = (BACKEND.parent / "docs" / "API.md").read_text()
APP = "\n".join(Path(f).read_text() for f in glob.glob(str(BACKEND.parent / "src/**/*.js"), recursive=True))
SERVER = {f: Path(f).read_text() for f in glob.glob(str(BACKEND / "app/**/*.py"), recursive=True)}
# Not for the app: the store's upload address, health, the files themselves, the socket
# Not the app's: the health check, the development storage, the showcase recordings (SHOWCASE=1)
OUTSIDE_THE_LIST = {("GET", "/health"), ("GET", "/media/{}"), ("PUT", "/storage/{}"), ("POST", "/dev/showcase/scanned")}


def _plain(path: str) -> str:
    path = re.sub(r"^/v1", "", path.split("?")[0])
    return re.sub(r"\{[^}]+\}", "{}", path).rstrip("/") or "/"


def test_every_route_is_in_the_contract_and_the_other_way_round():
    server = set()
    for text in SERVER.values():
        for method, path in re.findall(r'@(?:router|app)\.(get|post|put|patch|delete)\(\s*"([^"]+)"', text):
            server.add((method.upper(), _plain(path)))
    documented = {(method, _plain(path)) for method, path in re.findall(r"^\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+(/[^`\s]*)", API, re.M)}
    assert server - OUTSIDE_THE_LIST == documented


def test_every_error_code_is_in_the_contract():
    codes = set()
    for text in SERVER.values():
        codes |= set(re.findall(r'ApiError\(\s*\d+\s*,\s*"([a-z_]+)"', text))
        codes |= set(re.findall(r'code="([a-z_]+)"', text))
    assert sorted(code for code in codes if f"`{code}`" not in API) == []


def test_every_limit_is_in_the_contract_with_its_numbers():
    for action, (times, seconds) in limits.RULES.items():
        assert re.search(rf"^\| `{action}` \| {times} \| {seconds} s \|", API, re.M), action


def test_what_the_server_allows_the_app_knows():
    def quoted(value):
        return re.search(rf"['\"`]{re.escape(value)}['\"`]", APP)
    groups = [CATEGORIES, *THEME_VALUES.values(), *STYLE_VALUES.values(), *REPORT_REASONS.values()]
    assert sorted(value for group in groups for value in group if not quoted(value)) == []


def test_every_theme_field_is_in_the_contract():
    for field in ("color", "beam", "beamStyle", "emoji", "background", "title"):
        assert f'"{field}"' in API.split("EventTheme {")[1].split("EventSummary {")[0], field
    for value in THEME_VALUES["beamStyle"]:
        assert value in API.split("EventTheme {")[1].split("EventSummary {")[0], value
