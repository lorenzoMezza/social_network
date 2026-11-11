# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Reach and promotions (API.md, Promotions; PROMOTIONS.md): who sees an event, what a
promotion costs, the wallet, the day-by-day charges and the store purchases."""

import itertools

import pytest

from conftest import LAT, LON, User, iso_in, new_event

from app import promotions
from app.store import store
from app.util import DAY, now_ms

METRE = 1 / 111_320
_places = itertools.count()


def place():
    """A place of the test's own (2 km apart, 30 km north of LAT, LON)"""
    return {"latitude": LAT + 0.3 + next(_places) * 0.02, "longitude": LON}


def north(location, metres):
    return {"latitude": location["latitude"] + metres * METRE, "longitude": location["longitude"]}


def nearby_ids(person, location, range_m=10_000):
    answer = person.get("/v1/events", params={**location, "range": range_m})
    return {event["id"] for event in answer.json()["items"]}


def top_up(person, credits_product="promo.credits.999", transaction=None):
    token = transaction or f"dev-{next(_places)}-{person.id}"
    return person.post("/v1/me/wallet/purchases", {"platform": "dev", "productId": credits_product, "purchaseToken": token})


def test_prices_list_the_rules(user):
    prices = user.get("/v1/promotions/prices").json()
    assert prices["reach"] == {"min": 100, "max": 800, "step": 50, "default": 800}
    assert prices["tiers"][0] == {"radius": 1000, "daily": 99} and prices["tiers"][-1] == {"radius": 10000, "daily": 1299}
    assert prices["zoneFactor"] == 1.0
    assert all(pack["productId"].startswith("promo.credits.") for pack in prices["packs"])


def test_an_event_is_seen_within_its_reach_only(user, other):
    here = place()
    event = new_event(user, location=here, reach=200).json()
    assert event["reach"] == 200 and event["sponsored"] is False
    assert event["id"] in nearby_ids(other, north(here, 150))
    assert event["id"] not in nearby_ids(other, north(here, 300))
    # Free reach: 100–800 m
    for bad in (50, 900, "800", None):
        assert new_event(user, location=place(), reach=bad).status_code == 400, bad
    # Without one: the free maximum
    assert new_event(user, location=place()).json()["reach"] == 800


def test_promoting_needs_credits_and_shows_it_farther(user, other):
    here = place()
    event = new_event(user, location=here).json()
    path = f"/v1/events/{event['id']}/promotion"
    # An event in an hour, lasting an hour: the least a promotion costs, a quarter of a day
    assert user.get(f"{path}/quote", params={"radius": 2000}).json() == {"radius": 2000, "daily": 299, "days": 1, "discountPercent": 0, "firstCharge": 75, "total": 75}
    answer = user.put(path, {"radius": 2000, "daily": 299})
    assert answer.status_code == 402 and answer.json()["code"] == "insufficient_balance"
    assert answer.json()["details"] == ["75"]
    assert top_up(user).json()["balance"] == 999
    # A price the app did not show is never charged
    assert user.put(path, {"radius": 2000, "daily": 199}).json()["code"] == "price_changed"
    assert user.put(path, {"radius": 1800, "daily": 299}).status_code == 400
    promoted = user.put(path, {"radius": 2000, "daily": 299}).json()
    assert promoted["sponsored"] is True and promoted["reach"] == 2000
    assert promoted["promotion"]["status"] == "live" and promoted["promotion"]["charged"] == 75
    assert user.get("/v1/me/wallet").json()["balance"] == 999 - 75
    # Seen from 1.5 km, but never past the distance the viewer asked for
    assert event["id"] in nearby_ids(other, north(here, 1500))
    assert event["id"] not in nearby_ids(other, north(here, 1500), range_m=1000)
    # Others see that it is sponsored, not the promotion itself
    theirs = other.get(f"/v1/events/{event['id']}").json()
    assert theirs["sponsored"] is True and "promotion" not in theirs


def test_longer_events_cost_less_a_day(user):
    event = new_event(user, location=place(), dates={"startDate": iso_in(1), "endDate": iso_in(61)}).json()
    quote = user.get(f"/v1/events/{event['id']}/promotion/quote", params={"radius": 2000}).json()
    assert quote == {"radius": 2000, "daily": 269, "days": 3, "discountPercent": 10, "firstCharge": 269, "total": 684}


def test_flash_events_are_not_promoted(user):
    flash = new_event(user, location=place(), flash=True, dates={"startDate": iso_in(0.1), "endDate": iso_in(1)}).json()
    top_up(user)
    assert user.put(f"/v1/events/{flash['id']}/promotion", {"radius": 1000}).status_code == 403


def _event_object(event_id):
    return store.events[event_id]


def _long_event(user):
    return new_event(user, location=place(), dates={"startDate": iso_in(1), "endDate": iso_in(61)}).json()


def test_each_24_hours_are_paid_when_they_begin(user):
    event = _long_event(user)
    top_up(user, "promo.credits.499")
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    assert user.get("/v1/me/wallet").json()["balance"] == 499 - 89
    paid_until = store.promotions[event["id"]].paid_until
    # Still paid: nothing
    promotions.tick(paid_until - 1)
    assert store.wallet(user.id).balance == 499 - 89
    # The next 24 hours begin: paid once, however often it is looked at
    promotions.tick(paid_until)
    promotions.tick(paid_until + 1)
    assert store.wallet(user.id).balance == 499 - 2 * 89
    assert store.promotions[event["id"]].paid_until == paid_until + DAY


def test_the_time_before_an_event_is_paid_like_any_other(user):
    # A week ahead: no longer one day's price for all of it
    event = new_event(user, location=place(), dates={"startDate": iso_in(24 * 7), "endDate": iso_in(24 * 7 + 3)}).json()
    top_up(user, "promo.credits.9999")
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    promotion = store.promotions[event["id"]]
    before = store.wallet(user.id).balance
    promotions.tick(promotion.paid_until)
    assert store.wallet(user.id).balance == before - promotion.daily
    assert promotions.sponsored(store.events[event["id"]], promotion.paid_until - 1)


def test_the_last_stretch_costs_only_up_to_the_end(user):
    event = new_event(user, location=place(), dates={"startDate": iso_in(1), "endDate": iso_in(30)}).json()
    top_up(user, "promo.credits.999")
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    promotion = store.promotions[event["id"]]
    before = store.wallet(user.id).balance
    promotions.tick(promotion.paid_until)
    assert store.wallet(user.id).balance == before - 23  # six hours of 89 a day, rounded up
    assert promotion.paid_until == store.events[event["id"]].end
    # And at the end nothing more
    promotions.tick(promotion.paid_until)
    assert promotion.status == "ended" and store.wallet(user.id).balance == before - 23


def test_what_the_wallet_cannot_pay_pauses_it(user):
    event = _long_event(user)
    top_up(user, "promo.credits.099")
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    stored = _event_object(event["id"])
    paid_until = store.promotions[stored.id].paid_until
    assert promotions.tick(paid_until) == [(stored, "paused")]
    assert store.promotions[stored.id].status == "paused"
    assert not promotions.sponsored(stored, paid_until)
    # A top-up starts it again at once
    top_up(user, "promo.credits.199")
    assert store.promotions[stored.id].status == "live"
    assert promotions.sponsored(stored)


def test_stopping_keeps_what_is_paid_and_charges_no_more(user):
    event = _long_event(user)
    top_up(user)
    path = f"/v1/events/{event['id']}/promotion"
    user.put(path, {"radius": 1000})
    stopped = user.delete(path).json()
    assert stopped["promotion"]["status"] == "stopped" and stopped["sponsored"] is True
    balance = store.wallet(user.id).balance
    # Promoting again while paid costs nothing more
    assert user.put(path, {"radius": 1000}).json()["promotion"]["status"] == "live"
    assert store.wallet(user.id).balance == balance
    user.delete(path)
    # Nothing comes back for stopping: it goes on being shown for what was paid
    assert store.wallet(user.id).balance == balance
    stored = _event_object(event["id"])
    paid_until = store.promotions[stored.id].paid_until
    assert promotions.tick(paid_until) == [(stored, "ended")]
    assert store.wallet(user.id).balance == balance and not promotions.sponsored(stored, paid_until)


def test_a_wider_radius_costs_the_difference_for_the_time_left(user):
    event = _long_event(user)
    top_up(user)
    path = f"/v1/events/{event['id']}/promotion"
    user.put(path, {"radius": 1000})
    promotion = store.promotions[event["id"]]
    # Half of the 24 hours gone: half of the difference
    promotion.started -= DAY // 2
    promotion.paid_until -= DAY // 2
    wider = user.put(path, {"radius": 3000}).json()
    extra = wider["promotion"]["charged"] - 89
    half = (wider["promotion"]["daily"] - 89) / 2
    assert wider["reach"] == 3000 and half <= extra <= half + 1
    # Narrower: no refund, the new price from the next 24 hours
    narrower = user.put(path, {"radius": 1000}).json()["promotion"]
    assert narrower["daily"] < wider["promotion"]["daily"] and narrower["paidRate"] == wider["promotion"]["paidRate"]
    assert store.wallet(user.id).balance == 999 - 89 - extra


def test_cancelling_gives_back_the_time_not_used(user):
    event = _long_event(user)
    top_up(user)
    assert user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000}).json()["promotion"]["refundable"] == 66
    promotion = store.promotions[event["id"]]
    # Twelve hours in: half of what was paid comes back
    promotion.started -= DAY // 2
    promotion.paid_until -= DAY // 2
    answer = user.delete(f"/v1/events/{event['id']}").json()
    assert answer["promotion"]["refunded"] == 44 and answer["promotion"]["status"] == "ended"
    wallet = user.get("/v1/me/wallet").json()
    assert wallet["balance"] == 999 - 89 + 44
    assert wallet["entries"][0]["kind"] == "refund" and wallet["entries"][0]["amount"] == 44
    # Once only, and nothing more is charged
    assert user.delete(f"/v1/events/{event['id']}").status_code == 200
    promotions.tick(now_ms() + 2 * DAY)
    assert store.wallet(user.id).balance == 999 - 89 + 44
    assert user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000}).status_code == 410


def test_cancelling_at_once_still_costs_the_first_hours(user):
    event = _long_event(user)
    top_up(user)
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    answer = user.delete(f"/v1/events/{event['id']}").json()
    # 18 of its 24 hours come back: the first 6 stay paid
    assert answer["promotion"]["refunded"] == 66
    assert store.wallet(user.id).balance == 999 - 89 + 66


def test_a_refund_never_gives_back_more_than_was_paid(user):
    event = _long_event(user)
    top_up(user, "promo.credits.9999")
    path = f"/v1/events/{event['id']}/promotion"
    user.put(path, {"radius": 1000})
    for radius in (10000, 1000, 10000, 5000, 10000):
        user.put(path, {"radius": radius})
    promotion = store.promotions[event["id"]]
    assert user.delete(f"/v1/events/{event['id']}").json()["promotion"]["refunded"] <= promotion.charged
    assert store.wallet(user.id).balance <= 9999


def test_a_refund_of_a_purchase_after_a_cancellation_makes_no_credits(user):
    event = _long_event(user)
    top_up(user, transaction="spent-then-refunded")
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    user.delete(f"/v1/events/{event['id']}")
    promotions.reverse_purchase("dev", "spent-then-refunded")
    assert store.wallet(user.id).balance == -89 + 66


def test_cutting_an_event_short_gives_back_what_goes_past_its_end(user):
    event = _long_event(user)
    top_up(user)
    user.put(f"/v1/events/{event['id']}/promotion", {"radius": 1000})
    promotion = store.promotions[event["id"]]
    promotion.started -= 7 * 3600_000  # past its first 6 hours
    answer = user.patch(f"/v1/events/{event['id']}", {"dates": {"startDate": iso_in(1), "endDate": iso_in(3)}})
    assert answer.status_code == 200
    assert promotion.paid_until == store.events[event["id"]].end
    assert promotion.refunded > 0 and store.wallet(user.id).balance > 999 - promotion.daily


def test_purchases_are_credited_once_to_their_account(user, other):
    assert top_up(user, transaction="same-receipt").json()["credited"] is True
    again = top_up(user, transaction="same-receipt").json()
    assert again["credited"] is False and again["balance"] == 999
    assert top_up(other, transaction="same-receipt").status_code == 409
    assert user.post("/v1/me/wallet/purchases", {"platform": "dev", "productId": "nope", "purchaseToken": "x1"}).status_code == 400
    # Real stores are checked with the store: not set up here
    assert user.post("/v1/me/wallet/purchases", {"platform": "ios", "productId": "promo.credits.099", "purchaseToken": "jws"}).status_code == 503


def test_a_refunded_purchase_takes_its_credits_back(client):
    buyer = User(client)
    top_up(buyer, transaction="refunded-one")
    promotions.reverse_purchase("dev", "refunded-one")
    promotions.reverse_purchase("dev", "refunded-one")
    wallet = buyer.get("/v1/me/wallet").json()
    assert wallet["balance"] == 0
    assert [entry["kind"] for entry in wallet["entries"]] == ["reversal", "purchase"]


# --- App Store transactions: the chain up to the configured root, and the fields ---

def _certificate(subject, issuer_name, key, issuer_key, ca, kind=None):
    import datetime
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.x509.oid import NameOID
    now = datetime.datetime.now(datetime.timezone.utc)
    built = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer_name)]))
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if kind:
        built = built.add_extension(x509.UnrecognizedExtension(kind, b"\x05\x00"), critical=False)
    return built.sign(issuer_key, hashes.SHA256())


def _apple_like(tmp_path, monkeypatch):
    """A root (configured as Apple's), an intermediate and a leaf; signs payloads as
    StoreKit 2 does"""
    import base64
    import jwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from app import config, stores
    keys = [ec.generate_private_key(ec.SECP256R1()) for _ in range(3)]
    root = _certificate("Root", "Root", keys[0], keys[0], True)
    middle = _certificate("Middle", "Root", keys[1], keys[0], True, stores.APPLE_INTERMEDIATE_OID)
    leaf = _certificate("Leaf", "Middle", keys[2], keys[1], False, stores.APPLE_LEAF_OID)
    root_file = tmp_path / "root.cer"
    root_file.write_bytes(root.public_bytes(serialization.Encoding.DER))
    monkeypatch.setattr(config, "APPLE_ROOT_CA", str(root_file))
    monkeypatch.setattr(config, "APPLE_BUNDLE_ID", "com.example.app")
    stores._apple_root.cache_clear()
    der = lambda c: base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()  # noqa: E731
    x5c = [der(c) for c in (leaf, middle, root)]

    def sign(payload, signer=keys[2], chain=x5c):
        return jwt.encode(payload, signer, algorithm="ES256", headers={"x5c": chain})
    # A certificate someone else holds under the same root, which is not for App Store data
    sign.developer_chain = [der(_certificate("Developer", "Middle", keys[2], keys[1], False)), x5c[1], x5c[2]]
    sign.other_intermediate = [der(_certificate("Leaf", "Other", keys[2], keys[1], False, stores.APPLE_LEAF_OID)),
                               der(_certificate("Other", "Root", keys[1], keys[0], True)), x5c[2]]
    return sign, keys, x5c


def test_app_store_transactions_are_checked(client, tmp_path, monkeypatch):
    from cryptography.hazmat.primitives.asymmetric import ec
    from app import stores
    sign, keys, x5c = _apple_like(tmp_path, monkeypatch)
    buyer = User(client)
    account = buyer.get("/v1/me/wallet").json()["accountToken"]
    good = {"bundleId": "com.example.app", "type": "Consumable", "productId": "promo.credits.199",
            "transactionId": f"t-{buyer.id}", "appAccountToken": account, "environment": "Production"}
    bought = buyer.post("/v1/me/wallet/purchases", {"platform": "ios", "productId": "promo.credits.199", "purchaseToken": sign(good)})
    assert bought.status_code == 200 and bought.json()["balance"] == 199
    bad = [
        sign({**good, "transactionId": "t2"}, signer=ec.generate_private_key(ec.SECP256R1())),  # not the leaf's key
        sign({**good, "transactionId": "t3", "appAccountToken": "someone-else"}),
        sign({**good, "transactionId": "t4", "bundleId": "com.other"}),
        sign({**good, "transactionId": "t5", "environment": "Sandbox"}),
        sign({**good, "transactionId": "t6", "revocationDate": 1}),
        sign({**good, "transactionId": "t7"}, chain=[x5c[0], x5c[1], x5c[1]]),  # another root
        sign({**good, "transactionId": "t8"}, chain=sign.developer_chain),  # under Apple's root, not for this
        sign({**good, "transactionId": "t9"}, chain=sign.other_intermediate),
        "not a jws",
    ]
    for token in bad:
        answer = buyer.post("/v1/me/wallet/purchases", {"platform": "ios", "productId": "promo.credits.199", "purchaseToken": token})
        assert answer.status_code == 400, answer.text
    stores._apple_root.cache_clear()


def _promoted(user):
    event = _long_event(user)
    wallet = store.wallet(user.id)
    wallet.balance = 100_000
    assert user.put(f"/v1/events/{event['id']}/promotion", {"radius": 10000}).status_code == 200
    return event["id"], wallet


def test_a_change_that_costs_nothing_is_never_refused(user):
    event_id, wallet = _promoted(user)
    # A store refund took the balance below zero
    wallet.balance = -500
    assert user.put(f"/v1/events/{event_id}/promotion", {"radius": 1000}).status_code == 200
    assert wallet.balance == -500


def test_a_test_purchase_of_google_play_pays_nothing(monkeypatch):
    import asyncio
    from app import config, stores

    class Answer:
        status_code = 200

        @staticmethod
        def json():
            return {"purchaseState": 0, "purchaseType": 0, "obfuscatedExternalAccountId": "a", "orderId": "o"}

    class Client:
        def __init__(self, **_): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return False
        async def get(self, *_, **__): return Answer()

    async def token(): return "t"
    monkeypatch.setattr(config, "GOOGLE_PACKAGE_NAME", "com.example")
    monkeypatch.setattr(config, "GOOGLE_SERVICE_ACCOUNT_FILE", "x")
    monkeypatch.setattr(stores, "_play_access_token", token)
    monkeypatch.setattr(stores.httpx, "AsyncClient", Client)
    with pytest.raises(stores.ApiError) as refused:
        asyncio.run(stores.verify_google("promo.credits.099", "tok", "a"))
    assert refused.value.status == 400
    monkeypatch.setattr(config, "GOOGLE_ALLOW_TEST_PURCHASES", True)
    assert asyncio.run(stores.verify_google("promo.credits.099", "tok", "a"))["transactionId"] == "o"


def test_narrower_then_wider_again_costs_nothing_more(user):
    event_id, wallet = _promoted(user)
    paid = wallet.balance
    assert user.put(f"/v1/events/{event_id}/promotion", {"radius": 1000}).status_code == 200
    assert user.put(f"/v1/events/{event_id}/promotion", {"radius": 10000}).status_code == 200
    assert wallet.balance == paid


def test_moving_an_event_on_does_not_stretch_what_was_paid(user):
    event_id, wallet = _promoted(user)
    promotion = store.promotions[event_id]
    paid, until = wallet.balance, promotion.paid_until
    # A week later: what was paid ends when it ended, and the next 24 hours are paid as usual
    moved = user.patch(f"/v1/events/{event_id}", {"dates": {"startDate": iso_in(24 * 7), "endDate": iso_in(24 * 7 + 1)}})
    assert moved.status_code == 200
    assert promotion.paid_until == until and wallet.balance == paid
    promotions.tick(until)
    assert wallet.balance < paid and promotion.paid_until == until + DAY
