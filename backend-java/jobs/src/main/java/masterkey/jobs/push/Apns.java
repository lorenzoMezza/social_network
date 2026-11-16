// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs.push;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Base64;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Apple Push Notification service, directly (§14, D5): HTTP/2 with the JDK's own client and the
 * token of the provider (a JWT ES256 with the team's key, made again every 50 minutes: Apple
 * refuses one older than an hour, and one made too often). No Netty, no other library.
 */
public final class Apns implements PushSender {

    private static final Logger log = LoggerFactory.getLogger(Apns.class);
    public static final URI PRODUCTION = URI.create("https://api.push.apple.com");
    public static final URI SANDBOX = URI.create("https://api.sandbox.push.apple.com");
    static final Duration TOKEN_KEPT = Duration.ofMinutes(50);
    static final Duration TIMEOUT = Duration.ofSeconds(10);
    static final Pattern DEVICE = Pattern.compile("[0-9a-fA-F]{64,200}");

    private final URI base;
    private final ECPrivateKey key;
    private final String keyId;
    private final String teamId;
    private final String topic;
    private final InstantSource clock;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_2).connectTimeout(TIMEOUT)
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private @Nullable String provider;
    private Instant providerAt = Instant.EPOCH;

    public Apns(URI base, Path keyFile, String keyId, String teamId, String topic, InstantSource clock) {
        this.base = base;
        this.key = load(keyFile);
        this.keyId = keyId;
        this.teamId = teamId;
        this.topic = topic;
        this.clock = clock;
    }

    /** The .p8 file Apple gives: a PKCS#8 EC key in PEM. */
    static ECPrivateKey load(Path file) {
        try {
            String pem = Files.readString(file, StandardCharsets.US_ASCII).replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
            return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
        } catch (IOException error) {
            throw new UncheckedIOException("APNS_KEY_FILE cannot be read", error);
        } catch (GeneralSecurityException | IllegalArgumentException | ClassCastException error) {
            throw new IllegalArgumentException("APNS_KEY_FILE is not an EC key in PKCS#8", error);
        }
    }

    private synchronized String provider() {
        Instant now = clock.instant();
        String known = provider;
        if (known != null && now.isBefore(providerAt.plus(TOKEN_KEPT))) return known;
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES256).keyID(keyId).build(),
                    new JWTClaimsSet.Builder().issuer(teamId).issueTime(Date.from(now)).build());
            jwt.sign(new ECDSASigner(key));
            provider = jwt.serialize();
            providerAt = now;
            return provider;
        } catch (JOSEException error) {
            throw new IllegalStateException("APNs: the provider token could not be signed", error);
        }
    }

    private synchronized void forgetProvider() {
        provider = null;
    }

    static String body(Message message) {
        Map<String, Object> alert = new LinkedHashMap<>();
        alert.put("title", message.title());
        alert.put("body", message.body());
        Map<String, Object> aps = new LinkedHashMap<>();
        aps.put("alert", alert);
        aps.put("sound", "default");
        aps.put("thread-id", message.collapse());
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("aps", aps);
        payload.putAll(message.data());
        return Json.text(payload);
    }

    @Override
    public Result send(String token, Message message) throws InterruptedException {
        if (!DEVICE.matcher(token).matches()) return Result.GONE;
        HttpRequest request = HttpRequest.newBuilder(base.resolve("/3/device/" + token)).timeout(TIMEOUT)
                .header("authorization", "bearer " + provider())
                .header("apns-topic", topic)
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .header("apns-expiration", Long.toString(clock.instant().plus(Duration.ofDays(1)).getEpochSecond()))
                .header("apns-collapse-id", message.collapse().length() > 64 ? message.collapse().substring(0, 64) : message.collapse())
                .POST(HttpRequest.BodyPublishers.ofString(body(message))).build();
        HttpResponse<String> answer;
        try {
            answer = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException error) {
            return Result.RETRY;
        }
        int status = answer.statusCode();
        if (status == 200) return Result.SENT;
        String reason = reason(answer.body());
        if (status == 410 || "BadDeviceToken".equals(reason) || "DeviceTokenNotForTopic".equals(reason) || "Unregistered".equals(reason)) {
            return Result.GONE;
        }
        if (status == 403 && ("ExpiredProviderToken".equals(reason) || "InvalidProviderToken".equals(reason))) {
            forgetProvider();
            return Result.RETRY;
        }
        if (status == 429 || status >= 500) return Result.RETRY;
        log.warn("apns: a push refused, {} {}", status, reason);
        return Result.FAILED;
    }

    private static @Nullable String reason(String body) {
        try {
            return body.isEmpty() ? null : Json.parse(body).path("reason").stringValue(null);
        } catch (RuntimeException error) {
            return null;
        }
    }

    @Override
    public String toString() {
        return "Apns[" + base + "]";
    }
}
