// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.store;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.USERS;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

/** The first migration on a real PostGIS 18: what the schema refuses, and what the program relies on. */
class SchemaTest {

    static final Database db = TestDatabase.fresh();
    static final Instant NOW = Instant.parse("2026-11-11T10:00:00.000Z");

    @AfterAll
    static void close() {
        db.close();
    }

    static UUID user(DSLContext ctx, String username) {
        UUID id = Ids.random();
        ctx.insertInto(USERS)
                .set(USERS.ID, id)
                .set(USERS.SUB, "sub-" + id)
                .set(USERS.USERNAME, username)
                .set(USERS.NAME, "Sara")
                .set(USERS.LAST_ACTIVE_ON, LocalDate.of(2026, 11, 11))
                .set(USERS.STYLE, JSONB.valueOf("{}"))
                .set(USERS.SETTINGS, JSONB.valueOf("{}"))
                .set(USERS.STORY, JSONB.valueOf("{}"))
                .set(USERS.CREATED_AT, NOW)
                .execute();
        return id;
    }

    @Test
    void anEventGetsItsGeographyFromItsTwoNumbers() {
        UUID creator = db.tx(ctx -> user(ctx, "sara_m"));
        UUID event = Ids.next();
        db.txRun(ctx -> ctx.insertInto(EVENTS)
                .set(EVENTS.ID, event)
                .set(EVENTS.CREATOR_ID, creator)
                .set(EVENTS.TITLE, "Aperitivo")
                .set(EVENTS.LATITUDE, 41.9028)
                .set(EVENTS.LONGITUDE, 12.4964)
                .set(EVENTS.STARTS_AT, NOW.plusSeconds(3600))
                .set(EVENTS.ENDS_AT, NOW.plusSeconds(7200))
                .set(EVENTS.CREATED_AT, NOW)
                .set(EVENTS.REACH, 800)
                .execute());
        Double metres = db.read(ctx -> ctx.fetchOne(
                "SELECT ST_Distance(location, ST_SetSRID(ST_MakePoint(12.4964, 41.9128), 4326)::geography) FROM events WHERE id = ?",
                event).get(0, Double.class));
        // 0.01 degrees north: about 1112 m on the spheroid
        assertThat(metres).isBetween(1100.0, 1125.0);
        Integer near = db.read(ctx -> ctx.fetchOne(
                "SELECT count(*)::int FROM events WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(12.4965, 41.9028), 4326)::geography, 15)")
                .get(0, Integer.class));
        assertThat(near).isEqualTo(1);
        assertThat(db.read(ctx -> ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne()).getStartsAt())
                .isEqualTo(NOW.plusSeconds(3600));
    }

    @Test
    void handlesFollowTheRulesOfHandles() {
        for (String bad : new String[] {"ab", ".sara", "sara.", "sa..ra", "Sara", "sara m", "a".repeat(31)}) {
            assertThatThrownBy(() -> db.tx(ctx -> user(ctx, bad))).as(bad).hasMessageContaining("users_username_check");
        }
        db.tx(ctx -> user(ctx, "_ok_"));
        assertThatThrownBy(() -> db.tx(ctx -> user(ctx, "_ok_")))
                .satisfies(error -> assertThat(Database.violated(error)).isEqualTo("users_username_key"));
    }

    @Test
    void aFailedTransactionLeavesNothing() {
        assertThatThrownBy(() -> db.txRun(ctx -> {
            user(ctx, "rolled_back");
            throw ApiError.conflict("x", "stop");
        })).isInstanceOf(ApiError.class);
        Integer left = db.read(ctx -> ctx.fetchCount(USERS, USERS.USERNAME.eq("rolled_back")));
        assertThat(left).isZero();
    }

    @Test
    void theLockOnAPersonMakesTwoTransactionsWaitForEachOther() throws Exception {
        UUID person = db.tx(ctx -> user(ctx, "locked_one"));
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (ExecutorService threads = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> first = threads.submit(() -> db.txRun(ctx -> {
                Database.lockPerson(ctx, person);
                inside.countDown();
                try {
                    release.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }));
            inside.await();
            long start = System.nanoTime();
            Future<Long> second = threads.submit(() -> db.tx(ctx -> {
                Database.lockPerson(ctx, person);
                return System.nanoTime();
            }));
            Thread.sleep(300);
            assertThat(second.isDone()).isFalse();
            release.countDown();
            first.get();
            assertThat(second.get() - start).isGreaterThan(250_000_000L);
        }
    }
}
