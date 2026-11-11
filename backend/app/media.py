# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Uploads (API.md, Uploads): a signed address per file, the bytes PUT straight to the
storage (here a folder, in production an object storage), then processed when used:
checked to be an image, turned by its EXIF orientation, stripped of every EXIF field
(the GPS position first), resized. Processed files get new immutable names."""

import hashlib
import hmac
import io
import os
import secrets
import shutil
import warnings
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

# iPhones keep their photos as HEIC: a picker can hand over the original (several
# picked at once), whatever the app asked for. Read like any other picture.
register_heif_opener()

from . import config
from .errors import ApiError, bad_request, forbidden, rate_limited
from .store import Upload, store
from .util import iso, new_id, now_ms
from .views import Urls

ALLOWED = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
# What is really read, whatever the client says it sends: these only. Pillow alone knows
# some 40 formats, some of them dangerous to open (EPS runs Ghostscript)
FORMATS = ("JPEG", "PNG", "WEBP", "HEIF")
PURPOSES = {"profile-picture", "event-cover", "event-photo", "group-picture"}
# A ticket is for sending the file now, a file sent is for being used now: nothing waits
# on the storage, and one person holds at most this many at a time (20 MB each)
TICKET_S = 15 * 60
UNUSED_MS = 60 * 60 * 1000
PENDING_MAX = 20
_secret = secrets.token_bytes(32)

# Files of the last session stay with its saved state (persistence.py); unpublished
# uploads do not
shutil.rmtree(config.MEDIA_DIR / "uploads", ignore_errors=True)
if os.environ.get("PERSIST", "1") != "1":
    shutil.rmtree(config.MEDIA_DIR, ignore_errors=True)
(config.MEDIA_DIR / "uploads").mkdir(parents=True, exist_ok=True)


def _signature(upload_id: str, expires: int) -> str:
    return hmac.new(_secret, f"{upload_id}:{expires}".encode(), hashlib.sha256).hexdigest()


def create_ticket(user_id: str, purpose: str, mime_type: str, file_size: int, event_id: str | None, chat_id: str | None = None) -> dict:
    if not isinstance(purpose, str) or purpose not in PURPOSES:
        raise bad_request(f"unknown purpose {purpose!r}")
    if not isinstance(mime_type, str) or mime_type not in ALLOWED:
        raise ApiError(415, "bad_request", "JPEG, PNG, HEIC or WebP only")
    if not isinstance(file_size, int) or file_size <= 0:
        raise bad_request("fileSize must be a positive integer")
    if file_size > config.UPLOAD_MAX_BYTES:
        raise ApiError(413, "too_large", "at most 20 MB")
    now = now_ms()
    if sum(1 for upload in store.uploads.values() if upload.user_id == user_id and not upload.used and upload.expires_at >= now) >= PENDING_MAX:
        raise rate_limited(60)
    expires = now + TICKET_S * 1000
    upload = Upload(id=new_id("up"), user_id=user_id, purpose=purpose, mime_type=mime_type, file_size=file_size, event_id=event_id, expires_at=expires, chat_id=chat_id)
    store.uploads[upload.id] = upload
    return {
        "uploadId": upload.id,
        "uploadUrl": f"{Urls.api}/v1/storage/{upload.id}?expires={expires}&signature={_signature(upload.id, expires)}",
        "headers": {},
        "expiresAt": iso(expires),
    }


def open_address(upload_id: str, expires: int, signature: str) -> tuple[Upload, int]:
    """The storage's side: the upload a signed address is for, and how many bytes it may
    receive (what was announced, a little margin, never more than the limit)."""
    upload = store.uploads.get(upload_id)
    if not upload or not hmac.compare_digest(signature.encode(), _signature(upload_id, expires).encode()) or expires < now_ms():
        raise ApiError(403, "forbidden", "invalid or expired upload address")
    if upload.used:
        raise ApiError(410, "expired", "this upload was used already")
    return upload, min(config.UPLOAD_MAX_BYTES, int(upload.file_size * 1.1) + 1024)


async def receive(upload: Upload, limit: int, chunks):
    """Writes the file as it arrives, stopping as soon as it is bigger than allowed (a
    lying client never fills the memory or the disk)."""
    path = config.MEDIA_DIR / "uploads" / upload.id
    size = 0
    with open(path, "wb") as file:
        async for chunk in chunks:
            size += len(chunk)
            if size > limit:
                file.close()
                path.unlink(missing_ok=True)
                raise ApiError(413, "too_large", "bigger than announced")
            file.write(chunk)
    upload.path = str(path)
    upload.expires_at = now_ms() + UNUSED_MS


def take(upload_id: str, user_id: str, purpose: str, event_id: str | None = None, chat_id: str | None = None) -> Upload:
    upload = store.uploads.get(upload_id) if isinstance(upload_id, str) else None
    if not upload or upload.user_id != user_id or upload.purpose != purpose:
        raise bad_request("unknown upload")
    if upload.event_id != event_id or upload.chat_id != chat_id:
        raise forbidden("the upload was made for something else")
    if upload.used or upload.expires_at < now_ms():
        raise ApiError(410, "expired", "upload expired or already used")
    if not upload.path:
        raise bad_request("the file was never sent")
    upload.used = True
    return upload


# A phone photo has ~12–50 million pixels; more is a "decompression bomb" (a small file
# that expands to gigabytes in memory)
MAX_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def _open(upload: Upload) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(upload.path, formats=FORMATS)
            if image.width * image.height > MAX_PIXELS:
                raise ApiError(422, "moderated", "image too large")
            image.load()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ApiError(422, "moderated", "image too large") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ApiError(422, "moderated", "not an image this server can read") from error
    # The EXIF orientation applied, then no metadata at all is kept (GPS first)
    image = ImageOps.exif_transpose(image).convert("RGB")
    # Not a word of what the file said about itself goes on: saving a JPEG would keep its
    # comment, whatever someone wrote there
    image.info = {}
    return image


def _save(image: Image.Image, folder: str) -> str:
    key = f"{folder}/{secrets.token_urlsafe(16)}.jpg"  # 128 random bits: never guessable
    path = config.MEDIA_DIR / key
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85, optimize=True, progressive=True)
    path.write_bytes(buffer.getvalue())
    # A reference, made a public URL when answered (views.Urls.public)
    return f"media:{key}"


def discard(*references: str | None):
    """Deletes stored pictures ("media:<key>" references) that nothing shows any more:
    a replaced profile picture or cover, a removed photo, a deleted account's files.
    Personal data is not kept on disk after its use ends (GDPR art. 5(1)(c), (e))."""
    root = config.MEDIA_DIR.resolve()
    for reference in references:
        if not isinstance(reference, str) or not reference.startswith("media:"):
            continue
        path = (config.MEDIA_DIR / reference[len("media:"):]).resolve()
        if root in path.parents:
            path.unlink(missing_ok=True)


def discard_upload(upload: Upload):
    """Deletes the file of an upload (sent but never used, or its user leaving)"""
    if not upload.path:
        return
    root = (config.MEDIA_DIR / "uploads").resolve()
    path = Path(upload.path).resolve()
    if root in path.parents:
        path.unlink(missing_ok=True)


def _opened_once(upload: Upload) -> Image.Image:
    """The picture of an upload. The original goes at once, whether it could be read or
    not: with its metadata (the GPS position first), it stays nowhere."""
    try:
        return _open(upload)
    finally:
        discard_upload(upload)
        upload.path = None


def profile_picture(upload: Upload) -> str:
    image = ImageOps.fit(_opened_once(upload), (512, 512), Image.Resampling.LANCZOS)
    return _save(image, "pictures")


def group_picture(upload: Upload) -> str:
    image = ImageOps.fit(_opened_once(upload), (512, 512), Image.Resampling.LANCZOS)
    return _save(image, "groups")


def event_cover(upload: Upload) -> str:
    image = _opened_once(upload)
    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    return _save(image, "covers")


def album_photo(upload: Upload) -> tuple[str, str, int, int]:
    image = _opened_once(upload)
    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    url = _save(image, "photos")
    thumb = _save(ImageOps.fit(image, (400, 400), Image.Resampling.LANCZOS), "thumbs")
    return url, thumb, image.width, image.height
