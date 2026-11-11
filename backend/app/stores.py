# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Store purchases of promotion credits, checked before they are credited, and the
stores' refund notices (API.md, Promotions; PROMOTIONS.md, Payments).

The app is never trusted: it sends what the store gave it, and the server checks it
with the store itself.
- Apple (StoreKit 2): the transaction is a JWS signed by Apple. Its certificate chain
  (x5c) must end at Apple Root CA - G3, each certificate must be of the kind Apple signs
  purchases with, and the signature must hold; then its bundle id, product, type and
  appAccountToken (the wallet's account token) are checked.
- Google Play: the purchase token is looked up with the Play Developer API (a service
  account); its state and obfuscatedExternalAccountId are checked.
A store that is not configured answers 503 unavailable: nothing is credited unchecked.
"""

import base64
import json
import time
from functools import lru_cache
from urllib.parse import quote

import httpx
import jwt
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from . import config
from .errors import ApiError, bad_request

TIMEOUT_S = 10
# What marks the certificates Apple signs App Store data with (the same check as Apple's own
# library). Without it any certificate under Apple's root would do, and Apple gives those out
# to developers: anyone with one could sign themselves a purchase
APPLE_LEAF_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.11.1")
APPLE_INTERMEDIATE_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.2.1")


def _unavailable(store_name: str):
    return ApiError(503, "unavailable", f"{store_name} purchases are not set up on this server")


def _refused(reason: str):
    return ApiError(400, "invalid_purchase", reason)


# --- Apple ---

@lru_cache(maxsize=1)
def _apple_root() -> x509.Certificate:
    with open(config.APPLE_ROOT_CA, "rb") as file:
        return x509.load_der_x509_certificate(file.read())


def apple_signed_payload(signed: str) -> dict:
    """The payload of a JWS signed by Apple (a transaction, a notification), after its
    chain and signature are checked"""
    if not config.APPLE_BUNDLE_ID or not config.APPLE_ROOT_CA:
        raise _unavailable("App Store")
    try:
        header = jwt.get_unverified_header(signed)
        chain = [x509.load_der_x509_certificate(base64.b64decode(cert)) for cert in header["x5c"]]
    except (jwt.PyJWTError, KeyError, ValueError, TypeError) as error:
        raise _refused("not a signed App Store transaction") from error
    if len(chain) != 3 or chain[2] != _apple_root():
        raise _refused("not signed under Apple's root")
    now = time.time()
    for cert, issuer in ((chain[0], chain[1]), (chain[1], chain[2])):
        if not cert.not_valid_before_utc.timestamp() <= now <= cert.not_valid_after_utc.timestamp():
            raise _refused("certificate out of date")
        try:
            issuer.public_key().verify(cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm or hashes.SHA256()))
        except (InvalidSignature, TypeError, AttributeError) as error:
            raise _refused("broken certificate chain") from error
    for cert, kind in ((chain[0], APPLE_LEAF_OID), (chain[1], APPLE_INTERMEDIATE_OID)):
        try:
            cert.extensions.get_extension_for_oid(kind)
        except (x509.ExtensionNotFound, ValueError) as error:
            raise _refused("not a certificate for App Store data") from error
    try:
        return jwt.decode(signed, key=chain[0].public_key(), algorithms=["ES256"], options={"verify_aud": False})
    except jwt.PyJWTError as error:
        raise _refused("bad signature") from error


def verify_apple(signed_transaction: str, account_token: str) -> dict:
    """{ transactionId, productId } of a consumable bought by this account"""
    payload = apple_signed_payload(signed_transaction)
    if payload.get("bundleId") != config.APPLE_BUNDLE_ID:
        raise _refused("another app's transaction")
    if payload.get("environment") == "Sandbox" and not config.APPLE_ALLOW_SANDBOX:
        raise _refused("a sandbox transaction")
    if payload.get("type") != "Consumable":
        raise _refused("not a consumable")
    if payload.get("revocationDate"):
        raise _refused("the purchase was refunded")
    if str(payload.get("appAccountToken", "")).lower() != account_token.lower():
        raise _refused("bought by another account")
    return {"transactionId": str(payload["transactionId"]), "productId": payload["productId"]}


# --- Google Play ---

PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
_play_token: dict = {"value": None, "until": 0.0}


async def _play_access_token() -> str:
    if _play_token["value"] and _play_token["until"] > time.time() + 60:
        return _play_token["value"]
    with open(config.GOOGLE_SERVICE_ACCOUNT_FILE) as file:
        account = json.load(file)
    issued = int(time.time())
    assertion = jwt.encode(
        {"iss": account["client_email"], "scope": PLAY_SCOPE, "aud": account["token_uri"], "iat": issued, "exp": issued + 3600},
        account["private_key"], algorithm="RS256",
    )
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        answer = await client.post(account["token_uri"], data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
    answer.raise_for_status()
    body = answer.json()
    _play_token.update(value=body["access_token"], until=time.time() + body.get("expires_in", 3600))
    return body["access_token"]


async def verify_google(product_id: str, purchase_token: str, account_token: str) -> dict:
    """{ transactionId (the order id), productId } of a purchase by this account"""
    if not config.GOOGLE_PACKAGE_NAME or not config.GOOGLE_SERVICE_ACCOUNT_FILE:
        raise _unavailable("Google Play")
    # Both come from the app: escaped, they cannot reach another address with our credentials
    url = f"{PLAY_API}/{config.GOOGLE_PACKAGE_NAME}/purchases/products/{quote(product_id, safe='')}/tokens/{quote(purchase_token, safe='')}"
    try:
        token = await _play_access_token()
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            answer = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as error:
        raise ApiError(503, "unavailable", "Google Play did not answer") from error
    if answer.status_code in (400, 404, 410):
        raise _refused("unknown purchase")
    if answer.status_code != 200:
        raise ApiError(503, "unavailable", "Google Play did not answer")
    purchase = answer.json()
    # 0 purchased, 1 cancelled, 2 pending (credited only once paid: the app sends it again)
    if purchase.get("purchaseState") != 0:
        raise _refused("not paid")
    # 0: a licence-testing account, which pays nothing (as Apple's sandbox above)
    if purchase.get("purchaseType") == 0 and not config.GOOGLE_ALLOW_TEST_PURCHASES:
        raise _refused("a test purchase")
    if purchase.get("obfuscatedExternalAccountId") != account_token:
        raise _refused("bought by another account")
    return {"transactionId": purchase.get("orderId") or purchase_token, "productId": product_id}


def google_refund_notice(body: dict) -> str | None:
    """The order id a Pub/Sub push of Play's real-time developer notifications refunds
    (voidedPurchaseNotification), or None"""
    try:
        data = json.loads(base64.b64decode(body["message"]["data"]))
    except (KeyError, TypeError, ValueError) as error:
        raise bad_request("not a Pub/Sub push") from error
    if data.get("packageName") != config.GOOGLE_PACKAGE_NAME:
        return None
    voided = data.get("voidedPurchaseNotification") or {}
    return voided.get("orderId")
