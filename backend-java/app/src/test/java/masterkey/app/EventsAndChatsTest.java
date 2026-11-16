// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpRequest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import masterkey.store.Database;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** Events and chats against the whole server, with the rules of routes/events.py and routes/chats.py. */
class EventsAndChatsTest {

    static final TestServer server = new TestServer();
    static int places;

    @AfterAll
    static void stop() {
        server.close();
    }

    record User(String token, String id) {
        UUID uuid() {
            return Ids.parse("usr", id).orElseThrow();
        }
    }

    static User user(String sub) {
        String token = server.token(sub);
        return new User(token, server.get("/v1/me", token).body().get("id").stringValue());
    }

    static void connect(User a, User b) {
        Database db = server.context.getBean(Database.class);
        Instant now = Instant.now();
        db.txRun(ctx -> {
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, a.uuid()).set(CONNECTIONS.OTHER_ID, b.uuid()).set(CONNECTIONS.SINCE, now).execute();
            ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, b.uuid()).set(CONNECTIONS.OTHER_ID, a.uuid()).set(CONNECTIONS.SINCE, now).execute();
        });
    }

    /** A new place for each event, 100 m apart, so no two are within 15 m by chance. */
    static synchronized Point place() {
        int n = places++;
        int row = n / 100;
        return Geo.offset(41.80, 12.40, 100.0 * (n % 100), 100.0 * row);
    }

    static String event(Point at, Instant start, Instant end, String extra) {
        return "{\"title\":\"Aperitivo\",\"description\":\"In piazza\",\"categories\":[\"drinks\",\"social\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Piazza\"},"
                + "\"dates\":{\"startDate\":\"" + start + "\",\"endDate\":\"" + end + "\"}" + extra + "}";
    }

    static Instant inHours(long hours) {
        return Instant.now().truncatedTo(ChronoUnit.SECONDS).plus(hours, ChronoUnit.HOURS);
    }

    static JsonNode create(User owner, Point at, Instant start, Instant end) {
        var answer = server.json("POST", "/v1/events", owner.token(), event(at, start, end, ""));
        assertThat(answer.status()).as(answer.raw().body()).isEqualTo(201);
        return answer.body();
    }

    @Test
    void anEventIsMadeFoundJoinedAndCancelled() {
        User sara = user("ev-sara"), luca = user("ev-luca");
        Point at = place();
        var made = server.send(HttpRequest.newBuilder(server.uri("/v1/events")).header("Authorization", "Bearer " + sara.token())
                .header("Content-Type", "application/json").header("Idempotency-Key", "k-1")
                .POST(HttpRequest.BodyPublishers.ofString(event(at, inHours(1), inHours(3), ",\"theme\":{\"color\":\"#AbCdEf\",\"beamStyle\":\"helix\"}"))));
        assertThat(made.status()).isEqualTo(201);
        JsonNode event = made.body();
        String id = event.get("id").stringValue();
        assertThat(id).startsWith("ev_");
        assertThat(event.get("status").stringValue()).isEqualTo("upcoming");
        assertThat(event.get("creator").get("id").stringValue()).isEqualTo(sara.id());
        assertThat(event.get("theme").get("color").stringValue()).isEqualTo("#AbCdEf");
        assertThat(event.get("theme").get("background").stringValue()).isEqualTo("plain");
        assertThat(event.get("reach").intValue()).isEqualTo(800);
        assertThat(event.get("sponsored").booleanValue()).isFalse();
        assertThat(event.get("baseReach").intValue()).isEqualTo(800);
        assertThat(event.get("promotion").isNull()).isTrue();
        // The same key again: the same event, not a second one, nor "too close"
        var again = server.send(HttpRequest.newBuilder(server.uri("/v1/events")).header("Authorization", "Bearer " + sara.token())
                .header("Content-Type", "application/json").header("Idempotency-Key", "k-1")
                .POST(HttpRequest.BodyPublishers.ofString(event(at, inHours(1), inHours(3), ""))));
        assertThat(again.status()).isEqualTo(201);
        assertThat(again.body().get("id").stringValue()).isEqualTo(id);
        // 10 m away: too close; the event of someone else for Luca, with no organizer's parts
        Point near = Geo.offset(at.latitude(), at.longitude(), 10, 0);
        assertThat(server.json("POST", "/v1/events", luca.token(), event(near, inHours(1), inHours(2), "")).body().get("code").stringValue())
                .isEqualTo("too_close");
        var found = server.get("/v1/events?latitude=" + at.latitude() + "&longitude=" + at.longitude() + "&range=500", luca.token());
        assertThat(found.status()).as(found.raw().body()).isEqualTo(200);
        assertThat(found.body().get("items").findValuesAsString("id")).contains(id);
        // 3 km away a moment later: no plane does that (position guard)
        Point far = Geo.offset(at.latitude(), at.longitude(), 3000, 0);
        assertThat(server.get("/v1/events?latitude=" + far.latitude() + "&longitude=" + far.longitude(), luca.token())
                .body().get("code").stringValue()).isEqualTo("position_rejected");
        assertThat(server.get("/v1/events?latitude=" + far.latitude() + "&longitude=" + far.longitude(), user("ev-far").token())
                .body().get("items").findValuesAsString("id")).doesNotContain(id);
        JsonNode page = server.get("/v1/events/" + id, luca.token()).body();
        assertThat(page.has("baseReach")).isFalse();
        // Luca joins: Sara is told, and the event's chat is his too
        var joined = server.json("PUT", "/v1/events/" + id + "/followers/me", luca.token(), "");
        assertThat(joined.body().get("following").booleanValue()).isTrue();
        assertThat(joined.body().get("followerCount").intValue()).isEqualTo(1);
        JsonNode notes = server.get("/v1/me/notifications", sara.token()).body();
        assertThat(notes.get("unread").intValue()).isEqualTo(1);
        assertThat(notes.get("items").get(0).get("kind").stringValue()).isEqualTo("event.joined");
        assertThat(notes.get("items").get(0).get("actors").get(0).get("id").stringValue()).isEqualTo(luca.id());
        assertThat(server.json("POST", "/v1/me/notifications/read", sara.token(), "").body().get("unread").intValue()).isZero();
        String chat = "event:" + id;
        assertThat(server.get("/v1/chats", luca.token()).body().get("items").findValuesAsString("id")).contains(chat);
        var said = server.json("POST", "/v1/chats/" + chat + "/messages", luca.token(), "{\"text\":\"  ci sono!  \",\"clientId\":\"c1\"}");
        assertThat(said.status()).as(said.raw().body()).isEqualTo(201);
        assertThat(said.body().get("text").stringValue()).isEqualTo("ci sono!");
        JsonNode inbox = server.get("/v1/chats", sara.token()).body().get("items");
        JsonNode mine = null;
        for (JsonNode item : inbox) if (item.get("id").stringValue().equals(chat)) mine = item;
        assertThat(mine).isNotNull();
        assertThat(mine.get("unread").intValue()).isEqualTo(1);
        assertThat(mine.get("role").stringValue()).isEqualTo("owner");
        assertThat(mine.get("kind").stringValue()).isEqualTo("event");
        // Saved by Luca too; then cancelled before it began: it can leave the Saved list
        assertThat(server.json("PUT", "/v1/events/" + id + "/saved/me", luca.token(), "").body().get("saved").booleanValue()).isTrue();
        var cancelled = server.send(HttpRequest.newBuilder(server.uri("/v1/events/" + id)).header("Authorization", "Bearer " + sara.token()).DELETE());
        assertThat(cancelled.body().get("status").stringValue()).isEqualTo("cancelled");
        assertThat(server.get("/v1/chats", luca.token()).body().get("items").findValuesAsString("id")).doesNotContain(chat);
        assertThat(server.json("PUT", "/v1/events/" + id + "/followers/me", luca.token(), "").status()).isEqualTo(410);
        assertThat(server.get("/v1/me/events", luca.token()).body().get("followed").findValuesAsString("id")).contains(id);
        assertThat(server.json("DELETE", "/v1/events/" + id + "/saved/me", luca.token(), "").status()).isEqualTo(200);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/me/saved/cancelled")).header("Authorization", "Bearer " + luca.token())
                .DELETE()).status()).isEqualTo(204);
        assertThat(server.get("/v1/me/events", luca.token()).body().get("followed").findValuesAsString("id")).doesNotContain(id);
    }

    @Test
    void theRulesOfEventsHold() {
        User anna = user("ev-anna");
        var invalid = server.json("POST", "/v1/events", anna.token(),
                "{\"title\":\"\",\"categories\":[\"nope\"],\"location\":{\"latitude\":91,\"longitude\":0},\"dates\":{\"startDate\":\"x\"}}");
        assertThat(invalid.status()).isEqualTo(400);
        assertThat(invalid.body().get("details").size()).isGreaterThanOrEqualTo(4);
        assertThat(server.json("POST", "/v1/events", anna.token(), event(place(), inHours(24 * 40), inHours(24 * 40 + 1), "")).status())
                .isEqualTo(400);
        assertThat(server.json("POST", "/v1/events", anna.token(), event(place(), inHours(1), inHours(2), ",\"theme\":{\"beamStyle\":\"laser\"}"))
                .status()).isEqualTo(400);
        for (int i = 0; i < 5; i++) create(anna, place(), inHours(1), inHours(2));
        assertThat(server.json("POST", "/v1/events", anna.token(), event(place(), inHours(1), inHours(2), "")).body().get("code").stringValue())
                .isEqualTo("too_many_events");
        assertThat(server.get("/v1/events?latitude=abc&longitude=1", anna.token()).status()).isEqualTo(400);
        assertThat(server.get("/v1/events?latitude=41.9&longitude=12.5&categories=nope", anna.token()).status()).isEqualTo(400);
        assertThat(server.get("/v1/events/ev_nothing", anna.token()).status()).isEqualTo(404);
    }

    @Test
    void ratingsComeFromWhoJoinedOnceItStarted() {
        User host = user("rt-host"), guest = user("rt-guest");
        JsonNode event = create(host, place(), Instant.now().minus(2, ChronoUnit.MINUTES), inHours(1));
        String id = event.get("id").stringValue();
        assertThat(event.get("status").stringValue()).isEqualTo("ongoing");
        assertThat(server.json("POST", "/v1/events/" + id + "/ratings", guest.token(), "{\"rating\":8}").status()).isEqualTo(403);
        server.json("PUT", "/v1/events/" + id + "/followers/me", guest.token(), "");
        var rated = server.json("POST", "/v1/events/" + id + "/ratings", guest.token(), "{\"rating\":8.5,\"comment\":\"bello\"}");
        assertThat(rated.status()).as(rated.raw().body()).isEqualTo(201);
        assertThat(rated.body().get("rating").doubleValue()).isEqualTo(8.5);
        assertThat(server.json("POST", "/v1/events/" + id + "/ratings", guest.token(), "{\"rating\":8}").status()).isEqualTo(409);
        assertThat(server.json("POST", "/v1/events/" + id + "/ratings", host.token(), "{\"rating\":10}").status()).isEqualTo(403);
        assertThat(server.json("POST", "/v1/events/" + id + "/ratings", guest.token(), "{\"rating\":\"8\"}").status()).isIn(400, 409);
        JsonNode page = server.get("/v1/events/" + id, host.token()).body();
        assertThat(page.get("ratingCount").intValue()).isEqualTo(1);
        assertThat(page.get("ratingAverage").doubleValue()).isEqualTo(8.5);
        // A stranger who keeps their story to their connections is not named to others
        assertThat(page.get("ratings").get(0).get("user").get("id").stringValue()).isEqualTo(guest.id());
        User other = user("rt-other");
        assertThat(server.get("/v1/events/" + id, other.token()).body().get("ratings").get(0).get("user").isNull()).isTrue();
        assertThat(server.get("/v1/events/" + id, other.token()).body().get("followers")).isEmpty();
        var changed = server.json("PUT", "/v1/events/" + id + "/ratings/me", guest.token(), "{\"rating\":6}");
        assertThat(changed.body().get("rating").doubleValue()).isEqualTo(6);
        assertThat(server.get("/v1/events/" + id, host.token()).body().get("ratingAverage").doubleValue()).isEqualTo(6);
    }

    @Test
    void aBlockHidesTheEventsOfEachFromTheOther() {
        User host = user("bl-host"), blocked = user("bl-blocked");
        String id = create(host, place(), inHours(1), inHours(2)).get("id").stringValue();
        server.context.getBean(Database.class).txRun(ctx -> ctx.insertInto(BLOCKS).set(BLOCKS.BLOCKER, host.uuid())
                .set(BLOCKS.BLOCKED, blocked.uuid()).set(BLOCKS.SINCE, Instant.now()).execute());
        assertThat(server.get("/v1/events/" + id, blocked.token()).status()).isEqualTo(404);
        assertThat(server.json("PUT", "/v1/events/" + id + "/followers/me", blocked.token(), "").status()).isEqualTo(404);
    }

    @Test
    void directChatsAreBetweenConnectionsAndSendingTwiceGivesOneMessage() {
        User a = user("dc-a"), b = user("dc-b"), stranger = user("dc-stranger");
        assertThat(server.json("POST", "/v1/chats/direct", a.token(), "{\"userId\":\"" + stranger.id() + "\"}").status()).isEqualTo(403);
        connect(a, b);
        var opened = server.json("POST", "/v1/chats/direct", a.token(), "{\"userId\":\"" + b.id() + "\"}");
        assertThat(opened.status()).as(opened.raw().body()).isEqualTo(201);
        String chat = opened.body().get("id").stringValue();
        assertThat(chat).startsWith("chat_");
        assertThat(opened.body().get("with").get("id").stringValue()).isEqualTo(b.id());
        assertThat(opened.body().get("canWrite").booleanValue()).isTrue();
        // Not in the other's inbox until someone writes
        assertThat(server.get("/v1/chats", b.token()).body().get("items").findValuesAsString("id")).doesNotContain(chat);
        var again = server.json("POST", "/v1/chats/direct", a.token(), "{\"userId\":\"" + b.id() + "\"}");
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.body().get("id").stringValue()).isEqualTo(chat);
        String first = server.json("POST", "/v1/chats/" + chat + "/messages", a.token(), "{\"text\":\"ciao\",\"clientId\":\"x1\"}")
                .body().get("id").stringValue();
        String twice = server.json("POST", "/v1/chats/" + chat + "/messages", a.token(), "{\"text\":\"ciao\",\"clientId\":\"x1\"}")
                .body().get("id").stringValue();
        assertThat(twice).isEqualTo(first);
        for (int i = 0; i < 4; i++) server.json("POST", "/v1/chats/" + chat + "/messages", a.token(), "{\"text\":\"m" + i + "\"}");
        JsonNode inbox = server.get("/v1/chats", b.token()).body().get("items");
        assertThat(inbox.findValuesAsString("id")).contains(chat);
        assertThat(inbox.get(0).get("unread").intValue()).isEqualTo(5);
        assertThat(inbox.get(0).get("lastMessage").get("text").stringValue()).isEqualTo("m3");
        // Pages: the newest two, then the older ones with the cursor, then after
        JsonNode newest = server.get("/v1/chats/" + chat + "/messages?limit=2", b.token()).body();
        assertThat(newest.get("items").findValuesAsString("text")).containsExactly("m2", "m3");
        String cursor = newest.get("nextCursor").stringValue();
        JsonNode older = server.get("/v1/chats/" + chat + "/messages?limit=10&before=" + cursor, b.token()).body();
        assertThat(older.get("items").findValuesAsString("text")).containsExactly("ciao", "m0", "m1");
        assertThat(older.get("nextCursor").isNull()).isTrue();
        JsonNode after = server.get("/v1/chats/" + chat + "/messages?after=" + first, b.token()).body();
        assertThat(after.get("items").findValuesAsString("text")).containsExactly("m0", "m1", "m2", "m3");
        // An id the phone kept and that is gone: the most recent page
        assertThat(server.get("/v1/chats/" + chat + "/messages?before=msg_AAAAAAAAAAAAAAAAAAAAAA", b.token()).body().get("items").size())
                .isEqualTo(5);
        String last = newest.get("items").get(1).get("id").stringValue();
        assertThat(server.json("POST", "/v1/chats/" + chat + "/read", b.token(), "{\"messageId\":\"" + last + "\"}").status()).isEqualTo(204);
        assertThat(server.get("/v1/chats", b.token()).body().get("items").get(0).get("unread").intValue()).isZero();
        assertThat(server.json("POST", "/v1/chats/" + chat + "/messages", a.token(), "{\"text\":\"" + "x".repeat(1001) + "\"}").status())
                .isEqualTo(400);
        assertThat(server.get("/v1/chats/" + chat, stranger.token()).status()).isEqualTo(404);
    }

    @Test
    void aGroupIsRunByItsOwnerAndPassesOnWhenTheyLeave() {
        User owner = user("gr-owner"), friend = user("gr-friend"), late = user("gr-late");
        connect(owner, friend);
        connect(owner, late);
        var made = server.json("POST", "/v1/chats", owner.token(),
                "{\"title\":\"Calcetto\",\"color\":\"#2F7BFF\",\"memberIds\":[\"" + friend.id() + "\"]}");
        assertThat(made.status()).as(made.raw().body()).isEqualTo(201);
        String chat = made.body().get("id").stringValue();
        assertThat(made.body().get("members").size()).isEqualTo(2);
        assertThat(made.body().get("lastMessage").get("text").stringValue()).isEqualTo("Created “Calcetto”");
        server.json("POST", "/v1/chats/" + chat + "/messages", friend.token(), "{\"text\":\"prima che entri\"}");
        var added = server.json("POST", "/v1/chats/" + chat + "/members", owner.token(), "{\"userIds\":[\"" + late.id() + "\"]}");
        assertThat(added.status()).as(added.raw().body()).isEqualTo(200);
        // The one who joined sees from the message that added them, not what was said before
        JsonNode seen = server.get("/v1/chats/" + chat + "/messages", late.token()).body();
        assertThat(seen.get("items").findValuesAsString("text")).noneMatch(text -> text.equals("prima che entri"));
        assertThat(seen.get("items").get(0).get("text").stringValue()).contains("added");
        // A poll by the owner; a vote; closed
        var poll = server.json("POST", "/v1/chats/" + chat + "/polls", owner.token(), "{\"question\":\"Quando?\",\"options\":[\"Lunedì\",\"Martedì\"]}");
        assertThat(poll.status()).as(poll.raw().body()).isEqualTo(201);
        String pollId = poll.body().get("id").stringValue();
        var voted = server.json("POST", "/v1/chats/" + chat + "/polls/" + pollId + "/votes", friend.token(), "{\"optionIds\":[\"o2\"]}");
        assertThat(voted.body().get("poll").get("mine").get(0).stringValue()).isEqualTo("o2");
        assertThat(voted.body().get("poll").get("options").get(1).get("votes").intValue()).isEqualTo(1);
        assertThat(server.json("POST", "/v1/chats/" + chat + "/polls", friend.token(), "{\"question\":\"x\",\"options\":[\"a\",\"b\"]}").status())
                .isEqualTo(403);
        server.json("POST", "/v1/chats/" + chat + "/polls/" + pollId + "/close", owner.token(), "");
        assertThat(server.json("POST", "/v1/chats/" + chat + "/polls/" + pollId + "/votes", late.token(), "{\"optionIds\":[\"o1\"]}")
                .body().get("code").stringValue()).isEqualTo("closed");
        // Pinned, muted, made admin
        assertThat(server.json("PUT", "/v1/chats/" + chat + "/pins/" + pollId, owner.token(), "").body().get("pinned").size()).isEqualTo(1);
        server.json("PUT", "/v1/chats/" + chat + "/members/" + late.id() + "/mute", owner.token(), "{\"minutes\":60}");
        var muted = server.json("POST", "/v1/chats/" + chat + "/messages", late.token(), "{\"text\":\"posso?\"}");
        assertThat(muted.status()).isEqualTo(403);
        server.json("PUT", "/v1/chats/" + chat + "/members/" + friend.id() + "/role", owner.token(), "{\"role\":\"admin\"}");
        assertThat(server.json("PUT", "/v1/chats/" + chat + "/members/" + owner.id() + "/mute", friend.token(), "{\"minutes\":60}").status())
                .isEqualTo(403);
        // The owner leaves: the admin runs it now
        var left = server.send(HttpRequest.newBuilder(server.uri("/v1/chats/" + chat + "/members/me")).header("Authorization", "Bearer " + owner.token())
                .DELETE());
        assertThat(left.status()).isEqualTo(204);
        JsonNode now = server.get("/v1/chats/" + chat, friend.token()).body();
        assertThat(now.get("ownerId").stringValue()).isEqualTo(friend.id());
        assertThat(now.get("role").stringValue()).isEqualTo("owner");
        assertThat(server.get("/v1/chats/" + chat, owner.token()).status()).isEqualTo(404);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/chats/" + chat)).header("Authorization", "Bearer " + friend.token())
                .DELETE()).status()).isEqualTo(204);
        assertThat(server.get("/v1/chats/" + chat, late.token()).status()).isEqualTo(404);
    }
}
