// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs.push;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.InstantSource;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import masterkey.core.Json;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

/** APNs and FCM against fake servers: what goes out (provider token, headers, payload) and how each answer is read. */
class SendersTest {

    record Seen(String path, Map<String, List<String>> headers, String body) {
    }

    final List<Seen> seen = new CopyOnWriteArrayList<>();
    final AtomicReference<int[]> status = new AtomicReference<>(new int[] {200});
    final AtomicReference<String> answer = new AtomicReference<>("");
    HttpServer server;

    URI start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", (HttpExchange exchange) -> {
            seen.add(new Seen(exchange.getRequestURI().getPath(), Map.copyOf(exchange.getRequestHeaders()),
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            byte[] body = answer.get().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.get()[0], body.length == 0 ? -1 : body.length);
            if (body.length > 0) exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort());
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    static final PushSender.Message MESSAGE = new PushSender.Message("Gita", "3 new messages", Map.of("type", "chat", "chatId", "chat_x"), "chat-1");
    static final String DEVICE = "a".repeat(64);

    @Test
    void apnsSignsAsTheTeamAndReadsApplesAnswers(@TempDir Path dir) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        Path p8 = dir.resolve("AuthKey.p8");
        Files.writeString(p8, "-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder().encodeToString(pair.getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n");
        Apns apns = new Apns(start(), p8, "KEY123", "TEAM456", "app.masterkey", InstantSource.system());

        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.SENT);
        Seen request = seen.getFirst();
        assertThat(request.path()).isEqualTo("/3/device/" + DEVICE);
        assertThat(request.headers().get("Apns-topic")).containsExactly("app.masterkey");
        assertThat(request.headers().get("Apns-push-type")).containsExactly("alert");
        assertThat(request.headers().get("Apns-collapse-id")).containsExactly("chat-1");
        SignedJWT jwt = SignedJWT.parse(request.headers().get("Authorization").getFirst().substring("bearer ".length()));
        assertThat(jwt.getHeader().getAlgorithm()).isEqualTo(JWSAlgorithm.ES256);
        assertThat(jwt.getHeader().getKeyID()).isEqualTo("KEY123");
        assertThat(jwt.getJWTClaimsSet().getIssuer()).isEqualTo("TEAM456");
        assertThat(jwt.verify(new ECDSAVerifier((ECPublicKey) pair.getPublic()))).isTrue();
        JsonNode body = Json.parse(request.body());
        assertThat(body.get("aps").get("alert").get("title").stringValue()).isEqualTo("Gita");
        assertThat(body.get("aps").get("alert").get("body").stringValue()).isEqualTo("3 new messages");
        assertThat(body.get("chatId").stringValue()).isEqualTo("chat_x");

        status.set(new int[] {410});
        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.GONE);
        status.set(new int[] {400});
        answer.set("{\"reason\":\"BadDeviceToken\"}");
        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.GONE);
        answer.set("{\"reason\":\"PayloadTooLarge\"}");
        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.FAILED);
        status.set(new int[] {403});
        answer.set("{\"reason\":\"ExpiredProviderToken\"}");
        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.RETRY);
        status.set(new int[] {503});
        answer.set("");
        assertThat(apns.send(DEVICE, MESSAGE)).isEqualTo(PushSender.Result.RETRY);
        // Not a device token of APNs: never sent, and it goes
        int before = seen.size();
        assertThat(apns.send("not-a-token/../x", MESSAGE)).isEqualTo(PushSender.Result.GONE);
        assertThat(seen).hasSize(before);
    }

    @Test
    void fcmSendsTheV1MessageAndReadsGooglesAnswers() throws Exception {
        Fcm fcm = new Fcm(start().resolve("/v1/projects/test/messages:send"), () -> "oauth-token");
        assertThat(fcm.send("android-token-1", MESSAGE)).isEqualTo(PushSender.Result.SENT);
        Seen request = seen.getFirst();
        assertThat(request.path()).isEqualTo("/v1/projects/test/messages:send");
        assertThat(request.headers().get("Authorization")).containsExactly("Bearer oauth-token");
        JsonNode message = Json.parse(request.body()).get("message");
        assertThat(message.get("token").stringValue()).isEqualTo("android-token-1");
        assertThat(message.get("notification").get("body").stringValue()).isEqualTo("3 new messages");
        assertThat(message.get("data").get("chatId").stringValue()).isEqualTo("chat_x");
        assertThat(message.get("android").get("collapse_key").stringValue()).isEqualTo("chat-1");

        status.set(new int[] {404});
        answer.set("{\"error\":{\"status\":\"NOT_FOUND\",\"details\":[{\"errorCode\":\"UNREGISTERED\"}]}}");
        assertThat(fcm.send("android-token-1", MESSAGE)).isEqualTo(PushSender.Result.GONE);
        status.set(new int[] {400});
        answer.set("{\"error\":{\"status\":\"INVALID_ARGUMENT\",\"details\":[{\"errorCode\":\"INVALID_ARGUMENT\"}]}}");
        assertThat(fcm.send("android-token-1", MESSAGE)).isEqualTo(PushSender.Result.FAILED);
        status.set(new int[] {503});
        answer.set("");
        assertThat(fcm.send("android-token-1", MESSAGE)).isEqualTo(PushSender.Result.RETRY);
        Fcm broken = new Fcm(URI.create("http://127.0.0.1:1/none"), () -> {
            throw new IllegalStateException("no token");
        });
        assertThat(broken.send("android-token-1", MESSAGE)).isEqualTo(PushSender.Result.RETRY);
    }
}
