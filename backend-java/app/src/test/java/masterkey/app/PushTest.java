// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.PUSH_TOKENS;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import masterkey.jobs.push.PushSender;
import masterkey.jobs.push.Pushes;
import masterkey.presence.PresenceService;
import masterkey.store.Database;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

/**
 * Pushes against the whole server with fake APNs and FCM (§18, Push): who is told, once, with
 * the count and never the text; nothing about someone blocked; a gone token removed; in an
 * event's chat only what its organizer writes.
 */
class PushTest {

    static final TestServer server = new TestServer();
    static final Database db = server.context.getBean(Database.class);
    static int places;

    @AfterAll
    static void stop() {
        server.close();
    }

    record Sent(String token, PushSender.Message message) {
    }

    static final class Fake implements PushSender {
        final List<Sent> sent = new CopyOnWriteArrayList<>();
        volatile Result next = Result.SENT;

        @Override
        public Result send(String token, Message message) {
            sent.add(new Sent(token, message));
            return next;
        }
    }

    record User(String token, String id) {
        UUID uuid() {
            return Ids.parse("usr", id).orElseThrow();
        }
    }

    static User user(String sub, String name) {
        String token = server.token(sub);
        String id = server.get("/v1/me", token).body().get("id").stringValue();
        assertThat(server.json("PATCH", "/v1/me", token, "{\"name\":\"" + name + "\"}").status()).isEqualTo(200);
        return new User(token, id);
    }

    static void connect(User a, User b) {
        Instant now = Instant.now();
        db.txRun(ctx -> {
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, a.uuid()).set(CONNECTIONS.OTHER_ID, b.uuid()).set(CONNECTIONS.SINCE, now).execute();
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, b.uuid()).set(CONNECTIONS.OTHER_ID, a.uuid()).set(CONNECTIONS.SINCE, now).execute();
        });
    }

    static void register(User user, String token, String platform) {
        assertThat(server.json("POST", "/v1/me/push-tokens", user.token(), "{\"token\":\"" + token + "\",\"platform\":\"" + platform + "\"}").status())
                .isEqualTo(204);
    }

    static String say(User who, String chat, String text) {
        var said = server.json("POST", "/v1/chats/" + chat + "/messages", who.token(), "{\"text\":\"" + text + "\"}");
        assertThat(said.status()).as(said.raw().body()).isEqualTo(201);
        return said.body().get("id").stringValue();
    }

    static Pushes pushes(Fake apns, Fake fcm) {
        return new Pushes(db, server.context.getBean(PresenceService.class), apns, fcm);
    }

    @Test
    void aChatIsToldOnceWithTheCountAndNeverTheText() {
        User ada = user("push-ada", "Ada"), ben = user("push-ben", "Ben");
        connect(ada, ben);
        String iphone = "b".repeat(64);
        register(ben, iphone, "ios");
        register(ben, "ben-android-token", "android");
        String chat = server.json("POST", "/v1/chats/direct", ada.token(), "{\"userId\":\"" + ben.id() + "\"}").body().get("id").stringValue();
        say(ada, chat, "ci vediamo alle otto");
        say(ada, chat, "porta la torta");
        Fake apns = new Fake(), fcm = new Fake();
        UUID chatId = Ids.parse("chat", chat).orElseThrow();
        pushes(apns, fcm).chat(chatId);
        assertThat(apns.sent).hasSize(1);
        assertThat(fcm.sent).hasSize(1);
        PushSender.Message message = apns.sent.getFirst().message();
        assertThat(apns.sent.getFirst().token()).isEqualTo(iphone);
        assertThat(message.title()).isEqualTo("Ada");
        assertThat(message.body()).isEqualTo("2 new messages");
        assertThat(message.data()).containsEntry("chatId", chat);
        assertThat(message.toString()).doesNotContain("torta").doesNotContain("otto");
        // Run again: nobody is told the same messages twice
        pushes(apns, fcm).chat(chatId);
        assertThat(apns.sent).hasSize(1);
        // Read on another phone: nothing more either
        String last = say(ada, chat, "e i piatti");
        assertThat(server.json("POST", "/v1/chats/" + chat + "/read", ben.token(), "{\"messageId\":\"" + last + "\"}").status()).isEqualTo(204);
        pushes(apns, fcm).chat(chatId);
        assertThat(apns.sent).hasSize(1);
        // A token Apple says is gone goes
        say(ada, chat, "ok?");
        apns.next = PushSender.Result.GONE;
        pushes(apns, fcm).chat(chatId);
        int left = db.read(ctx -> ctx.fetchCount(PUSH_TOKENS, PUSH_TOKENS.USER_ID.eq(ben.uuid())));
        assertThat(left).isOne();
    }

    @Test
    void nothingAboutSomeoneBlockedAndOnlyTheOrganizerInAnEventsChat() {
        User host = user("push-host", "Host"), guest = user("push-guest", "Guest"), other = user("push-other", "Other");
        connect(host, guest);
        connect(host, other);
        register(guest, "c".repeat(64), "ios");
        var group = server.json("POST", "/v1/chats", host.token(),
                "{\"title\":\"Cena\",\"color\":\"#2F7BFF\",\"memberIds\":[\"" + guest.id() + "\",\"" + other.id() + "\"]}");
        String chat = group.body().get("id").stringValue();
        UUID chatId = Ids.parse("chat", chat).orElseThrow();
        db.txRun(ctx -> ctx.insertInto(BLOCKS).set(BLOCKS.BLOCKER, guest.uuid()).set(BLOCKS.BLOCKED, other.uuid()).set(BLOCKS.SINCE, Instant.now()).execute());
        say(other, chat, "ciao a tutti");
        Fake apns = new Fake();
        pushes(apns, null).chat(chatId);
        assertThat(apns.sent).isEmpty();
        say(host, chat, "a che ora?");
        pushes(apns, null).chat(chatId);
        assertThat(apns.sent).hasSize(1);
        assertThat(apns.sent.getFirst().message().title()).isEqualTo("Cena");
        assertThat(apns.sent.getFirst().message().body()).isEqualTo("New message");

        // An event's chat: a guest's message is no push; the organizer's is
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Point at = Geo.offset(40.85, 14.27, 100.0 * places++, 0);
        var made = server.json("POST", "/v1/events", host.token(), "{\"title\":\"Pizza\",\"description\":\"Al porto\",\"categories\":[\"food\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Porto\"},"
                + "\"dates\":{\"startDate\":\"" + now.plus(3, ChronoUnit.HOURS) + "\",\"endDate\":\"" + now.plus(5, ChronoUnit.HOURS) + "\"}}");
        String event = made.body().get("id").stringValue();
        server.json("PUT", "/v1/events/" + event + "/followers/me", guest.token(), "");
        server.json("PUT", "/v1/events/" + event + "/followers/me", other.token(), "");
        UUID eventChat = db.read(ctx -> ctx.select(masterkey.store.db.Tables.CHATS.ID).from(masterkey.store.db.Tables.CHATS)
                .where(masterkey.store.db.Tables.CHATS.EVENT_ID.eq(Ids.parse("ev", event).orElseThrow())).fetchOne(masterkey.store.db.Tables.CHATS.ID));
        apns.sent.clear();
        say(other, "event:" + event, "arrivo");
        pushes(apns, null).chat(eventChat);
        assertThat(apns.sent).isEmpty();
        say(host, "event:" + event, "tavolo prenotato");
        pushes(apns, null).chat(eventChat);
        assertThat(apns.sent).hasSize(1);
        assertThat(apns.sent.getFirst().message().title()).isEqualTo("Pizza");
        assertThat(apns.sent.getFirst().message().body()).isEqualTo("New message from the organizer");
    }

    @Test
    void aNotificationIsToldToWhoIsNotOnline() {
        User host = user("push-n-host", "Nina"), guest = user("push-n-guest", "Gio");
        register(host, "d".repeat(64), "ios");
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Point at = Geo.offset(45.07, 7.68, 100.0 * places++, 0);
        String event = server.json("POST", "/v1/events", host.token(), "{\"title\":\"Picnic\",\"description\":\"Al parco\",\"categories\":[\"food\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Parco\"},"
                + "\"dates\":{\"startDate\":\"" + now.plus(3, ChronoUnit.HOURS) + "\",\"endDate\":\"" + now.plus(5, ChronoUnit.HOURS) + "\"}}")
                .body().get("id").stringValue();
        server.json("PUT", "/v1/events/" + event + "/followers/me", guest.token(), "");
        UUID notification = db.read(ctx -> ctx.select(NOTIFICATIONS.ID).from(NOTIFICATIONS).where(NOTIFICATIONS.USER_ID.eq(host.uuid()))
                .and(NOTIFICATIONS.KIND.eq("event.joined")).fetchOne(NOTIFICATIONS.ID));
        // The job was written with the notification, a few seconds ahead (the worker here has no service to send with)
        int jobs = db.read(ctx -> ctx.fetchCount(ctx.selectOne().from("scheduled_tasks")
                .where("task_name = 'push.notify' AND task_instance = ?", notification.toString())));
        assertThat(jobs).isOne();
        Fake apns = new Fake();
        pushes(apns, null).notification(notification);
        assertThat(apns.sent).hasSize(1);
        assertThat(apns.sent.getFirst().message().title()).isEqualTo("Picnic");
        assertThat(apns.sent.getFirst().message().body()).isEqualTo("Gio is going");
        assertThat(apns.sent.getFirst().message().data()).containsEntry("eventId", event).containsEntry("kind", "event.joined");
        // Read in the app meanwhile: no push
        server.json("POST", "/v1/me/notifications/read", host.token(), "");
        pushes(apns, null).notification(notification);
        assertThat(apns.sent).hasSize(1);
    }
}
