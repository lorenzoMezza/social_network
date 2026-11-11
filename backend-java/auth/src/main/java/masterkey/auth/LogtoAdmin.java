// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Base64;
import java.util.regex.Pattern;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Logto's Management API, for one thing: deleting the identity of an account deleted here (C14
 * of the retention; API.md, DELETE /me). A machine-to-machine application of Logto with the
 * Management API's role: its token by client credentials, kept until shortly before it expires.
 * Every call has timeouts and never follows a redirect (§21).
 */
public final class LogtoAdmin {

    static final Duration TIMEOUT = Duration.ofSeconds(10);
    /** A Logto user id: letters and digits (nothing that could make another address). */
    static final Pattern SUB = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    private final URI tokenUrl;
    private final URI usersUrl;
    private final String resource;
    private final String basic;
    private final InstantSource clock;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(TIMEOUT).followRedirects(HttpClient.Redirect.NEVER).build();
    private @Nullable String token;
    private Instant tokenUntil = Instant.EPOCH;

    /**
     * {@code issuer}: Logto's OIDC issuer ({@code https://<tenant>.logto.app/oidc}). The
     * Management API lives next to it ({@code …/api}), and so does its resource indicator unless
     * another is given (a self-hosted Logto: {@code https://default.logto.app/api}).
     */
    public LogtoAdmin(String issuer, @Nullable String resource, String appId, String appSecret, InstantSource clock) {
        String base = issuer.endsWith("/oidc") ? issuer.substring(0, issuer.length() - "/oidc".length()) : issuer;
        this.tokenUrl = URI.create(base + "/oidc/token");
        this.usersUrl = URI.create(base + "/api/users/");
        this.resource = resource != null ? resource : base + "/api";
        this.basic = "Basic " + Base64.getEncoder().encodeToString((appId + ":" + appSecret).getBytes(StandardCharsets.UTF_8));
        this.clock = clock;
    }

    /** Deletes the user at Logto: true when gone (or already gone), false when Logto did not do it now (to try again). */
    public boolean deleteUser(String sub) throws IOException, InterruptedException {
        if (!SUB.matcher(sub).matches()) return true;
        HttpResponse<String> answer = http.send(HttpRequest.newBuilder(usersUrl.resolve(sub)).timeout(TIMEOUT)
                .header("Authorization", "Bearer " + token()).DELETE().build(), HttpResponse.BodyHandlers.ofString());
        int status = answer.statusCode();
        if (status == 401) {
            synchronized (this) {
                token = null;
            }
        }
        return status == 204 || status == 200 || status == 404;
    }

    private synchronized String token() throws IOException, InterruptedException {
        String known = token;
        if (known != null && clock.instant().isBefore(tokenUntil)) return known;
        String form = "grant_type=client_credentials&resource=" + URLEncoder.encode(resource, StandardCharsets.UTF_8) + "&scope=all";
        HttpResponse<String> answer = http.send(HttpRequest.newBuilder(tokenUrl).timeout(TIMEOUT).header("Authorization", basic)
                .header("Content-Type", "application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(form)).build(),
                HttpResponse.BodyHandlers.ofString());
        if (answer.statusCode() != 200) throw new IOException("Logto refused the token of the Management API: " + answer.statusCode());
        JsonNode body = Json.parse(answer.body());
        String value = body.path("access_token").stringValue(null);
        if (value == null) throw new IOException("Logto gave no token for the Management API");
        long seconds = body.path("expires_in").asLong(3600);
        token = value;
        tokenUntil = clock.instant().plusSeconds(Math.max(60, seconds - 60));
        return value;
    }

    @Override
    public String toString() {
        return "LogtoAdmin[" + usersUrl + "]";
    }
}
