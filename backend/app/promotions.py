# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Reach and promotions of events (API.md, Promotions; the reasons in PROMOTIONS.md).

Every event is seen by people within its reach (100–800 m, free). A promotion shows a
normal event (not a flash one) farther, up to 10 km, paid from the organizer's wallet of
credits (1 credit = 1 euro cent), which they top up with in-app purchases (stores.py).

What it buys is time: 24 hours at a time from the moment it starts, never past the event's
end. Time paid and not used comes back to the wallet when it can no longer be given (the event
cancelled or cut short), except the first MIN_BILLED hours. Stopping is not that: what was paid
goes on being shown until it runs out. A period the wallet cannot pay pauses the promotion
(the event keeps its free reach). What is paid never changes with the event's dates.
"""

import math

from . import config
from .errors import ApiError, bad_request, conflict
from .store import REACH_DEFAULT_M, Event, Promotion, Wallet, WalletEntry, store
from .util import DAY, HOUR, iso, new_id, now_ms

# Free reach, metres
REACH_MIN_M = 100
REACH_MAX_M = REACH_DEFAULT_M
REACH_STEP_M = 50
# Flash events are about here and now: always the free maximum, never promoted
FLASH_REACH_M = REACH_MAX_M

# Promotion radii and their price a day (credits): a promotion picks one of these radii,
# the farthest its price reaches, so a price never buys less than it could
PRICE_TIERS = [(1000, 99), (1500, 199), (2000, 299), (3000, 499), (4000, 699), (5000, 899), (7500, 1099), (10000, 1299)]
RADII = [radius for radius, _ in PRICE_TIERS]
# Whatever happens, a promotion costs at least this much of its first day: promoting for an hour
# and cancelling would otherwise buy peak hours for almost nothing
MIN_BILLED_MS = 6 * HOUR
# Longer promotions cost less a day: (from this many days, from its start to the event's end, percent off)
DURATION_DISCOUNTS = [(2, 10), (4, 20), (8, 30)]
# Price factor of the area. 1 everywhere and never above it: no place costs more than
# the list (PROMOTIONS.md, Pricing). The hook stays for a cheaper price where few
# events are, if that is ever wanted.
ZONE_FACTOR = 1.0

# Credit packs sold in the stores (consumable in-app products with these ids, at the
# price of their credits: no bonus, no rounding to push a bigger pack)
CREDIT_PACKS = [
    {"productId": "promo.credits.099", "credits": 99},
    {"productId": "promo.credits.199", "credits": 199},
    {"productId": "promo.credits.499", "credits": 499},
    {"productId": "promo.credits.999", "credits": 999},
    {"productId": "promo.credits.1999", "credits": 1999},
    {"productId": "promo.credits.4999", "credits": 4999},
    {"productId": "promo.credits.9999", "credits": 9999},
]
PACK_CREDITS = {pack["productId"]: pack["credits"] for pack in CREDIT_PACKS}

WALLET_ENTRIES_SHOWN = 50


def price_list() -> dict:
    return {
        "currency": "EUR",
        "reach": {"min": REACH_MIN_M, "max": REACH_MAX_M, "step": REACH_STEP_M, "default": REACH_DEFAULT_M},
        "tiers": [{"radius": radius, "daily": daily} for radius, daily in PRICE_TIERS],
        "durationDiscounts": [{"fromDays": days, "percent": percent} for days, percent in DURATION_DISCOUNTS],
        "zoneFactor": ZONE_FACTOR,
        "minHours": MIN_BILLED_MS // HOUR,
        "packs": CREDIT_PACKS,
        # Test top-ups without a store (development servers only)
        "devPurchases": config.DEV_TOOLS,
    }


# --- time and prices ---

def promoted_days(event: Event, since: int) -> int:
    """How many days it runs if nobody stops it: from `since` to the event's end"""
    return max(1, math.ceil((event.end - since) / DAY))


def discount_percent(days: int) -> int:
    return max([percent for from_days, percent in DURATION_DISCOUNTS if days >= from_days], default=0)


def daily_price(radius: int, days: int) -> int:
    tier = dict(PRICE_TIERS)[radius]
    return round(tier * (100 - discount_percent(days)) / 100 * ZONE_FACTOR)


def _cost(daily: int, milliseconds: int) -> int:
    """What a stretch of time costs at a price a day, rounded to a whole credit (up: a charge)"""
    return math.ceil(daily * milliseconds / DAY)


def quote(event: Event, radius: int, now: int) -> dict:
    """What promoting the event at `radius` from now costs: a day, the first charge, and at
    most (if nobody stops it, until the event's end)"""
    if radius not in RADII:
        raise bad_request(f"radius: one of {RADII}")
    promotion = store.promotions.get(event.id)
    # A promotion running keeps the discount of the days it was started for
    since = promotion.started if promotion is not None and promotion.status in ("live", "stopped", "paused") else now
    days = promoted_days(event, since)
    daily = daily_price(radius, days)
    left = max(0, event.end - now)
    return {
        "radius": radius, "daily": daily, "days": promoted_days(event, now), "discountPercent": discount_percent(days),
        "firstCharge": _cost(daily, max(MIN_BILLED_MS, min(DAY, left))), "total": _cost(daily, max(MIN_BILLED_MS, left)),
    }


# --- what people see ---

def sponsored(event: Event, now: int | None = None) -> bool:
    """The event is promoted right now: live or stopped with time still paid, and not over"""
    now = now or now_ms()
    promotion = store.promotions.get(event.id)
    return (promotion is not None and promotion.status in ("live", "stopped") and not event.cancelled and now < event.end
            and now < promotion.paid_until)


def reach_now(event: Event, now: int | None = None) -> int:
    """How far away people see the event now (metres)"""
    if event.flash:
        return FLASH_REACH_M
    if sponsored(event, now):
        return store.promotions[event.id].radius
    return getattr(event, "reach", REACH_DEFAULT_M)


def _unused(promotion: Promotion, now: int) -> int:
    """Credits of the time paid and not used, what can come back: never the first MIN_BILLED
    hours, never more than was paid (rounded down: this one is the user's to get, and a
    credit more than was paid must never come out of rounding)"""
    remaining = promotion.paid_until - max(now, promotion.started + MIN_BILLED_MS)
    if remaining <= 0:
        return 0
    return min(math.floor(promotion.paid_rate * remaining / DAY), promotion.charged - promotion.refunded)


def promotion_view(event: Event, now: int | None = None) -> dict | None:
    """The organizer's view of the event's promotion (Event.promotion)"""
    promotion = store.promotions.get(event.id)
    if promotion is None:
        return None
    now = now or now_ms()
    status = promotion.status
    if status == "live" and (event.cancelled or now >= event.end):
        status = "ended"
    return {
        "radius": promotion.radius,
        "daily": promotion.daily,
        "paidRate": promotion.paid_rate,
        "status": status,
        "startedAt": iso(promotion.started),
        "paidUntil": iso(promotion.paid_until),
        # Days still to be paid, while it stays live
        "daysLeft": math.ceil(max(0, event.end - promotion.paid_until) / DAY) if status == "live" else 0,
        "charged": promotion.charged,
        "refunded": promotion.refunded,
        # What cancelling the event now would give back
        "refundable": _unused(promotion, now) if status in ("live", "stopped") else 0,
    }


# --- wallet ---

def _entry(wallet: Wallet, amount: int, kind: str, **fields) -> WalletEntry:
    entry = WalletEntry(id=new_id("we"), at=now_ms(), amount=amount, kind=kind, **fields)
    wallet.entries.append(entry)
    wallet.balance += amount
    return entry


def wallet_view(user_id: str) -> dict:
    wallet = store.wallet(user_id)
    entries = []
    for entry in reversed(wallet.entries[-WALLET_ENTRIES_SHOWN:]):
        view = {"id": entry.id, "at": iso(entry.at), "amount": entry.amount, "kind": entry.kind}
        if entry.event_id:
            event = store.events.get(entry.event_id)
            view["event"] = {"id": entry.event_id, "title": event.title if event else None}
        if entry.product_id:
            view["productId"] = entry.product_id
        entries.append(view)
    return {"balance": wallet.balance, "accountToken": wallet.account_token, "entries": entries}


def credit_purchase(user_id: str, platform: str, transaction_id: str, product_id: str) -> bool:
    """Credits of a verified store purchase, once per transaction. False when it was
    already credited (the app sends it again after a lost answer: same result)."""
    key = f"{platform}:{transaction_id}"
    if key in store.store_transactions:
        if store.store_transactions[key] not in (user_id, None):
            raise conflict("this purchase belongs to another account", code="already")
        return False
    credits = PACK_CREDITS.get(product_id)
    if credits is None:
        raise bad_request("productId: not a credit pack")
    store.store_transactions[key] = user_id
    _entry(store.wallet(user_id), credits, "purchase", product_id=product_id, transaction=key)
    # A promotion paused for lack of credits starts again at once
    _resume_paused(user_id)
    return True


def reverse_purchase(platform: str, transaction_id: str):
    """A purchase the store refunded (or revoked): its credits go back out. The balance
    may go below zero; then nothing is paid until a top-up covers it."""
    key = f"{platform}:{transaction_id}"
    user_id = store.store_transactions.get(key)
    wallet = store.wallets.get(user_id) if user_id else None
    if wallet is None:
        return
    bought = next((e for e in wallet.entries if e.transaction == key and e.kind == "purchase"), None)
    if bought is None or any(e.transaction == key and e.kind == "reversal" for e in wallet.entries):
        return
    _entry(wallet, -bought.amount, "reversal", product_id=bought.product_id, transaction=key)


def _charge(event: Event, promotion: Promotion, amount: int) -> bool:
    # Nothing to pay is never refused, also with a balance below zero (a store refund)
    if not amount:
        return True
    wallet = store.wallet(event.creator_id)
    if wallet.balance < amount:
        return False
    _entry(wallet, -amount, "day", event_id=event.id)
    promotion.charged += amount
    return True


def _give_back(event: Event, promotion: Promotion, amount: int):
    if amount > 0:
        _entry(store.wallet(event.creator_id), amount, "refund", event_id=event.id)
        promotion.refunded += amount


# --- starting, changing and stopping ---

def promotable(event: Event, now: int):
    if event.flash:
        raise ApiError(403, "forbidden", "flash events are not promoted")
    if event.cancelled or now >= event.end:
        raise ApiError(410, "gone", "the event is over")


def promote(event: Event, radius: int, expected_daily: int | None) -> Promotion:
    """Starts, resumes or changes the event's promotion. With time still paid a change costs
    only what a wider radius adds to the time left; otherwise a new 24 hours are paid now."""
    now = now_ms()
    promotable(event, now)
    offer = quote(event, radius, now)
    if expected_daily is not None and expected_daily != offer["daily"]:
        # The app showed another price: it shows this one before anything is charged
        raise ApiError(409, "price_changed", "the price changed", [str(offer["daily"])])
    promotion = store.promotions.get(event.id)
    if promotion is not None and promotion.status in ("live", "stopped") and now < promotion.paid_until:
        extra = _cost(max(0, offer["daily"] - promotion.paid_rate), promotion.paid_until - now)
        if not _charge(event, promotion, extra):
            raise ApiError(402, "insufficient_balance", "not enough credits", [str(extra)])
        promotion.paid_rate = max(promotion.paid_rate, offer["daily"])
        promotion.radius, promotion.daily, promotion.status = radius, offer["daily"], "live"
        return promotion
    # A promotion over (or never begun) starts anew; one paused goes on where it was
    resuming = promotion is not None and promotion.status == "paused"
    left = event.end - now
    amount = _cost(offer["daily"], min(DAY, left)) if resuming else offer["firstCharge"]
    if store.wallet(event.creator_id).balance < amount:
        raise ApiError(402, "insufficient_balance", "not enough credits", [str(amount)])
    if promotion is None:
        promotion = Promotion(event_id=event.id, radius=radius, daily=offer["daily"], started=now, paid_until=now)
        store.promotions[event.id] = promotion
    elif not resuming:
        promotion.started = now
    promotion.radius, promotion.daily, promotion.paid_rate, promotion.status = radius, offer["daily"], offer["daily"], "live"
    _charge(event, promotion, amount)
    promotion.paid_until = now + min(DAY, left)
    return promotion


def stop(event: Event):
    """Nothing more is paid. The time already paid goes on being shown: it was paid for."""
    promotion = store.promotions.get(event.id)
    if promotion is not None and promotion.status in ("live", "paused"):
        promotion.status = "stopped"


def cancelled(event: Event) -> int:
    """The event was cancelled by its organizer: the time paid can no longer be given, so what
    was not used comes back, once. Answers the credits given back."""
    promotion = store.promotions.get(event.id)
    if promotion is None or promotion.status == "ended":
        return 0
    now = now_ms()
    amount = _unused(promotion, now)
    _give_back(event, promotion, amount)
    promotion.paid_until = min(promotion.paid_until, now)
    promotion.status = "ended"
    return amount


def dates_changed(event: Event):
    """What was paid stays the time it was, wherever the event moves. Cut short before that time
    ends, the rest comes back. Fewer days from its start than it was priced for, the discount
    of those days goes from the next charge on (never the other way round: a price it started
    with is not raised by a price list)."""
    promotion = store.promotions.get(event.id)
    if promotion is None or promotion.status not in ("live", "stopped", "paused"):
        return
    promotion.daily = max(promotion.daily, daily_price(promotion.radius, promoted_days(event, promotion.started)))
    if promotion.status != "paused" and promotion.paid_until > event.end:
        kept = promotion.paid_until
        promotion.paid_until = event.end
        over = kept - max(event.end, promotion.started + MIN_BILLED_MS, now_ms())
        if over > 0:
            _give_back(event, promotion, min(math.floor(promotion.paid_rate * over / DAY), promotion.charged - promotion.refunded))


def _resume_paused(user_id: str):
    now = now_ms()
    for promotion in store.promotions.values():
        event = store.events.get(promotion.event_id)
        if promotion.status == "paused" and event and event.creator_id == user_id and not event.cancelled and now < event.end:
            length = min(DAY, event.end - now)
            if _charge(event, promotion, _cost(promotion.daily, length)):
                promotion.status, promotion.paid_rate, promotion.paid_until = "live", promotion.daily, now + length


def tick(now: int) -> list[tuple[Event, str]]:
    """Once a minute (janitor): each live promotion whose paid time ran out pays the next 24
    hours (never past the event's end), or pauses. Answers the events whose reach changed, for
    their watchers, with why: "paused" (the wallet could not pay) or "ended" (a stopped one's
    time ran out)."""
    changed = []
    for promotion in store.promotions.values():
        if promotion.status not in ("live", "stopped"):
            continue
        event = store.events.get(promotion.event_id)
        if event is None or event.cancelled or now >= event.end:
            promotion.status = "ended"
            continue
        if now < promotion.paid_until:
            continue
        if promotion.status == "stopped":
            promotion.status = "ended"
            changed.append((event, "ended"))
            continue
        # From where it ran out, unless the server was away for long
        since = promotion.paid_until if now - promotion.paid_until < DAY else now
        until = min(since + DAY, event.end)
        if _charge(event, promotion, _cost(promotion.daily, until - since)):
            promotion.paid_rate, promotion.paid_until = promotion.daily, until
        else:
            promotion.status = "paused"
            changed.append((event, "paused"))
    return changed


def forget_user(user_id: str):
    """Account deleted (privacy.erase_user): the wallet goes; the purchases it made stay
    known without it, so their receipts are never credited again"""
    store.wallets.pop(user_id, None)
    for key, owner in store.store_transactions.items():
        if owner == user_id:
            store.store_transactions[key] = None
