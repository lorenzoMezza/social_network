// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.ERASED_ACCOUNTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.IDEMPOTENCY_KEYS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.PROMOTIONS;
import static masterkey.store.db.Tables.WALLETS;
import static masterkey.store.db.Tables.WALLET_ENTRIES;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import masterkey.api.common.Later;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import masterkey.jobs.Work;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventsRecord;
import org.jooq.JSONB;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

/**
 * The jobs against the whole server and its worker (JAVA-BACKEND.md §8): what they do, that a
 * second run changes nothing, and that a job exists only if the transaction that writes it commits.
 */
class JobsTest {

    static final TestServer server = new TestServer();
    static final Database db = server.context.getBean(Database.class);
    static final Work work = server.context.getBean(Work.class);
    static int places;

    @AfterAll
    static void stop() {
        server.close();
    }

    record User(String token, UUID id) {
    }

    static User user(String sub) {
        String token = server.token(sub);
        return new User(token, Ids.parse("usr", server.get("/v1/me", token).body().get("id").stringValue()).orElseThrow());
    }

    static synchronized Point place() {
        return Geo.offset(44.49, 11.34, 100.0 * places++, 0);
    }

    static UUID event(User owner, long startHours, long endHours) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Point at = place();
        String body = "{\"title\":\"Festa\",\"description\":\"In cortile\",\"categories\":[\"party\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Cortile\"},"
                + "\"dates\":{\"startDate\":\"" + now.plus(startHours, ChronoUnit.HOURS) + "\",\"endDate\":\"" + now.plus(endHours, ChronoUnit.HOURS) + "\"}}";
        var made = server.json("POST", "/v1/events", owner.token(), body);
        assertThat(made.status()).as(made.raw().body()).isEqualTo(201);
        return Ids.parse("ev", made.body().get("id").stringValue()).orElseThrow();
    }

    static void move(UUID event, Instant start, Instant end) {
        db.txRun(ctx -> ctx.update(EVENTS).set(EVENTS.STARTS_AT, start).set(EVENTS.ENDS_AT, end).where(EVENTS.ID.eq(event)).execute());
    }

    static EventsRecord row(UUID event) {
        return db.read(ctx -> ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne());
    }

    static int notifications(UUID user, String kind) {
        return db.read(ctx -> ctx.fetchCount(NOTIFICATIONS, NOTIFICATIONS.USER_ID.eq(user).and(NOTIFICATIONS.KIND.eq(kind))));
    }

    @Test
    void theCleaningForgetsWhatRanOut() {
        User user = user("jobs-clean");
        Instant now = Instant.now();
        db.txRun(ctx -> {
            for (String key : List.of("old", "new")) {
                ctx.insertInto(IDEMPOTENCY_KEYS).set(IDEMPOTENCY_KEYS.USER_ID, user.id()).set(IDEMPOTENCY_KEYS.SCOPE, "event")
                        .set(IDEMPOTENCY_KEYS.KEY, key).set(IDEMPOTENCY_KEYS.MADE_ID, Ids.next())
                        .set(IDEMPOTENCY_KEYS.AT, key.equals("old") ? now.minus(Duration.ofDays(2)) : now).execute();
                ctx.insertInto(ERASED_ACCOUNTS).set(ERASED_ACCOUNTS.SUB, "jobs-erased-" + key)
                        .set(ERASED_ACCOUNTS.AT, key.equals("old") ? now.minus(Duration.ofHours(3)) : now).execute();
                ctx.insertInto(NOTIFICATIONS).set(NOTIFICATIONS.ID, Ids.next()).set(NOTIFICATIONS.USER_ID, user.id())
                        .set(NOTIFICATIONS.KIND, "test." + key).set(NOTIFICATIONS.DATA, JSONB.valueOf("{}"))
                        .set(NOTIFICATIONS.AT, key.equals("old") ? now.minus(Duration.ofDays(61)) : now).execute();
            }
        });
        work.cleanup();
        work.cleanup();
        List<String> keys = db.read(ctx -> ctx.select(IDEMPOTENCY_KEYS.KEY).from(IDEMPOTENCY_KEYS).where(IDEMPOTENCY_KEYS.USER_ID.eq(user.id()))
                .fetch(IDEMPOTENCY_KEYS.KEY));
        assertThat(keys).containsExactly("new");
        List<String> erased = db.read(ctx -> ctx.select(ERASED_ACCOUNTS.SUB).from(ERASED_ACCOUNTS).where(ERASED_ACCOUNTS.SUB.like("jobs-erased-%"))
                .fetch(ERASED_ACCOUNTS.SUB));
        assertThat(erased).containsExactly("jobs-erased-new");
        assertThat(notifications(user.id(), "test.old")).isZero();
        assertThat(notifications(user.id(), "test.new")).isOne();
    }

    @Test
    void startingSoonIsSaidOncePerStart() {
        User host = user("jobs-remind-host");
        User guest = user("jobs-remind-guest");
        UUID event = event(host, 5, 6);
        assertThat(server.json("PUT", "/v1/events/" + Ids.publicId("ev", event) + "/followers/me", guest.token(), "").status()).isEqualTo(200);
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        move(event, now.plus(Duration.ofMinutes(30)), now.plus(Duration.ofMinutes(90)));
        work.remind();
        work.remind();
        assertThat(notifications(guest.id(), "event.starting")).isOne();
        assertThat(notifications(host.id(), "event.starting")).isZero();
        assertThat(row(event).getStartingNotifiedFor()).isEqualTo(now.plus(Duration.ofMinutes(30)));
        // Moved: said again for the new start
        move(event, now.plus(Duration.ofMinutes(40)), now.plus(Duration.ofMinutes(90)));
        work.remind();
        assertThat(notifications(guest.id(), "event.starting")).isEqualTo(2);
    }

    @Test
    void anEventsChatClosesOnceAtItsEnd() {
        User host = user("jobs-close");
        UUID event = event(host, 1, 2);
        Instant now = Instant.now();
        move(event, now.minus(Duration.ofHours(2)), now.minus(Duration.ofMinutes(1)));
        work.closeChats();
        Instant closed = row(event).getChatClosedAt();
        assertThat(closed).isNotNull();
        work.closeChats();
        assertThat(row(event).getChatClosedAt()).isEqualTo(closed);
    }

    @Test
    void aPromotionPaysItsNextDayOrPauses() {
        User host = user("jobs-charge");
        UUID event = event(host, 48, 50);
        Instant now = Instant.now();
        db.txRun(ctx -> {
            ctx.insertInto(WALLETS).set(WALLETS.USER_ID, host.id()).set(WALLETS.BALANCE, 150).set(WALLETS.ACCOUNT_TOKEN, UUID.randomUUID()).execute();
            EventsRecord row = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne();
            ctx.insertInto(PROMOTIONS).set(PROMOTIONS.EVENT_ID, event).set(PROMOTIONS.LATITUDE, row.getLatitude())
                    .set(PROMOTIONS.LONGITUDE, row.getLongitude()).set(PROMOTIONS.RADIUS, 1000).set(PROMOTIONS.DAILY, 99)
                    .set(PROMOTIONS.PAID_RATE, 99).set(PROMOTIONS.STARTED_AT, now.minus(Duration.ofDays(1)))
                    .set(PROMOTIONS.PAID_UNTIL, now.minus(Duration.ofMinutes(1))).set(PROMOTIONS.STATUS, "live").set(PROMOTIONS.CHARGED, 99).execute();
        });
        work.charge();
        work.charge();
        var paid = db.read(ctx -> ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(event)).fetchOne());
        assertThat(paid.getStatus()).isEqualTo("live");
        assertThat(paid.getCharged()).isEqualTo(198);
        // From where it ran out, 24 hours
        assertThat(Duration.between(now, paid.getPaidUntil()).toMinutes()).isBetween(24 * 60 - 2L, 24 * 60L);
        Integer balance = db.read(ctx -> ctx.select(WALLETS.BALANCE).from(WALLETS).where(WALLETS.USER_ID.eq(host.id())).fetchOne(WALLETS.BALANCE));
        assertThat(balance).isEqualTo(51);
        int days = db.read(ctx -> ctx.fetchCount(WALLET_ENTRIES, WALLET_ENTRIES.USER_ID.eq(host.id()).and(WALLET_ENTRIES.KIND.eq("day"))));
        assertThat(days).isOne();

        // Not enough for the next day: paused, and the organizer is told
        db.txRun(ctx -> ctx.update(PROMOTIONS).set(PROMOTIONS.PAID_UNTIL, now.minus(Duration.ofMinutes(1))).where(PROMOTIONS.EVENT_ID.eq(event)).execute());
        work.charge();
        String status = db.read(ctx -> ctx.select(PROMOTIONS.STATUS).from(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(event)).fetchOne(PROMOTIONS.STATUS));
        assertThat(status).isEqualTo("paused");
        assertThat(notifications(host.id(), "promotion.paused")).isOne();
        work.charge();
        assertThat(notifications(host.id(), "promotion.paused")).isOne();
    }

    @Test
    void retentionTakesEventChatsAfter30DaysAndEventsAfterAYear() throws Exception {
        User host = user("jobs-retention");
        UUID recent = event(host, 1, 2);
        var said = server.json("POST", "/v1/chats/event:" + Ids.publicId("ev", recent) + "/messages", host.token(), "{\"text\":\"ciao\",\"clientId\":\"r1\"}");
        assertThat(said.status()).as(said.raw().body()).isEqualTo(201);
        UUID chat = db.read(ctx -> ctx.select(CHATS.ID).from(CHATS).where(CHATS.EVENT_ID.eq(recent)).fetchOne(CHATS.ID));
        Instant now = Instant.now();
        move(recent, now.minus(Duration.ofDays(32)), now.minus(Duration.ofDays(31)));

        UUID old = event(host, 3, 4);
        Path cover = Path.of(server.context.getBean(Settings.class).dataDir(), "media", "covers", "retention-" + Ids.secret(8) + ".jpg");
        Files.createDirectories(cover.getParent());
        Files.write(cover, new byte[] {1, 2, 3});
        String key = "covers/" + cover.getFileName();
        db.txRun(ctx -> ctx.update(EVENTS).set(EVENTS.IMAGE_KEYS, new String[] {key}).where(EVENTS.ID.eq(old)).execute());
        move(old, now.minus(Duration.ofDays(401)), now.minus(Duration.ofDays(400)));

        work.retention();
        work.retention();
        int messages = db.read(ctx -> ctx.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat)));
        assertThat(messages).isZero();
        assertThat(row(recent).getChatPurgedAt()).isNotNull();
        boolean eventKept = db.read(ctx -> ctx.fetchExists(EVENTS, EVENTS.ID.eq(old)));
        boolean chatKept = db.read(ctx -> ctx.fetchExists(CHATS, CHATS.EVENT_ID.eq(old)));
        assertThat(eventKept).isFalse();
        assertThat(chatKept).isFalse();
        // The cover goes too, by a job of the worker
        for (int i = 0; i < 100 && Files.exists(cover); i++) Thread.sleep(100);
        assertThat(cover).doesNotExist();
    }

    @Test
    void aJobExistsOnlyIfItsTransactionCommits() throws Exception {
        Later later = server.context.getBean(Later.class);
        String key = "covers/rollback-" + Ids.secret(8) + ".jpg";
        assertThatThrownBy(() -> db.txRun(ctx -> {
            later.deleteFiles(List.of(key));
            // Inside the transaction the job is there, its data in JSON
            String data = ctx.fetchValue("SELECT convert_from(task_data, 'UTF8') FROM scheduled_tasks WHERE task_name = 'files.delete' "
                    + "AND convert_from(task_data, 'UTF8') LIKE {0}", "%" + key + "%").toString();
            assertThat(data).isEqualTo("{\"keys\":[\"" + key + "\"]}");
            throw new IllegalStateException("roll back");
        })).hasMessage("roll back");
        assertThat(jobsNaming(key)).isZero();

        Path file = Path.of(server.context.getBean(Settings.class).dataDir(), "media", key);
        Files.createDirectories(file.getParent());
        Files.write(file, new byte[] {1});
        db.txRun(ctx -> later.deleteFiles(List.of(key)));
        for (int i = 0; i < 100 && Files.exists(file); i++) Thread.sleep(100);
        assertThat(file).doesNotExist();
        // Done: the row of a one-time job goes
        for (int i = 0; i < 50 && jobsNaming(key) > 0; i++) Thread.sleep(100);
        assertThat(jobsNaming(key)).isZero();
    }

    static int jobsNaming(String key) {
        return db.read(ctx -> ctx.fetchValue("SELECT count(*) FROM scheduled_tasks WHERE task_name = 'files.delete' "
                + "AND convert_from(task_data, 'UTF8') LIKE {0}", "%" + key + "%") instanceof Number n ? n.intValue() : -1);
    }
}
