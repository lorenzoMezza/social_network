// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpRequest;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** People and social routes against the whole server (routes/people.py, routes/social.py). */
class PeopleTest {

    static final TestServer server = new TestServer();

    @AfterAll
    static void stop() {
        server.close();
    }

    record User(String token, String id) {
    }

    static User user(String sub) {
        String token = server.token(sub);
        return new User(token, server.get("/v1/me", token).body().get("id").stringValue());
    }

    static int delete(String path, String token) {
        return server.send(HttpRequest.newBuilder(server.uri(path)).header("Authorization", "Bearer " + token).DELETE()).status();
    }

    /** The QR way: the host shows a code, the guest scans it. */
    static void connectInPerson(User host, User guest) {
        JsonNode session = server.json("POST", "/v1/connections/sessions", host.token(), "{}").body();
        String token = session.get("token").stringValue();
        assertThat(token).matches("[A-Za-z0-9_-]{22,128}");
        var claimed = server.json("POST", "/v1/connections/claims", guest.token(), "{\"token\":\"" + token + "\"}");
        assertThat(claimed.status()).as(claimed.raw().body()).isEqualTo(200);
        assertThat(claimed.body().get("user").get("id").stringValue()).isEqualTo(host.id());
        assertThat(server.get("/v1/connections/sessions/" + session.get("sessionId").stringValue(), host.token()).body()
                .get("status").stringValue()).isEqualTo("connected");
    }

    @Test
    void connectingInPersonWithACodeThatLastsTenSeconds() {
        User host = user("cn-host"), guest = user("cn-guest");
        JsonNode session = server.json("POST", "/v1/connections/sessions", host.token(), "{}").body();
        String token = session.get("token").stringValue();
        assertThat(server.json("POST", "/v1/connections/claims", host.token(), "{\"token\":\"" + token + "\"}").body().get("code").stringValue())
                .isEqualTo("self");
        // A code is used once: taken whatever happened
        assertThat(server.json("POST", "/v1/connections/claims", guest.token(), "{\"token\":\"" + token + "\"}").status()).isEqualTo(410);
        String fresh = server.json("POST", "/v1/connections/sessions/" + session.get("sessionId").stringValue() + "/token", host.token(), "{}")
                .body().get("token").stringValue();
        // Both say where they are, 5 km apart: they are not together
        long now = Instant.now().toEpochMilli();
        assertThat(server.json("POST", "/v1/connections/claims", guest.token(), "{\"token\":\"" + fresh
                + "\",\"location\":{\"latitude\":45.0,\"longitude\":9.0,\"timestamp\":" + now + ",\"mocked\":true}}").body().get("code").stringValue())
                .isEqualTo("too_far");
        connectInPerson(host, guest);
        assertThat(server.get("/v1/me/connections", host.token()).body().get("items").get(0).get("user").get("id").stringValue()).isEqualTo(guest.id());
        JsonNode again = server.json("POST", "/v1/connections/sessions", host.token(), "{}").body();
        assertThat(server.json("POST", "/v1/connections/claims", guest.token(), "{\"token\":\"" + again.get("token").stringValue() + "\"}")
                .body().get("code").stringValue()).isEqualTo("already");
        assertThat(server.get("/v1/me", host.token()).body().get("stats").get("connections").intValue()).isEqualTo(1);
        JsonNode profile = server.get("/v1/users/" + guest.id(), host.token()).body();
        assertThat(profile.get("relation").get("connected").booleanValue()).isTrue();
        assertThat(profile.get("relation").get("canMessage").booleanValue()).isTrue();
        assertThat(profile.get("relation").get("seesStory").booleanValue()).isTrue();
        // Disconnected: no messages until they connect in person again
        assertThat(delete("/v1/me/connections/" + guest.id(), host.token())).isEqualTo(204);
        assertThat(server.get("/v1/users/" + guest.id(), host.token()).body().get("relation").get("canMessage").booleanValue()).isFalse();
        assertThat(delete("/v1/me/connections/" + guest.id(), host.token())).isEqualTo(404);
    }

    @Test
    void aBlockEndsEverythingBetweenTheTwo() {
        User a = user("bk-a"), b = user("bk-b");
        connectInPerson(a, b);
        String group = server.json("POST", "/v1/chats", a.token(), "{\"title\":\"Amici\",\"memberIds\":[\"" + b.id() + "\"]}").body().get("id").stringValue();
        String direct = server.json("POST", "/v1/chats/direct", b.token(), "{\"userId\":\"" + a.id() + "\"}").body().get("id").stringValue();
        JsonNode event = server.json("POST", "/v1/events", a.token(), "{\"title\":\"Festa\",\"description\":\"Da me\",\"categories\":[\"party\"],"
                + "\"location\":{\"latitude\":41.7,\"longitude\":12.3},\"dates\":{\"startDate\":\"" + Instant.now().plus(1, ChronoUnit.HOURS)
                + "\",\"endDate\":\"" + Instant.now().plus(2, ChronoUnit.HOURS) + "\"}}").body();
        String eventId = event.get("id").stringValue();
        server.json("PUT", "/v1/events/" + eventId + "/followers/me", b.token(), "");
        assertThat(server.json("PUT", "/v1/me/blocks/" + b.id(), a.token(), "").status()).isEqualTo(204);
        assertThat(server.get("/v1/me/connections", a.token()).body().get("items")).isEmpty();
        assertThat(server.get("/v1/chats/" + group, b.token()).status()).isEqualTo(404);
        assertThat(server.get("/v1/chats/" + direct, a.token()).status()).isEqualTo(404);
        assertThat(server.get("/v1/chats", b.token()).body().get("items").findValuesAsString("id")).doesNotContain(group, direct, "event:" + eventId);
        assertThat(server.get("/v1/events/" + eventId, a.token()).body().get("followerCount").intValue()).isZero();
        // Who was blocked does not see the one who blocked; the one who blocked still sees them, to unblock
        assertThat(server.get("/v1/users/" + a.id(), b.token()).status()).isEqualTo(404);
        assertThat(server.get("/v1/users/" + b.id(), a.token()).body().get("relation").get("blocked").booleanValue()).isTrue();
        assertThat(server.get("/v1/me/blocks", a.token()).body().get("items").get(0).get("user").get("id").stringValue()).isEqualTo(b.id());
        assertThat(delete("/v1/me/blocks/" + b.id(), a.token())).isEqualTo(204);
        // Unblocking does not reconnect
        assertThat(server.get("/v1/users/" + b.id(), a.token()).body().get("relation").get("connected").booleanValue()).isFalse();
        assertThat(server.json("PUT", "/v1/me/blocks/" + a.id(), a.token(), "").status()).isEqualTo(404);
    }

    @Test
    void theStoryShowsWhatItsOwnerLetsOthersSee() {
        User owner = user("st-owner"), friend = user("st-friend"), stranger = user("st-stranger");
        connectInPerson(owner, friend);
        JsonNode event = server.json("POST", "/v1/events", owner.token(), "{\"title\":\"Mostra\",\"description\":\"Arte\",\"categories\":[\"exposition\"],"
                + "\"location\":{\"latitude\":41.65,\"longitude\":12.25},\"dates\":{\"startDate\":\"" + Instant.now().plus(1, ChronoUnit.HOURS)
                + "\",\"endDate\":\"" + Instant.now().plus(2, ChronoUnit.HOURS) + "\"}}").body();
        JsonNode story = server.get("/v1/users/" + owner.id() + "/activity", friend.token()).body();
        assertThat(story.get("items").findValuesAsString("kind")).contains("organized", "connected");
        // A stranger: the owner keeps the story to their connections
        assertThat(server.get("/v1/users/" + owner.id() + "/activity", stranger.token()).body().get("items")).isEmpty();
        assertThat(server.get("/v1/users/" + owner.id(), stranger.token()).body().get("stats").get("organized").isNull()).isTrue();
        assertThat(server.get("/v1/users/" + owner.id() + "/connections", stranger.token()).body().get("total").isNull()).isTrue();
        assertThat(server.get("/v1/users/" + owner.id() + "/events", friend.token()).body().get("items").get(0).get("event").get("id").stringValue())
                .isEqualTo(event.get("id").stringValue());
        // One moment hidden: gone for others, marked in one's own
        String moment = "o-" + event.get("id").stringValue();
        assertThat(server.json("PUT", "/v1/me/story/hidden/" + moment, owner.token(), "").status()).isEqualTo(204);
        assertThat(server.get("/v1/users/" + owner.id() + "/activity", friend.token()).body().get("items").findValuesAsString("id")).doesNotContain(moment);
        JsonNode own = server.get("/v1/users/" + owner.id() + "/activity", owner.token()).body();
        for (JsonNode item : own.get("items")) if (item.get("id").stringValue().equals(moment)) assertThat(item.get("hidden").booleanValue()).isTrue();
        assertThat(server.get("/v1/me", owner.token()).body().get("storyHidden").intValue()).isEqualTo(1);
        assertThat(server.json("PUT", "/v1/me/story/hidden/nonsense", owner.token(), "").status()).isEqualTo(400);
        assertThat(delete("/v1/me/story/hidden", owner.token())).isEqualTo(204);
        // Everyone may see it now
        server.json("PATCH", "/v1/me", owner.token(), "{\"storyAudience\":\"everyone\"}");
        assertThat(server.get("/v1/users/" + owner.id() + "/activity", stranger.token()).body().get("items").findValuesAsString("kind")).contains("organized");
        JsonNode theirs = server.get("/v1/users/" + owner.id() + "/connections", stranger.token()).body();
        assertThat(theirs.get("total").intValue()).isEqualTo(1);
        assertThat(theirs.get("mutual").intValue()).isZero();
    }

    @Test
    void reportsPushTokensAndConsents() {
        User reporter = user("rp-reporter"), reported = user("rp-reported");
        var report = server.json("POST", "/v1/reports", reporter.token(), "{\"kind\":\"user\",\"targetId\":\"" + reported.id() + "\",\"reasons\":[\"spam\"]}");
        assertThat(report.status()).as(report.raw().body()).isEqualTo(201);
        assertThat(report.body().get("id").stringValue()).startsWith("rep_");
        assertThat(server.json("POST", "/v1/reports", reporter.token(), "{\"kind\":\"user\",\"targetId\":\"" + reported.id() + "\",\"reasons\":[\"boring\"]}")
                .status()).isEqualTo(400);
        assertThat(server.json("POST", "/v1/reports", reporter.token(), "{\"kind\":\"event\",\"targetId\":\"ev_AAAAAAAAAAAAAAAAAAAAAA\",\"reasons\":[\"not an event\"]}")
                .status()).isEqualTo(404);
        assertThat(server.json("POST", "/v1/me/push-tokens", reporter.token(), "{\"token\":\"phone-1\",\"platform\":\"ios\"}").status()).isEqualTo(204);
        // The same phone signed in with another account: the token moves
        assertThat(server.json("POST", "/v1/me/push-tokens", reported.token(), "{\"token\":\"phone-1\",\"platform\":\"ios\"}").status()).isEqualTo(204);
        assertThat(server.json("POST", "/v1/me/push-tokens", reported.token(), "{\"token\":\"phone-1\",\"platform\":\"windows\"}").status()).isEqualTo(400);
        assertThat(delete("/v1/me/push-tokens/phone-1", reported.token())).isEqualTo(204);
        assertThat(server.json("PUT", "/v1/me/consents/location-sharing", reporter.token(), "{\"version\":2,\"mode\":\"approximate\"}").status()).isEqualTo(204);
        assertThat(server.json("PUT", "/v1/me/consents/marketing", reporter.token(), "{\"version\":2}").status()).isEqualTo(400);
    }
}
