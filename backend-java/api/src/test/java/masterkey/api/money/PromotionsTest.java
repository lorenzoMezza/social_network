// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;
import masterkey.core.ApiError;
import masterkey.store.db.Tables;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.PromotionsRecord;
import org.junit.jupiter.api.Test;

/** The prices and the time of promotions against promotions.py: the same numbers, case by case. */
class PromotionsTest {

    static final long HOUR = 3_600_000L;
    static final long DAY = 24 * HOUR;
    static final Instant NOW = Instant.parse("2026-11-11T10:00:00Z");

    /** promotions.daily_price for 1, 2, 4 and 8 days, computed with the Python. */
    static final int[][] PYTHON = {
        {1000, 99, 89, 79, 69}, {1500, 199, 179, 159, 139}, {2000, 299, 269, 239, 209}, {3000, 499, 449, 399, 349},
        {4000, 699, 629, 559, 489}, {5000, 899, 809, 719, 629}, {7500, 1099, 989, 879, 769}, {10000, 1299, 1169, 1039, 909}};

    @Test
    void dailyPricesAreThePython() {
        int[] days = {1, 2, 4, 8};
        for (int[] row : PYTHON) {
            for (int i = 0; i < days.length; i++) assertThat(Promotions.dailyPrice(row[0], days[i])).as(row[0] + " m, " + days[i] + " days").isEqualTo(row[i + 1]);
        }
        assertThat(Promotions.discountPercent(1)).isZero();
        assertThat(Promotions.discountPercent(3)).isEqualTo(10);
        assertThat(Promotions.discountPercent(40)).isEqualTo(30);
    }

    @Test
    void chargesRoundUpAndRefundsDown() {
        // promotions._cost, computed with the Python
        assertThat(Promotions.cost(99, 6 * HOUR)).isEqualTo(25);
        assertThat(Promotions.cost(1299, DAY)).isEqualTo(1299);
        assertThat(Promotions.cost(299, 1)).isEqualTo(1);
        assertThat(Promotions.cost(909, 37 * HOUR + 123)).isEqualTo(1402);
        assertThat(Promotions.cost(909, -5)).isZero();
        PromotionsRecord promotion = promotion(NOW.minusMillis(HOUR), NOW.plusMillis(23 * HOUR), 99, 99, 0);
        // The first 6 hours are never given back: 18 h of 99 a day, rounded down
        assertThat(Promotions.unused(promotion, NOW)).isEqualTo(74);
        // Never more than was paid and not given back yet
        promotion.setRefunded(90);
        assertThat(Promotions.unused(promotion, NOW)).isEqualTo(9);
    }

    @Test
    void aQuoteKeepsTheDiscountOfItsStart() {
        EventsRecord event = event(NOW.plusMillis(10 * DAY));
        Promotions.Quote fresh = Promotions.quote(event, null, 1000, NOW);
        assertThat(fresh.days()).isEqualTo(10);
        assertThat(fresh.daily()).isEqualTo(69);
        assertThat(fresh.firstCharge()).isEqualTo(69);
        assertThat(fresh.total()).isEqualTo(690);
        // Started 9 days before the end, 3 days ago: the 30% of its start stays
        PromotionsRecord running = promotion(NOW.minusMillis(3 * DAY), NOW.plusMillis(HOUR), 69, 69, 207);
        running.setStatus("live");
        EventsRecord soon = event(NOW.plusMillis(6 * DAY));
        assertThat(Promotions.quote(soon, running, 1000, NOW).daily()).isEqualTo(69);
        assertThat(Promotions.quote(soon, null, 1000, NOW).daily()).isEqualTo(79);
        // Close to the end: at least 6 hours are charged
        assertThat(Promotions.quote(event(NOW.plusMillis(HOUR)), null, 1000, NOW).firstCharge()).isEqualTo(25);
        assertThatThrownBy(() -> Promotions.quote(event, null, 1234, NOW)).isInstanceOf(ApiError.class);
    }

    @Test
    void flashAndOverEventsAreNotPromoted() {
        EventsRecord flash = event(NOW.plusMillis(DAY));
        flash.setFlash(true);
        assertThatThrownBy(() -> Promotions.promotable(flash, NOW)).hasFieldOrPropertyWithValue("status", 403);
        assertThatThrownBy(() -> Promotions.promotable(event(NOW.minusMillis(1)), NOW)).hasFieldOrPropertyWithValue("status", 410);
        EventsRecord cancelled = event(NOW.plusMillis(DAY));
        cancelled.setCancelledAt(NOW.minusMillis(1));
        assertThatThrownBy(() -> Promotions.promotable(cancelled, NOW)).hasFieldOrPropertyWithValue("status", 410);
    }

    @Test
    void theReachIsThePaidRadiusOnlyWhilePaid() {
        EventsRecord event = event(NOW.plusMillis(DAY));
        event.setReach(300);
        PromotionsRecord promotion = promotion(NOW.minusMillis(HOUR), NOW.plusMillis(HOUR), 99, 99, 99);
        promotion.setStatus("stopped");
        assertThat(Promotions.reachNow(event, promotion, NOW)).isEqualTo(1000);
        assertThat(Promotions.reachNow(event, promotion, NOW.plusMillis(2 * HOUR))).isEqualTo(300);
        promotion.setStatus("paused");
        assertThat(Promotions.reachNow(event, promotion, NOW)).isEqualTo(300);
        event.setFlash(true);
        assertThat(Promotions.reachNow(event, null, NOW)).isEqualTo(Promotions.FLASH_REACH);
    }

    @Test
    void packsAreTheStoreProducts() {
        assertThat(Wallets.packCredits("promo.credits.099")).isEqualTo(99);
        assertThat(Wallets.packCredits("promo.credits.9999")).isEqualTo(9999);
        assertThat(Wallets.packCredits("promo.credits.99")).isEqualTo(-1);
        assertThat(Wallets.packCredits(null)).isEqualTo(-1);
    }

    static EventsRecord event(Instant end) {
        EventsRecord event = Tables.EVENTS.newRecord();
        event.setId(UUID.randomUUID());
        event.setCreatorId(UUID.randomUUID());
        event.setStartsAt(end.minusMillis(HOUR));
        event.setEndsAt(end);
        event.setFlash(false);
        event.setReach(800);
        return event;
    }

    static PromotionsRecord promotion(Instant started, Instant paidUntil, int daily, int paidRate, int charged) {
        PromotionsRecord promotion = Tables.PROMOTIONS.newRecord();
        promotion.setRadius(1000);
        promotion.setDaily(daily);
        promotion.setPaidRate(paidRate);
        promotion.setStartedAt(started);
        promotion.setPaidUntil(paidUntil);
        promotion.setStatus("live");
        promotion.setCharged(charged == 0 ? 99 : charged);
        promotion.setRefunded(0);
        return promotion;
    }
}
