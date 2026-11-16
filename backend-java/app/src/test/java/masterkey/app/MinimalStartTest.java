// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpRequest;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import masterkey.core.Json;
import org.eclipse.jetty.websocket.api.Callback;
import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.client.WebSocketClient;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * The minimal start of JAVA-BACKEND.md §13 against the whole server: the app can open on it.
 * Real HTTP, real tokens signed by a stand-in for Logto, a real PostGIS.
 */
class MinimalStartTest {

    static final TestServer server = new TestServer();

    @AfterAll
    static void stop() {
        server.close();
    }

    @Test
    void healthNeedsNoSignIn() {
        var answer = server.send(HttpRequest.newBuilder(server.uri("/v1/health")).GET());
        assertThat(answer.status()).isEqualTo(200);
        assertThat(answer.body().get("ok").booleanValue()).isTrue();
    }

    @Test
    void withoutATokenEveryRouteIs401AsJson() {
        var answer = server.send(HttpRequest.newBuilder(server.uri("/v1/me")).GET());
        assertThat(answer.status()).isEqualTo(401);
        assertThat(answer.body().get("code").stringValue()).isEqualTo("unauthorized");
        var forged = server.get("/v1/me", "a.b.c");
        assertThat(forged.status()).isEqualTo(401);
    }

    @Test
    void theFirstGetMeMakesTheAccountNamedByTheIdToken() {
        String token = server.token("sub-sara");
        var me = server.send(HttpRequest.newBuilder(server.uri("/v1/me")).header("Authorization", "Bearer " + token)
                .header("X-Id-Token", server.idToken("sub-sara", "Sara Moretti", "Sara_M", "sara@example.com")).GET());
        assertThat(me.status()).isEqualTo(200);
        assertThat(me.body().get("id").stringValue()).startsWith("usr_");
        assertThat(me.body().get("username").stringValue()).isEqualTo("sara_m");
        assertThat(me.body().get("name").stringValue()).isEqualTo("Sara Moretti");
        assertThat(me.body().get("email").stringValue()).isEqualTo("sara@example.com");
        assertThat(me.body().get("storyAudience").stringValue()).isEqualTo("connections");
        assertThat(me.body().get("style").get("backdrop").stringValue()).isEqualTo("ocean");
        assertThat(me.body().get("backdrop").stringValue()).isEqualTo("ocean");
        assertThat(me.body().get("stats").get("organized").intValue()).isZero();
        assertThat(me.body().get("createdAt").stringValue()).matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z");
        assertThat(me.body().get("pictureUrl").isNull()).isTrue();
        // The same again: the same account, and a 304 with its ETag
        String tag = me.header("ETag");
        assertThat(tag).startsWith("W/\"");
        assertThat(me.header("Cache-Control")).isEqualTo("private, no-cache");
        var again = server.send(HttpRequest.newBuilder(server.uri("/v1/me")).header("Authorization", "Bearer " + token)
                .header("If-None-Match", tag).GET());
        assertThat(again.status()).isEqualTo(304);
        assertThat(again.raw().body()).isEmpty();
    }

    @Test
    void anAccountWithoutNamesGetsARandomHandle() {
        var me = server.get("/v1/me", server.token("sub-nameless"));
        assertThat(me.body().get("username").stringValue()).matches("user\\d{8}");
        assertThat(me.body().get("name").stringValue()).isEqualTo("New user");
        assertThat(me.body().get("email").isNull()).isTrue();
    }

    @Test
    void patchMeKeepsTheRulesOfProfiles() {
        String a = server.token("sub-patch-a"), b = server.token("sub-patch-b");
        server.get("/v1/me", a);
        String taken = server.get("/v1/me", b).body().get("username").stringValue();
        var renamed = server.json("PATCH", "/v1/me", a, "{\"name\":\"  Anna   Rossi \",\"username\":\"@Anna.R\",\"bio\":\"ciao\",\"style\":{\"backdrop\":\"night\"}}");
        assertThat(renamed.status()).isEqualTo(200);
        assertThat(renamed.body().get("name").stringValue()).isEqualTo("Anna Rossi");
        assertThat(renamed.body().get("username").stringValue()).isEqualTo("anna.r");
        assertThat(renamed.body().get("style").get("backdrop").stringValue()).isEqualTo("night");
        assertThat(renamed.body().get("style").get("pedestal").stringValue()).isEqualTo("disc");
        assertThat(server.json("PATCH", "/v1/me", a, "{\"username\":\"" + taken + "\"}").body().get("code").stringValue())
                .isEqualTo("username_taken");
        assertThat(server.json("PATCH", "/v1/me", a, "{\"username\":\"admin\"}").body().get("code").stringValue())
                .isEqualTo("username_taken");
        var invalid = server.json("PATCH", "/v1/me", a, "{\"name\":\"\",\"username\":\"a..b\",\"style\":{\"backdrop\":\"pink\"},\"storyAudience\":\"friends\"}");
        assertThat(invalid.status()).isEqualTo(400);
        assertThat(invalid.body().get("details")).hasSize(4);
        assertThat(server.json("PATCH", "/v1/me", a, "{\"name\":42}").status()).isEqualTo(400);
        assertThat(server.json("PATCH", "/v1/me", a, "{}").status()).isEqualTo(400);
        assertThat(server.json("PATCH", "/v1/me", a, "not json").status()).isEqualTo(400);
        assertThat(server.json("PATCH", "/v1/me", a, "{\"storyAudience\":\"everyone\"}").body().get("storyAudience").stringValue())
                .isEqualTo("everyone");
    }

    @Test
    void anOldAppIsAskedToUpdate() {
        var old = server.send(HttpRequest.newBuilder(server.uri("/v1/me")).header("X-Client", "0.9.0 (ios)").GET());
        assertThat(old.status()).isEqualTo(426);
        assertThat(old.body().get("code").stringValue()).isEqualTo("upgrade_required");
    }

    @Test
    void aBodyOver256KilobytesIs413() {
        String token = server.token("sub-big");
        var answer = server.json("PATCH", "/v1/me", token, "{\"bio\":\"" + "a".repeat(300_000) + "\"}");
        assertThat(answer.status()).isEqualTo(413);
        assertThat(answer.body().get("code").stringValue()).isEqualTo("too_large");
    }

    @Test
    void unknownRoutesAndJettyErrorsAreJson() {
        var missing = server.get("/v1/nothing-here", server.token("sub-404"));
        assertThat(missing.status()).isEqualTo(404);
        assertThat(missing.body().get("code").stringValue()).isEqualTo("not_found");
        var method = server.send(HttpRequest.newBuilder(server.uri("/v1/me/wallet")).header("Authorization", "Bearer " + server.token("sub-405"))
                .DELETE());
        assertThat(method.status()).isEqualTo(405);
        assertThat(method.body().get("code").stringValue()).isNotEmpty();
        var bad = server.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.port + "/v1/%2e%2e/%00")).GET());
        assertThat(bad.status()).isEqualTo(400);
        assertThat(bad.body().get("code").stringValue()).isEqualTo("bad_request");
    }

    /** Public, or Jetty cannot call it (§5). */
    public static final class Phone extends Session.Listener.AbstractAutoDemanding {
        final BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();

        @Override
        public void onWebSocketText(String text) {
            frames.add(Json.parse(text));
        }
    }

    @Test
    void theSocketIsOnTheSamePortAndKnowsTheSameAccount() throws Exception {
        String token = server.token("sub-socket");
        String id = server.get("/v1/me", token).body().get("id").stringValue();
        WebSocketClient client = new WebSocketClient();
        client.start();
        try {
            Phone phone = new Phone();
            BlockingQueue<JsonNode> frames = phone.frames;
            CompletableFuture<Session> opened = client.connect(phone, URI.create("ws://127.0.0.1:" + server.port + "/v1/ws"));
            Session session = opened.get(5, TimeUnit.SECONDS);
            session.sendText("{\"type\":\"auth\",\"token\":\"" + token + "\"}", Callback.NOOP);
            JsonNode ready = frames.poll(5, TimeUnit.SECONDS);
            assertThat(ready).isNotNull();
            assertThat(ready.get("type").stringValue()).isEqualTo("ready");
            assertThat(ready.get("userId").stringValue()).isEqualTo(id);
            session.sendText("{\"type\":\"presence\",\"mode\":\"visible\",\"position\":{\"latitude\":41.9,\"longitude\":12.5}}", Callback.NOOP);
            JsonNode snapshot = frames.poll(5, TimeUnit.SECONDS);
            assertThat(snapshot).isNotNull();
            assertThat(snapshot.get("type").stringValue()).isEqualTo("presence.snapshot");
            session.close();
        } finally {
            client.stop();
        }
    }
}
