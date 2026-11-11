// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import masterkey.core.Json;
import masterkey.store.TestDatabase;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.JsonNode;

/**
 * The whole server, as `make dev` starts it, on a free port: a fresh PostGIS database, and a
 * stand-in for Logto that serves the JWKS of a key made here, so tests sign real tokens.
 */
final class TestServer implements AutoCloseable {

    static final String RESOURCE = "https://api.test";
    static final String APP = "test-app";

    final ECKey key;
    final HttpServer logto;
    final String issuer;
    final ConfigurableApplicationContext context;
    final int port;
    final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    TestServer() {
        this(Map.of());
    }

    TestServer(Map<String, String> more) {
        try {
            key = new ECKeyGenerator(Curve.P_384).keyID("test-key").generate();
            logto = HttpServer.create(new InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 0);
            byte[] jwks = new JWKSet(key.toPublicJWK()).toString().getBytes(StandardCharsets.UTF_8);
            logto.createContext("/oidc/jwks", exchange -> {
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, jwks.length);
                exchange.getResponseBody().write(jwks);
                exchange.close();
            });
            logto.start();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
        issuer = "http://127.0.0.1:" + logto.getAddress().getPort() + "/oidc";
        TestDatabase.Address database = TestDatabase.freshAddress();
        Map<String, String> env = new HashMap<>();
        env.put("PORT", "0");
        env.put("DATABASE_URL", database.url());
        env.put("DATABASE_USER", database.user());
        env.put("DATABASE_PASSWORD", database.password());
        env.put("DATABASE_POOL", "10");
        env.put("LOGTO_ISSUER", issuer);
        env.put("API_RESOURCE", RESOURCE);
        env.put("LOGTO_APP_ID", APP);
        env.put("MIN_APP_VERSION", "1.0.0");
        env.put("AVATAR_LIBRARY", java.nio.file.Path.of("../../avatar-server/library").toAbsolutePath().normalize().toString());
        env.put("AVATAR_BAKER_URL", "");
        try {
            env.put("DATA_DIR", java.nio.file.Files.createTempDirectory("masterkey-test-").toString());
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
        env.putAll(more);
        context = Main.start(Settings.from(env, new String[0]), new String[0]);
        port = ((WebServerApplicationContext) context).getWebServer().getPort();
    }

    String token(String sub) {
        return sign("at+jwt", new JWTClaimsSet.Builder().issuer(issuer).audience(RESOURCE).subject(sub)
                .issueTime(Date.from(Instant.now().minusSeconds(5))).expirationTime(Date.from(Instant.now().plusSeconds(3600))).build());
    }

    String idToken(String sub, String name, String username, String email) {
        return sign("JWT", new JWTClaimsSet.Builder().issuer(issuer).audience(APP).subject(sub).claim("name", name)
                .claim("username", username).claim("email", email).expirationTime(Date.from(Instant.now().minusSeconds(600))).build());
    }

    private String sign(String type, JWTClaimsSet claims) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES384).keyID(key.getKeyID()).type(new JOSEObjectType(type)).build(), claims);
            jwt.sign(new ECDSASigner(key));
            return jwt.serialize();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    URI uri(String path) {
        return URI.create("http://127.0.0.1:" + port + path);
    }

    record Answer(int status, JsonNode body, HttpResponse<String> raw) {
        String header(String name) {
            return raw.headers().firstValue(name).orElse(null);
        }
    }

    Answer send(HttpRequest.Builder request) {
        try {
            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            JsonNode body = response.body().isEmpty() ? Json.object() : Json.parse(response.body());
            return new Answer(response.statusCode(), body, response);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    Answer get(String path, String token) {
        return send(HttpRequest.newBuilder(uri(path)).header("Authorization", "Bearer " + token).GET());
    }

    Answer json(String method, String path, String token, String body) {
        return send(HttpRequest.newBuilder(uri(path)).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body)));
    }

    @Override
    public void close() {
        context.close();
        logto.stop(0);
    }
}
