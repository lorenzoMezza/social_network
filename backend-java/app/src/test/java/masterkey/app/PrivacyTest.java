// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.ERASED_ACCOUNTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.STORE_TRANSACTIONS;
import static masterkey.store.db.Tables.USERS;
import static masterkey.store.db.Tables.WALLETS;
import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Point;
import masterkey.store.Database;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** The user's rights against the whole server (privacy.py): a copy of their data once, and DELETE /me with what it does to others. */
class PrivacyTest {

    static final TestServer server = new TestServer();
    static final Database db = server.context.getBean(Database.class);
    static int places;

    @AfterAll
    static void stop() {
        server.close();
    }

    record User(String token, String id, String sub) {
        UUID uuid() {
            return Ids.parse("usr", id).orElseThrow();
        }
    }

    static User user(String sub) {
        String token = server.token(sub);
        return new User(token, server.get("/v1/me", token).body().get("id").stringValue(), sub);
    }

    static void connect(User a, User b) {
        Instant now = Instant.now();
        db.txRun(ctx -> {
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, a.uuid()).set(CONNECTIONS.OTHER_ID, b.uuid()).set(CONNECTIONS.SINCE, now).execute();
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, b.uuid()).set(CONNECTIONS.OTHER_ID, a.uuid()).set(CONNECTIONS.SINCE, now).execute();
        });
    }

    static String event(User owner, String title) {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Point at = Geo.offset(43.77, 11.25, 100.0 * places++, 0);
        String body = "{\"title\":\"" + title + "\",\"description\":\"Sul fiume\",\"categories\":[\"music\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Lungarno\"},"
                + "\"dates\":{\"startDate\":\"" + now.plus(5, ChronoUnit.HOURS) + "\",\"endDate\":\"" + now.plus(7, ChronoUnit.HOURS) + "\"}}";
        var made = server.json("POST", "/v1/events", owner.token(), body);
        assertThat(made.status()).as(made.raw().body()).isEqualTo(201);
        return made.body().get("id").stringValue();
    }

    static String say(User who, String chat, String text) {
        var said = server.json("POST", "/v1/chats/" + chat + "/messages", who.token(), "{\"text\":\"" + text + "\"}");
        assertThat(said.status()).as(said.raw().body()).isEqualTo(201);
        return said.body().get("id").stringValue();
    }

    @Test
    void theCopyOfOnesDataIsGivenOnce() {
        User anna = user("privacy-copy");
        String party = event(anna, "Concerto");
        say(anna, "event:" + party, "benvenuti");
        var link = server.json("POST", "/v1/me/export", anna.token(), "");
        assertThat(link.status()).as(link.raw().body()).isEqualTo(200);
        String url = link.body().get("url").stringValue();
        assertThat(url).contains("/v1/exports/");
        var copy = server.send(HttpRequest.newBuilder(server.uri(URI.create(url).getPath())).GET());
        assertThat(copy.status()).isEqualTo(200);
        assertThat(copy.header("Content-Disposition")).startsWith("attachment; filename=\"my-data-");
        assertThat(copy.header("Cache-Control")).isEqualTo("no-store");
        JsonNode data = copy.body();
        assertThat(data.get("format").stringValue()).isEqualTo("masterkey.export");
        assertThat(data.get("account").get("id").stringValue()).isEqualTo(anna.id());
        assertThat(data.get("eventsOrganized").findValuesAsString("id")).containsExactly(party);
        assertThat(data.get("chats").get(0).get("chatId").stringValue()).isEqualTo("event:" + party);
        assertThat(data.get("chats").get(0).get("messagesSent").findValuesAsString("text")).containsExactly("benvenuti");
        assertThat(data.has("promotionCredits")).isTrue();
        // Once only
        assertThat(server.send(HttpRequest.newBuilder(server.uri(URI.create(url).getPath())).GET()).status()).isEqualTo(410);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/exports/nothing")).GET()).body().get("code").stringValue()).isEqualTo("expired");
    }

    @Test
    void aDeletedAccountLeavesNothingOfItsOwnAndOthersGoOn() throws Exception {
        User anna = user("privacy-anna"), bruno = user("privacy-bruno"), carla = user("privacy-carla");
        connect(anna, bruno);
        connect(anna, carla);
        // Her event, Bruno going; Bruno's event, her going
        String hers = event(anna, "Festa di Anna");
        assertThat(server.json("PUT", "/v1/events/" + hers + "/followers/me", bruno.token(), "").status()).isEqualTo(200);
        String his = event(bruno, "Cena di Bruno");
        assertThat(server.json("PUT", "/v1/events/" + his + "/followers/me", anna.token(), "").status()).isEqualTo(200);
        UUID hisId = Ids.parse("ev", his).orElseThrow();
        int followersBefore = followers(hisId);
        // A direct chat, and a group she runs
        String direct = server.json("POST", "/v1/chats/direct", anna.token(), "{\"userId\":\"" + bruno.id() + "\"}").body().get("id").stringValue();
        say(anna, direct, "ciao Bruno");
        var group = server.json("POST", "/v1/chats", anna.token(),
                "{\"title\":\"Gita\",\"color\":\"#2F7BFF\",\"memberIds\":[\"" + bruno.id() + "\",\"" + carla.id() + "\"]}");
        assertThat(group.status()).as(group.raw().body()).isEqualTo(201);
        String chat = group.body().get("id").stringValue();
        say(anna, chat, "partiamo alle 9");
        say(carla, chat, "ok!");
        // Credits she bought
        db.txRun(ctx -> {
            ctx.insertInto(WALLETS).set(WALLETS.USER_ID, anna.uuid()).set(WALLETS.BALANCE, 99).set(WALLETS.ACCOUNT_TOKEN, UUID.randomUUID()).execute();
            ctx.insertInto(STORE_TRANSACTIONS).set(STORE_TRANSACTIONS.KEY, "ios:privacy-1").set(STORE_TRANSACTIONS.USER_ID, anna.uuid()).execute();
        });

        var deleted = server.send(HttpRequest.newBuilder(server.uri("/v1/me")).header("Authorization", "Bearer " + anna.token()).DELETE());
        assertThat(deleted.status()).as(deleted.raw().body()).isEqualTo(204);

        // Her token, issued before, can no longer make the account again
        assertThat(server.get("/v1/me", anna.token()).status()).isEqualTo(401);
        boolean exists = db.read(ctx -> ctx.fetchExists(USERS, USERS.ID.eq(anna.uuid())));
        assertThat(exists).isFalse();
        boolean erased = db.read(ctx -> ctx.fetchExists(ERASED_ACCOUNTS, ERASED_ACCOUNTS.SUB.eq(anna.sub())));
        assertThat(erased).isTrue();
        // Her event is gone; who was going was told, with its title
        assertThat(server.get("/v1/events/" + hers, bruno.token()).status()).isEqualTo(404);
        JsonNode notes = server.get("/v1/me/notifications", bruno.token()).body().get("items");
        JsonNode cancelled = null;
        for (JsonNode note : notes) if ("event.cancelled".equals(note.get("kind").stringValue())) cancelled = note;
        assertThat(cancelled).isNotNull();
        assertThat(cancelled.get("data").get("title").stringValue()).isEqualTo("Festa di Anna");
        // What she did on his event went down with her
        assertThat(followers(hisId)).isEqualTo(followersBefore - 1);
        // The direct chat is gone from his phone; the group passed on, and her words in it are removed
        assertThat(server.get("/v1/chats", bruno.token()).body().get("items").findValuesAsString("id")).doesNotContain(direct).contains(chat);
        JsonNode stays = server.get("/v1/chats/" + chat, bruno.token()).body();
        assertThat(stays.get("ownerId").stringValue()).isIn(bruno.id(), carla.id());
        for (int i = 0; i < 100 && messagesBy(anna.uuid()) > 0; i++) Thread.sleep(100);
        assertThat(messagesBy(anna.uuid())).isZero();
        JsonNode messages = server.get("/v1/chats/" + chat + "/messages", carla.token()).body().get("items");
        assertThat(messages.findValuesAsString("text")).doesNotContain("partiamo alle 9").contains("ok!");
        assertThat(Json.text(messages)).doesNotContain(anna.id());
        // Her purchases stay known without her: never credited again
        UUID owner = db.read(ctx -> ctx.select(STORE_TRANSACTIONS.USER_ID).from(STORE_TRANSACTIONS).where(STORE_TRANSACTIONS.KEY.eq("ios:privacy-1"))
                .fetchOne(STORE_TRANSACTIONS.USER_ID));
        assertThat(owner).isNull();
        // Sent again: the same answer
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/me")).header("Authorization", "Bearer " + anna.token()).DELETE()).status())
                .isEqualTo(401);
    }

    static int followers(UUID event) {
        return db.read(ctx -> ctx.select(EVENTS.FOLLOWER_COUNT).from(EVENTS).where(EVENTS.ID.eq(event)).fetchOne(EVENTS.FOLLOWER_COUNT));
    }

    static int messagesBy(UUID user) {
        return db.read(ctx -> ctx.fetchCount(MESSAGES, MESSAGES.SENDER.eq(user)));
    }
}
