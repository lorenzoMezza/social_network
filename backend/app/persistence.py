# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Development convenience: the store saved to disk every few seconds when it changed,
and loaded at start, so restarting the server keeps accounts, pictures, chats and
events (presence and connect codes stay in memory only). PERSIST=0 starts empty every
time. The production backend has a real database instead."""

import asyncio
import os
import pickle

from . import config
from .store import store

ENABLED = os.environ.get("PERSIST", "1") == "1"
FILE = config.DATA_DIR / "state.pickle"
EVERY_S = 15


def _snapshot() -> bytes:
    return pickle.dumps(store.__dict__, protocol=pickle.HIGHEST_PROTOCOL)


def load() -> bool:
    if not ENABLED or not FILE.exists():
        return False
    try:
        store.__dict__.update(pickle.loads(FILE.read_bytes()))
        return True
    except (pickle.UnpicklingError, EOFError, AttributeError, ImportError) as error:
        print("Saved state not readable, starting empty:", repr(error))
        return False


def save():
    if ENABLED:
        _write(_snapshot())


async def save_loop():
    last = None
    while True:
        await asyncio.sleep(EVERY_S)
        try:
            data = _snapshot()
            if data != last:
                last = data
                await asyncio.to_thread(_write, data)
        except Exception as error:  # noqa: BLE001 (keep saving next time)
            print("saving state:", repr(error))


def _write(data: bytes):
    temporary = FILE.with_suffix(".tmp")
    FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary.write_bytes(data)
    temporary.replace(FILE)
