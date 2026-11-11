# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Promotions, the wallet of promotion credits and the stores' notices (API.md,
Promotions; PROMOTIONS.md)."""

import hmac

from fastapi import APIRouter, Depends, Query, Response

from .. import config, limits, promotions, stores
from ..auth import current_user
from ..domain import notify_event
from ..errors import ApiError, bad_request, forbidden
from ..store import User, store
from ..util import now_ms
from ..views import event_detail
from .events import _own

router = APIRouter(prefix="/v1")

PLATFORMS = ("ios", "android", "dev")


@router.get("/promotions/prices")
async def prices(_user: User = Depends(current_user)):
    return promotions.price_list()


@router.get("/events/{event_id}/promotion/quote")
async def quote(event_id: str, radius: int, user: User = Depends(current_user)):
    event = _own(event_id, user)
    now = now_ms()
    promotions.promotable(event, now)
    return promotions.quote(event, radius, now)


@router.put("/events/{event_id}/promotion")
async def promote(event_id: str, body: dict, user: User = Depends(current_user)):
    event = _own(event_id, user)
    radius, daily = body.get("radius"), body.get("daily")
    if not isinstance(radius, int) or (daily is not None and not isinstance(daily, int)):
        raise bad_request("radius: metres; daily: the price shown, in credits")
    promotions.promote(event, radius, daily)
    # On the lists and maps of everyone now within its radius
    notify_event(event)
    return event_detail(event, user.id)


@router.delete("/events/{event_id}/promotion")
async def stop(event_id: str, user: User = Depends(current_user)):
    event = _own(event_id, user)
    promotions.stop(event)
    return event_detail(event, user.id)


@router.get("/me/wallet")
async def wallet(user: User = Depends(current_user)):
    return promotions.wallet_view(user.id)


@router.post("/me/wallet/purchases")
async def top_up(body: dict, user: User = Depends(current_user)):
    """A store purchase of credits, checked with the store and credited once. The app
    finishes (consumes) the transaction only after this answers."""
    limits.check(user.id, "purchase")
    platform, product_id, token = body.get("platform"), body.get("productId"), body.get("purchaseToken")
    if platform not in PLATFORMS or not isinstance(product_id, str) or not isinstance(token, str) or not token:
        raise bad_request("platform (ios, android), productId and purchaseToken")
    # Before asking a store about it
    if product_id not in promotions.PACK_CREDITS:
        raise bad_request("productId: not a credit pack")
    account = store.wallet(user.id).account_token
    if platform == "ios":
        checked = stores.verify_apple(token, account)
    elif platform == "android":
        checked = await stores.verify_google(product_id, token, account)
    elif config.DEV_TOOLS:
        # Development: a test top-up without a store (simulators, emulators without a
        # Play account); the token is its transaction id
        checked = {"transactionId": token, "productId": product_id}
    else:
        raise forbidden("test purchases are off")
    if checked["productId"] != product_id:
        raise ApiError(400, "invalid_purchase", "another product")
    credited = promotions.credit_purchase(user.id, platform, checked["transactionId"], product_id)
    return {"credited": credited, **promotions.wallet_view(user.id)}


# --- the stores' notices of refunds (server to server) ---

@router.post("/store/apple/notifications")
async def apple_notice(body: dict):
    """App Store Server Notifications V2: a refunded or revoked purchase takes its
    credits back"""
    payload = stores.apple_signed_payload(str(body.get("signedPayload", "")))
    if payload.get("notificationType") in ("REFUND", "REVOKE"):
        transaction = stores.apple_signed_payload(payload.get("data", {}).get("signedTransactionInfo", ""))
        # Apple signs other apps' notices too: only one about this app takes credits back,
        # and a sandbox refund nothing that was paid for
        sandbox = transaction.get("environment") == "Sandbox" and not config.APPLE_ALLOW_SANDBOX
        if transaction.get("bundleId") == config.APPLE_BUNDLE_ID and not sandbox:
            promotions.reverse_purchase("ios", str(transaction.get("transactionId")))
    return Response(status_code=200)


@router.post("/store/google/notifications")
async def google_notice(body: dict, secret: str = Query("")):
    """Play real-time developer notifications (a Pub/Sub push subscription to this
    address, with ?secret=)"""
    if not config.GOOGLE_RTDN_SECRET or not hmac.compare_digest(secret.encode(), config.GOOGLE_RTDN_SECRET.encode()):
        raise forbidden("unknown sender")
    order_id = stores.google_refund_notice(body)
    if order_id:
        promotions.reverse_purchase("android", order_id)
    return Response(status_code=204)
