// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.PROMOTIONS;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.core.ApiError;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.PromotionsRecord;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;

/**
 * Reach and promotions of events ({@code promotions.py}, PROMOTIONS.md). Credits are
 * {@code int}, products {@code long}, never a {@code double} (§16, Denaro); what comes back is
 * rounded down, what is charged up. Every change of money reads its rows under lock (§7.3), in
 * the order of the package: event, promotion, wallet.
 */
public final class Promotions {

    public static final int REACH_MIN = 100;
    public static final int REACH_MAX = 800;
    public static final int REACH_STEP = 50;
    /** Flash events are about here and now: always the free maximum, never promoted. */
    public static final int FLASH_REACH = REACH_MAX;
    static final int[][] PRICE_TIERS = {
        {1000, 99}, {1500, 199}, {2000, 299}, {3000, 499}, {4000, 699}, {5000, 899}, {7500, 1099}, {10000, 1299}};
    public static final int MAX_RADIUS = 10_000;
    static final long HOUR = 3_600_000L;
    static final long DAY = 24 * HOUR;
    /** Whatever happens, a promotion costs at least this much of its first day. */
    static final long MIN_BILLED = 6 * HOUR;
    /** From this many days (its start to the event's end), percent off. */
    static final int[][] DURATION_DISCOUNTS = {{2, 10}, {4, 20}, {8, 30}};
    static final Set<String> RUNNING = Set.of("live", "stopped", "paused");

    private Promotions() {
    }

    public static Map<String, Object> priceList(boolean devPurchases) {
        Map<String, Object> list = new LinkedHashMap<>();
        list.put("currency", "EUR");
        Map<String, Object> reach = new LinkedHashMap<>();
        reach.put("min", REACH_MIN);
        reach.put("max", REACH_MAX);
        reach.put("step", REACH_STEP);
        reach.put("default", REACH_MAX);
        list.put("reach", reach);
        List<Map<String, Object>> tiers = new ArrayList<>();
        for (int[] tier : PRICE_TIERS) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("radius", tier[0]);
            entry.put("daily", tier[1]);
            tiers.add(entry);
        }
        list.put("tiers", tiers);
        List<Map<String, Object>> discounts = new ArrayList<>();
        for (int[] discount : DURATION_DISCOUNTS) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("fromDays", discount[0]);
            entry.put("percent", discount[1]);
            discounts.add(entry);
        }
        list.put("durationDiscounts", discounts);
        // One price everywhere for now (PROMOTIONS.md): the field is there for the app
        list.put("zoneFactor", 1.0);
        list.put("minHours", MIN_BILLED / HOUR);
        list.put("packs", Wallets.packs());
        // Test top-ups without a store: development servers only
        list.put("devPurchases", devPurchases);
        return list;
    }

    // --- what people see ---

    /** Promoted right now: live or stopped with time still paid, and the event not over. */
    public static boolean sponsored(EventsRecord event, @Nullable PromotionsRecord promotion, Instant now) {
        return promotion != null && ("live".equals(promotion.getStatus()) || "stopped".equals(promotion.getStatus()))
                && event.getCancelledAt() == null && now.isBefore(event.getEndsAt()) && now.isBefore(promotion.getPaidUntil());
    }

    /** How far away people see the event now (metres). */
    public static int reachNow(EventsRecord event, @Nullable PromotionsRecord promotion, Instant now) {
        if (event.getFlash()) return FLASH_REACH;
        if (promotion != null && sponsored(event, promotion, now)) return promotion.getRadius();
        return event.getReach();
    }

    /** Event.promotion: the organizer's only. */
    public static @Nullable Map<String, Object> view(EventsRecord event, @Nullable PromotionsRecord promotion, Instant now) {
        if (promotion == null) return null;
        String status = promotion.getStatus();
        if ("live".equals(status) && (event.getCancelledAt() != null || !now.isBefore(event.getEndsAt()))) status = "ended";
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("radius", promotion.getRadius());
        view.put("daily", promotion.getDaily());
        view.put("paidRate", promotion.getPaidRate());
        view.put("status", status);
        view.put("startedAt", promotion.getStartedAt());
        view.put("paidUntil", promotion.getPaidUntil());
        // Days still to be paid, while it stays live
        long toPay = Math.max(0, ms(event.getEndsAt()) - ms(promotion.getPaidUntil()));
        view.put("daysLeft", "live".equals(status) ? (int) Math.ceilDiv(toPay, DAY) : 0);
        view.put("charged", promotion.getCharged());
        view.put("refunded", promotion.getRefunded());
        // What cancelling the event now would give back
        view.put("refundable", "live".equals(status) || "stopped".equals(status) ? unused(promotion, now) : 0);
        return view;
    }

    // --- time and prices ---

    static long ms(Instant at) {
        return at.toEpochMilli();
    }

    /** How many days it runs if nobody stops it: from {@code since} to the event's end. */
    public static int promotedDays(EventsRecord event, Instant since) {
        return (int) Math.max(1, Math.ceilDiv(ms(event.getEndsAt()) - ms(since), DAY));
    }

    public static int discountPercent(int days) {
        int percent = 0;
        for (int[] tier : DURATION_DISCOUNTS) if (days >= tier[0]) percent = Math.max(percent, tier[1]);
        return percent;
    }

    static boolean isRadius(int radius) {
        for (int[] tier : PRICE_TIERS) if (tier[0] == radius) return true;
        return false;
    }

    public static int dailyPrice(int radius, int days) {
        for (int[] tier : PRICE_TIERS) {
            // Python's round() halves to even; no tier and discount gives a half, so this is the same
            if (tier[0] == radius) return (tier[1] * (100 - discountPercent(days)) + 50) / 100;
        }
        throw new IllegalArgumentException("not a radius");
    }

    /** What a stretch of time costs at a price a day: rounded up to a whole credit (a charge). */
    static int cost(int daily, long milliseconds) {
        return Math.toIntExact(Math.ceilDiv(Math.multiplyExact((long) daily, Math.max(0, milliseconds)), DAY));
    }

    /** Credits of the time paid and not used: never the first 6 hours, never more than was paid. */
    static int unused(PromotionsRecord promotion, Instant now) {
        long remaining = ms(promotion.getPaidUntil()) - Math.max(ms(now), ms(promotion.getStartedAt()) + MIN_BILLED);
        if (remaining <= 0) return 0;
        long back = Math.floorDiv(Math.multiplyExact((long) promotion.getPaidRate(), remaining), DAY);
        return (int) Math.min(back, (long) promotion.getCharged() - promotion.getRefunded());
    }

    public static void promotable(EventsRecord event, Instant now) {
        if (event.getFlash()) throw ApiError.forbidden("flash events are not promoted");
        if (event.getCancelledAt() != null || !now.isBefore(event.getEndsAt())) throw ApiError.gone("gone", "the event is over");
    }

    /** What promoting an event at a radius from now costs: a day, the first charge, and at most (until its end). */
    public record Quote(int radius, int daily, int days, int discountPercent, int firstCharge, int total) {

        public Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("radius", radius);
            view.put("daily", daily);
            view.put("days", days);
            view.put("discountPercent", discountPercent);
            view.put("firstCharge", firstCharge);
            view.put("total", total);
            return view;
        }
    }

    public static Quote quote(EventsRecord event, @Nullable PromotionsRecord promotion, int radius, Instant now) {
        if (!isRadius(radius)) {
            List<String> radii = new ArrayList<>();
            for (int[] tier : PRICE_TIERS) radii.add(Integer.toString(tier[0]));
            throw ApiError.badRequest("radius: one of " + String.join(", ", radii));
        }
        // A promotion running keeps the discount of the days it was started for
        Instant since = promotion != null && RUNNING.contains(promotion.getStatus()) ? promotion.getStartedAt() : now;
        int days = promotedDays(event, since);
        int daily = dailyPrice(radius, days);
        long left = Math.max(0, ms(event.getEndsAt()) - ms(now));
        return new Quote(radius, daily, promotedDays(event, now), discountPercent(days),
                cost(daily, Math.max(MIN_BILLED, Math.min(DAY, left))), cost(daily, Math.max(MIN_BILLED, left)));
    }

    // --- starting, changing and stopping (the caller holds the event's row locked) ---

    /** The promotion row under lock, or null. */
    public static @Nullable PromotionsRecord locked(DSLContext ctx, UUID event) {
        return ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(event)).forUpdate().fetchOne();
    }

    private static ApiError insufficient(int due) {
        return new ApiError(402, "insufficient_balance", "not enough credits", List.of(Integer.toString(due)), Map.of());
    }

    /**
     * Starts, resumes or changes the event's promotion. With time still paid a change costs only
     * what a wider radius adds to the time left; otherwise a new 24 hours are paid now.
     */
    public static void promote(DSLContext ctx, EventsRecord event, int radius, @Nullable Integer expectedDaily, Instant now) {
        promotable(event, now);
        PromotionsRecord promotion = locked(ctx, event.getId());
        Quote offer = quote(event, promotion, radius, now);
        int daily = offer.daily();
        if (expectedDaily != null && expectedDaily != daily) {
            // The app showed another price: it shows this one before anything is charged
            throw new ApiError(409, "price_changed", "the price changed", List.of(Integer.toString(daily)), Map.of());
        }
        int balance = Wallets.locked(ctx, event.getCreatorId()).getBalance();
        String status = promotion == null ? null : promotion.getStatus();
        if (promotion != null && ("live".equals(status) || "stopped".equals(status)) && now.isBefore(promotion.getPaidUntil())) {
            int extra = cost(Math.max(0, daily - promotion.getPaidRate()), ms(promotion.getPaidUntil()) - ms(now));
            // Nothing to pay is never refused, also with a balance below zero (a store refund)
            if (extra > 0 && balance < extra) throw insufficient(extra);
            charge(ctx, event, promotion, extra, now);
            promotion.setPaidRate(Math.max(promotion.getPaidRate(), daily));
            promotion.setRadius(radius);
            promotion.setDaily(daily);
            promotion.setStatus("live");
            promotion.update();
            return;
        }
        // A promotion over (or never begun) starts anew; one paused goes on where it was
        boolean resuming = "paused".equals(status);
        long length = Math.min(DAY, ms(event.getEndsAt()) - ms(now));
        int amount = resuming ? cost(daily, length) : offer.firstCharge();
        if (balance < amount) throw insufficient(amount);
        if (promotion == null) {
            promotion = ctx.newRecord(PROMOTIONS);
            promotion.setEventId(event.getId());
            promotion.setLatitude(event.getLatitude());
            promotion.setLongitude(event.getLongitude());
            promotion.setRadius(radius);
            promotion.setDaily(daily);
            promotion.setPaidRate(daily);
            promotion.setStartedAt(now);
            promotion.setPaidUntil(now);
            promotion.setStatus("live");
            promotion.setCharged(0);
            promotion.setRefunded(0);
            promotion.insert();
        } else if (!resuming) {
            promotion.setStartedAt(now);
        }
        promotion.setRadius(radius);
        promotion.setDaily(daily);
        promotion.setPaidRate(daily);
        promotion.setStatus("live");
        charge(ctx, event, promotion, amount, now);
        promotion.setPaidUntil(now.plusMillis(length));
        promotion.update();
    }

    /** Nothing more is paid. The time already paid goes on being shown: it was paid for. */
    public static void stop(DSLContext ctx, EventsRecord event) {
        PromotionsRecord promotion = locked(ctx, event.getId());
        if (promotion != null && ("live".equals(promotion.getStatus()) || "paused".equals(promotion.getStatus()))) {
            promotion.setStatus("stopped");
            promotion.update();
        }
    }

    /**
     * The event was cancelled by its organizer: the time paid can no longer be given, so what
     * was not used comes back, once. Answers the credits given back.
     */
    public static int cancelled(DSLContext ctx, EventsRecord event, Instant now) {
        PromotionsRecord promotion = locked(ctx, event.getId());
        if (promotion == null || "ended".equals(promotion.getStatus())) return 0;
        int amount = unused(promotion, now);
        giveBack(ctx, event, promotion, amount, now);
        if (promotion.getPaidUntil().isAfter(now)) promotion.setPaidUntil(now);
        promotion.setStatus("ended");
        promotion.update();
        return amount;
    }

    /**
     * New dates or a new place: what was paid stays the time it was, wherever the event moves; cut
     * short before that time ends, the rest comes back. Fewer days from its start than it was
     * priced for, the discount of those days goes from the next charge on (never the other way).
     */
    public static void changed(DSLContext ctx, EventsRecord event, Instant now) {
        PromotionsRecord promotion = locked(ctx, event.getId());
        if (promotion == null) return;
        // The promotion's place follows the event (who sees it, from the index of promotions)
        promotion.setLatitude(event.getLatitude());
        promotion.setLongitude(event.getLongitude());
        String status = promotion.getStatus();
        if (RUNNING.contains(status)) {
            promotion.setDaily(Math.max(promotion.getDaily(), dailyPrice(promotion.getRadius(), promotedDays(event, promotion.getStartedAt()))));
            if (!"paused".equals(status) && promotion.getPaidUntil().isAfter(event.getEndsAt())) {
                long kept = ms(promotion.getPaidUntil());
                promotion.setPaidUntil(event.getEndsAt());
                long over = kept - Math.max(Math.max(ms(event.getEndsAt()), ms(promotion.getStartedAt()) + MIN_BILLED), ms(now));
                if (over > 0) {
                    long back = Math.floorDiv(Math.multiplyExact((long) promotion.getPaidRate(), over), DAY);
                    giveBack(ctx, event, promotion, (int) Math.min(back, (long) promotion.getCharged() - promotion.getRefunded()), now);
                }
            }
        }
        promotion.update();
    }

    static void charge(DSLContext ctx, EventsRecord event, PromotionsRecord promotion, int amount, Instant now) {
        if (amount <= 0) return;
        Wallets.entry(ctx, event.getCreatorId(), -amount, "day", event.getId(), null, null, now);
        promotion.setCharged(promotion.getCharged() + amount);
    }

    static void giveBack(DSLContext ctx, EventsRecord event, PromotionsRecord promotion, int amount, Instant now) {
        if (amount <= 0) return;
        Wallets.entry(ctx, event.getCreatorId(), amount, "refund", event.getId(), null, null, now);
        promotion.setRefunded(promotion.getRefunded() + amount);
    }

    // --- the minute job (promotion.charge) and top-ups ---

    /** The promotions the minute job looks at: paid time over, or the event over. Read without locks. */
    public static List<UUID> due(DSLContext ctx, Instant now, int limit) {
        return ctx.select(PROMOTIONS.EVENT_ID).from(PROMOTIONS).join(EVENTS).on(EVENTS.ID.eq(PROMOTIONS.EVENT_ID))
                .where(PROMOTIONS.STATUS.in("live", "stopped"))
                .and(PROMOTIONS.PAID_UNTIL.le(now).or(EVENTS.CANCELLED_AT.isNotNull()).or(EVENTS.ENDS_AT.le(now)))
                .orderBy(PROMOTIONS.PAID_UNTIL).limit(limit).fetch(PROMOTIONS.EVENT_ID);
    }

    /** What changed for an event's watchers with a charge: "paused" (the wallet could not pay) or "ended". */
    public enum Changed { NOTHING, QUIET, PAUSED, ENDED }

    /**
     * One promotion of the minute job, in its own short transaction: pays the next 24 hours
     * (never past the event's end), or pauses; a stopped one whose time ran out ends. Taken with
     * SKIP LOCKED and read again under lock: a request changing it now is left alone, and it is
     * looked at again the next minute. Run twice, it does nothing the second time.
     */
    public static Changed tick(DSLContext ctx, UUID eventId, Instant now) {
        PromotionsRecord promotion = ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(eventId))
                .and(PROMOTIONS.STATUS.in("live", "stopped")).forUpdate().skipLocked().fetchOne();
        if (promotion == null) return Changed.NOTHING;
        EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(eventId)).fetchOne();
        if (event == null || event.getCancelledAt() != null || !now.isBefore(event.getEndsAt())) {
            promotion.setStatus("ended");
            promotion.update();
            return Changed.QUIET;
        }
        if (now.isBefore(promotion.getPaidUntil())) return Changed.NOTHING;
        if ("stopped".equals(promotion.getStatus())) {
            promotion.setStatus("ended");
            promotion.update();
            return Changed.ENDED;
        }
        // From where it ran out, unless the server was away for long
        long since = ms(now) - ms(promotion.getPaidUntil()) < DAY ? ms(promotion.getPaidUntil()) : ms(now);
        long until = Math.min(since + DAY, ms(event.getEndsAt()));
        int amount = cost(promotion.getDaily(), until - since);
        int balance = Wallets.locked(ctx, event.getCreatorId()).getBalance();
        if (amount == 0 || balance >= amount) {
            charge(ctx, event, promotion, amount, now);
            promotion.setPaidRate(promotion.getDaily());
            promotion.setPaidUntil(Instant.ofEpochMilli(until));
            promotion.update();
            return Changed.NOTHING;
        }
        promotion.setStatus("paused");
        promotion.update();
        return Changed.PAUSED;
    }

    /**
     * The promotions of the user paused for lack of credits, locked before the wallet (the order
     * of the package): a top-up locks them first, then credits, then {@link #resume}s them.
     */
    public static List<PromotionsRecord> pausedOf(DSLContext ctx, UUID user, Instant now) {
        return ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.STATUS.eq("paused")).and(PROMOTIONS.EVENT_ID.in(
                        ctx.select(EVENTS.ID).from(EVENTS).where(EVENTS.CREATOR_ID.eq(user)).and(EVENTS.CANCELLED_AT.isNull())
                                .and(EVENTS.ENDS_AT.gt(now))))
                .orderBy(PROMOTIONS.EVENT_ID).forUpdate().fetch();
    }

    /** A top-up: the promotions paused for lack of credits start again at once, while the balance pays. Answers those resumed. */
    public static List<UUID> resume(DSLContext ctx, List<PromotionsRecord> paused, Instant now) {
        List<UUID> resumed = new ArrayList<>();
        for (PromotionsRecord promotion : paused) {
            EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(promotion.getEventId())).fetchOne();
            if (event == null || event.getCancelledAt() != null || !now.isBefore(event.getEndsAt())) continue;
            long length = Math.min(DAY, ms(event.getEndsAt()) - ms(now));
            int amount = cost(promotion.getDaily(), length);
            if (Wallets.locked(ctx, event.getCreatorId()).getBalance() < amount) continue;
            charge(ctx, event, promotion, amount, now);
            promotion.setStatus("live");
            promotion.setPaidRate(promotion.getDaily());
            promotion.setPaidUntil(now.plusMillis(length));
            promotion.update();
            resumed.add(event.getId());
        }
        return resumed;
    }
}
