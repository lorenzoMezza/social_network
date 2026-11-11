# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Starts the development data over (make reset-data): the demo world seeded fresh.

    .venv/bin/python -m app.reset        # with the server stopped (it saves its state)

Kept: the real accounts (who signed in), with what is theirs to keep: name, username,
email, bio, picture, avatar, profile style, settings, consents, push tokens. Everything
else goes: events, chats, connections, blocks, albums, notifications, promotions and
credits, reports, the demo areas, and the pictures nothing kept shows. At their next
request each account gets the demo world again, as a new one would (seed.py).
"""

import shutil

from . import config, persistence
from .store import DEFAULT_STORY, Store, store

KEPT_FIELDS = ("id", "username", "name", "email", "bio", "picture_url", "style", "settings", "created_at",
               "avatar", "avatar_version", "push_tokens", "consents", "named", "story_audience")


def reset() -> list[str]:
    loaded = persistence.load()
    real = [user for user in store.users.values() if not user.bot] if loaded else []
    kept = {user.id: {name: getattr(user, name) for name in KEPT_FIELDS} for user in real}

    # A fresh store, with the demo people (seed runs when imported) and the real accounts
    store.__dict__.clear()
    store.__dict__.update(Store().__dict__)
    from . import seed  # noqa: F401  (the demo people)
    seed._make_bots()
    seed.connect_bots()
    from .store import User
    for fields in kept.values():
        user = User(**fields)
        user.story = dict(DEFAULT_STORY)
        store.add_user(user)

    # Pictures: only the kept accounts' own; uploads in progress go
    keep = {user.picture_url[len("media:"):] for user in store.users.values() if (user.picture_url or "").startswith("media:")}
    media = config.MEDIA_DIR
    if media.exists():
        for path in media.rglob("*"):
            if path.is_file() and path.relative_to(media).as_posix() not in keep:
                path.unlink()
        for path in sorted(media.rglob("*"), reverse=True):
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    shutil.rmtree(media / "uploads", ignore_errors=True)
    (media / "uploads").mkdir(parents=True, exist_ok=True)

    persistence.save()
    return [user.username for user in real]


if __name__ == "__main__":
    if not persistence.ENABLED:
        raise SystemExit("PERSIST=0: nothing is saved, nothing to reset")
    names = reset()
    print(f"Development data reset. Accounts kept: {', '.join('@' + n for n in names) or 'none'}")
