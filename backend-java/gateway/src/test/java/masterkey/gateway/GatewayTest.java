// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import masterkey.bus.Bus;
import masterkey.bus.LocalBus;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.presence.Directory;
import masterkey.presence.PresenceClock;
import masterkey.presence.PresenceConfig;
import masterkey.presence.PresenceService;
import org.eclipse.jetty.server.Handler;
import org.eclipse.jetty.server.Request;
import org.eclipse.jetty.server.Response;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.util.Callback;
import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.client.WebSocketClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** A real Jetty with the gateway in front, real sockets from a WebSocket client. */
class GatewayTest {

    static final byte[] KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    Server server;
    WebSocketClient client;
    Gateway gateway;
    PresenceService presence;
    Sockets sockets;
    LocalBus bus;
    URI uri;

    /** "good:<uuid>" is that user for an hour; "soon:<uuid>" for one second; anything else is refused. */
    static final Authenticator TOKENS = token -> {
        if (token.startsWith("good:")) return new Authenticator.Identity(UUID.fromString(token.substring(5)), Instant.now().plusSeconds(3600));
        if (token.startsWith("soon:")) return new Authenticator.Identity(UUID.fromString(token.substring(5)), Instant.now().plusMillis(1200));
        if (token.equals("boom")) throw new IllegalStateException("database down");
        throw ApiError.unauthorized("invalid token");
    };

    static final Directory DIRECTORY = new Directory() {
        @Override
        public CompletableFuture<Relations> relations(UUID user) {
            return CompletableFuture.completedFuture(new Relations(Set.of(), Set.of()));
        }

        @Override
        public CompletableFuture<Summary> summary(UUID user) {
            return CompletableFuture.completedFuture(new Summary("{\"id\":\"" + Ids.publicId("usr", user) + "\"}", 1));
        }

        @Override
        public void connectInvited(UUID target, UUID actor) {
        }
    };

    @BeforeEach
    void start() throws Exception {
        bus = new LocalBus();
        sockets = new Sockets(2);
        presence = new PresenceService(PresenceConfig.of(KEY, 340), DIRECTORY, sockets, PresenceClock.system(), () -> { });
        presence.start();
        gateway = new Gateway(GatewayConfig.defaults(1).withAuthTimeout(Duration.ofMillis(400)).withDrain(Duration.ZERO),
                sockets, presence, TOKENS, bus, InstantSource.system());
        server = new Server();
        ServerConnector connector = new ServerConnector(server);
        connector.setPort(0);
        server.addConnector(connector);
        Handler rest = new Handler.Abstract() {
            @Override
            public boolean handle(Request request, Response response, Callback callback) {
                Response.writeError(request, response, callback, 404);
                return true;
            }
        };
        server.setHandler(gateway.wrap(server, rest));
        server.start();
        uri = URI.create("ws://127.0.0.1:" + connector.getLocalPort() + Gateway.PATH);
        client = new WebSocketClient();
        client.setMaxTextMessageSize(1 << 20);
        client.start();
    }

    @AfterEach
    void stop() throws Exception {
        client.stop();
        gateway.close();
        server.stop();
        presence.close();
        sockets.close();
    }

    /** What the test's phone gets. */
    public static final class Phone extends Session.Listener.AbstractAutoDemanding {
        final BlockingQueue<JsonNode> frames = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();

        @Override
        public void onWebSocketText(String text) {
            frames.add(Json.parse(text));
        }

        @Override
        public void onWebSocketClose(int statusCode, String reason, org.eclipse.jetty.websocket.api.Callback callback) {
            closed.complete(statusCode);
            callback.succeed();
        }

        void send(String text) {
            getSession().sendText(text, org.eclipse.jetty.websocket.api.Callback.NOOP);
        }

        JsonNode next(String type) throws InterruptedException {
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (System.nanoTime() < until) {
                JsonNode frame = frames.poll(100, TimeUnit.MILLISECONDS);
                if (frame != null && frame.get("type").stringValue().equals(type)) return frame;
            }
            throw new AssertionError("no " + type + " frame");
        }

        int closeCode() throws Exception {
            return closed.get(3, TimeUnit.SECONDS);
        }
    }

    Phone connect() throws Exception {
        Phone phone = new Phone();
        client.connect(phone, uri).get(3, TimeUnit.SECONDS);
        return phone;
    }

    Phone signedIn(UUID user) throws Exception {
        Phone phone = connect();
        phone.send("{\"type\":\"auth\",\"token\":\"good:" + user + "\"}");
        JsonNode ready = phone.next("ready");
        assertThat(ready.get("userId").stringValue()).isEqualTo(Ids.publicId("usr", user));
        return phone;
    }

    @Test
    void authThenPresenceGivesASnapshotAndTheOthersADelta() throws Exception {
        UUID a = Ids.random(), b = Ids.random();
        Phone pa = signedIn(a), pb = signedIn(b);
        pa.send("{\"type\":\"presence\",\"mode\":\"visible\",\"position\":{\"latitude\":41.9,\"longitude\":12.5}}");
        assertThat(pa.next("presence.snapshot").get("people")).isEmpty();
        pb.send("{\"type\":\"presence\",\"mode\":\"visible\",\"position\":{\"latitude\":41.9001,\"longitude\":12.5,\"heading\":1e300,\"speed\":true}}");
        JsonNode snapshot = pb.next("presence.snapshot");
        assertThat(snapshot.get("people").get(0).get("userId").stringValue()).isEqualTo(Ids.publicId("usr", a));
        JsonNode delta = pa.next("presence.delta");
        JsonNode seen = delta.get("people").get(0);
        assertThat(seen.get("userId").stringValue()).isEqualTo(Ids.publicId("usr", b));
        // A heading of 10^300 and a speed of true reach nobody
        assertThat(seen.get("heading").isNull()).isTrue();
        assertThat(seen.get("speed").isNull()).isTrue();
    }

    @Test
    void withoutAuthTheSocketCloses4001() throws Exception {
        assertThat(connect().closeCode()).isEqualTo(4001);
    }

    @Test
    void aWrongFirstFrameOrTokenCloses4001() throws Exception {
        Phone first = connect();
        first.send("{\"type\":\"presence\"}");
        assertThat(first.closeCode()).isEqualTo(4001);
        Phone wrong = connect();
        wrong.send("{\"type\":\"auth\",\"token\":\"forged\"}");
        assertThat(wrong.closeCode()).isEqualTo(4001);
        Phone binary = connect();
        binary.getSession().sendBinary(ByteBuffer.wrap(new byte[] {1, 2}), org.eclipse.jetty.websocket.api.Callback.NOOP);
        assertThat(binary.closeCode()).isEqualTo(4001);
        // Not the token's fault: the app waits before trying again
        Phone down = connect();
        down.send("{\"type\":\"auth\",\"token\":\"boom\"}");
        assertThat(down.closeCode()).isEqualTo(1011);
    }

    @Test
    void theTokenRunningOutCloses4001() throws Exception {
        Phone phone = connect();
        phone.send("{\"type\":\"auth\",\"token\":\"soon:" + Ids.random() + "\"}");
        phone.next("ready");
        assertThat(phone.closeCode()).isEqualTo(4001);
    }

    @Test
    void pingAnswersPongAndBadFramesAnError() throws Exception {
        Phone phone = signedIn(Ids.random());
        phone.send("{\"type\":\"ping\"}");
        phone.next("pong");
        phone.send("not json");
        JsonNode error = phone.next("error");
        assertThat(error.get("code").stringValue()).isEqualTo("bad_request");
        phone.send("{\"type\":\"presence\",\"mode\":\"sideways\",\"ref\":\"r1\"}");
        JsonNode mode = phone.next("error");
        assertThat(mode.get("ref").stringValue()).isEqualTo("r1");
        assertThat(mode.get("message").stringValue()).isEqualTo("unknown mode");
        phone.send("{\"type\":\"presence\",\"mode\":\"visible\",\"position\":{\"latitude\":91,\"longitude\":0}}");
        assertThat(phone.next("error").get("message").stringValue()).isEqualTo("position out of range");
        phone.send("{\"type\":\"gesture\",\"to\":\"nobody\",\"gesture\":\"wave\",\"ref\":7}");
        JsonNode gesture = phone.next("error");
        assertThat(gesture.get("code").stringValue()).isEqualTo("not_found");
        assertThat(gesture.get("ref").intValue()).isEqualTo(7);
        phone.getSession().sendBinary(ByteBuffer.wrap(new byte[] {1}), org.eclipse.jetty.websocket.api.Callback.NOOP);
        assertThat(phone.next("error").get("message").stringValue()).isEqualTo("invalid frame");
    }

    @Test
    void floodingClosesWith1008() throws Exception {
        Phone phone = signedIn(Ids.random());
        for (int i = 0; i < 60; i++) phone.send("{\"type\":\"ping\"}");
        assertThat(phone.closeCode()).isEqualTo(1008);
    }

    @Test
    void aFrameOver64KilobytesCloses1009() throws Exception {
        Phone phone = signedIn(Ids.random());
        phone.send("{\"type\":\"broadcast\",\"text\":\"" + "a".repeat(70_000) + "\"}");
        assertThat(phone.closeCode()).isEqualTo(1009);
    }

    @Test
    void framesFromTheBusReachEverySocketOfTheUser() throws Exception {
        UUID user = Ids.random();
        Phone first = signedIn(user), second = signedIn(user);
        Thread.sleep(100);
        bus.publish(Bus.user(user), "{\"type\":\"chat.removed\",\"chatId\":\"chat_x\"}".getBytes(StandardCharsets.UTF_8));
        assertThat(first.next("chat.removed").get("chatId").stringValue()).isEqualTo("chat_x");
        assertThat(second.next("chat.removed").get("chatId").stringValue()).isEqualTo("chat_x");
        bus.publish(Bus.user(Ids.random()), "{\"type\":\"chat.removed\"}".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void theSixthSocketOfAUserClosesTheOldest() throws Exception {
        UUID user = Ids.random();
        Phone oldest = signedIn(user);
        for (int i = 0; i < 5; i++) signedIn(user);
        assertThat(oldest.closeCode()).isEqualTo(1008);
    }

    @Test
    void otherPathsGoToTheRestOfTheServer() throws Exception {
        java.net.http.HttpClient http = java.net.http.HttpClient.newHttpClient();
        var answer = http.send(java.net.http.HttpRequest.newBuilder(URI.create(uri.toString().replace("ws://", "http://").replace(Gateway.PATH, "/v1/me"))).build(),
                java.net.http.HttpResponse.BodyHandlers.discarding());
        assertThat(answer.statusCode()).isEqualTo(404);
    }
}
