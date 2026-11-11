// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Expiry;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.BadJOSEException;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import java.io.IOException;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.ParseException;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Date;
import java.util.HexFormat;
import masterkey.core.ApiError;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * Checks access tokens, as {@code auth._claims_for}: a JWT with the JWKS (signature,
 * {@code iss}, {@code aud} when an API resource is set, {@code exp} with a minute of
 * leeway); in development without an API resource, an opaque token with Logto's userinfo.
 * A verified token is kept by the hash of the token until it expires, so a request costs no
 * network call after the first; an account deleted refuses its tokens issued before.
 *
 * <p>Blocking (the JWKS, the userinfo): call it on a virtual thread.
 */
public final class TokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(TokenVerifier.class);
    private static final Duration OPAQUE_KEPT = Duration.ofMinutes(10);
    private static final Duration LEEWAY = Duration.ofMinutes(1);
    private static final int MAX_TOKEN = 16_384;

    /** When an account was deleted, if it was in the last 2 hours (erased_accounts). */
    public interface Erased {
        @Nullable Instant erasedAt(String sub);
    }

    private final AuthConfig config;
    private final InstantSource clock;
    private final Erased erased;
    private final HttpClient http;
    private final DefaultJWTProcessor<SecurityContext> accessTokens;
    private final DefaultJWTProcessor<SecurityContext> idTokens;
    private final Cache<String, Claims> verified;

    public TokenVerifier(AuthConfig config, InstantSource clock, Erased erased) {
        this(config, clock, erased, Tokens.keys(config.jwks()));
    }

    TokenVerifier(AuthConfig config, InstantSource clock, Erased erased, JWKSource<SecurityContext> keys) {
        this.config = config;
        this.clock = clock;
        this.erased = erased;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
        this.accessTokens = Tokens.accessTokens(keys, config.issuer(), config.apiResource(), clock);
        this.idTokens = Tokens.idTokens(keys, config.issuer(), config.appId());
        this.verified = Caffeine.newBuilder()
                .maximumSize(200_000)
                .expireAfter(new Expiry<String, Claims>() {
                    @Override
                    public long expireAfterCreate(String key, Claims claims, long now) {
                        return Math.max(0, Duration.between(clock.instant(), claims.expires()).toNanos());
                    }

                    @Override
                    public long expireAfterUpdate(String key, Claims claims, long now, long left) {
                        return expireAfterCreate(key, claims, now);
                    }

                    @Override
                    public long expireAfterRead(String key, Claims claims, long now, long left) {
                        return left;
                    }
                })
                .build();
    }

    /** The claims of a valid access token, or 401 (503 when the keys cannot be had at all). */
    public Claims verify(@Nullable String token) {
        if (token == null || token.isBlank() || token.length() > MAX_TOKEN) throw unauthorized("access token missing, invalid or expired");
        String key = hash(token);
        Claims claims = verified.getIfPresent(key);
        if (claims == null || !claims.expires().isAfter(clock.instant())) {
            claims = jwtShaped(token) ? jwt(token) : opaque(token);
            if (claims.sub().isEmpty()) throw unauthorized("the token has no subject");
        }
        checkNotErased(claims);
        verified.put(key, claims);
        return claims;
    }

    /** The account is gone (DELETE /me): its tokens stop working now on this machine. */
    public void forget(String sub) {
        verified.asMap().values().removeIf(claims -> claims.sub().equals(sub));
    }

    /**
     * The names in the app's ID token ({@code X-Id-Token}), when it verifies and is of the same
     * {@code sub}; expired is fine. Anything else names nothing.
     */
    public @Nullable Claims idToken(@Nullable String token, String sub) {
        if (token == null || token.isBlank() || token.length() > MAX_TOKEN || !jwtShaped(token)) return null;
        try {
            JWTClaimsSet set = idTokens.process(token, null);
            if (!sub.equals(set.getSubject())) return null;
            return claims(set);
        } catch (BadJOSEException | JOSEException | ParseException error) {
            return null;
        }
    }

    /**
     * {@code X-Profile-Hint}: names as percent-encoded JSON, unsigned. Development only: a
     * client can write any email in it.
     */
    public @Nullable Claims hint(@Nullable String header, String sub) {
        if (config.production() || header == null || header.isBlank() || header.length() > 4096) return null;
        try {
            JsonNode node = Json.parse(URLDecoder.decode(header, StandardCharsets.UTF_8));
            if (!node.isObject()) return null;
            return new Claims(sub, clock.instant(), clock.instant(), text(node, "name"), text(node, "username"), text(node, "email"));
        } catch (ApiError | IllegalArgumentException error) {
            return null;
        }
    }

    // --- the kinds of token ---

    private Claims jwt(String token) {
        try {
            return claims(accessTokens.process(token, null));
        } catch (KeySourceException error) {
            // Logto cannot be reached and no key is cached: not the token's fault. Never for a
            // key Logto does not know (anyone can write a token naming an unknown key)
            if (config.trustUnverified()) return unverified(token);
            log.warn("auth: the keys of Logto cannot be had: {}", error.getClass().getSimpleName());
            throw ApiError.unavailable("cannot check the access token now", 5);
        } catch (BadJOSEException error) {
            String message = error.getMessage();
            throw unauthorized(message != null && message.contains("Expired") ? "access token expired" : "invalid access token");
        } catch (JOSEException | ParseException error) {
            throw unauthorized("invalid access token");
        }
    }

    /** Development only (TRUST_UNVERIFIED_TOKENS): the claims without the signature, still refusing an expired one. */
    private Claims unverified(String token) {
        try {
            Claims claims = claims(SignedJWT.parse(token).getJWTClaimsSet());
            if (claims.expires().plus(LEEWAY).isBefore(clock.instant())) throw unauthorized("access token expired");
            return claims;
        } catch (ParseException error) {
            throw unauthorized("malformed access token");
        }
    }

    /** Development only: with an API resource every real token is a JWT for it. */
    private Claims opaque(String token) {
        if (config.apiResource() != null) throw unauthorized("invalid access token");
        HttpResponse<String> answer;
        try {
            answer = http.send(HttpRequest.newBuilder(config.userinfo())
                    .timeout(Duration.ofSeconds(8))
                    .header("Authorization", "Bearer " + token)
                    .GET().build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException error) {
            throw ApiError.unavailable("cannot check the access token now", 5);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw ApiError.unavailable("cannot check the access token now", 5);
        }
        if (answer.statusCode() != 200) throw unauthorized("access token missing, invalid or expired");
        JsonNode node;
        try {
            node = Json.parse(answer.body());
        } catch (ApiError error) {
            throw unauthorized("invalid access token");
        }
        String sub = text(node, "sub");
        if (sub == null) throw unauthorized("the token has no subject");
        // No iat from the userinfo: an account deleted refuses it in any case
        return new Claims(sub, clock.instant().plus(OPAQUE_KEPT), Instant.EPOCH, text(node, "name"), text(node, "username"), text(node, "email"));
    }

    private void checkNotErased(Claims claims) {
        Instant at = erased.erasedAt(claims.sub());
        if (at != null && !claims.issued().isAfter(at)) throw unauthorized("this account was deleted");
    }

    private static Claims claims(JWTClaimsSet set) throws ParseException {
        String sub = set.getSubject();
        if (sub == null || sub.isEmpty()) throw new ParseException("no subject", 0);
        Date expires = set.getExpirationTime();
        Date issued = set.getIssueTime();
        return new Claims(sub,
                expires == null ? Instant.EPOCH : expires.toInstant(),
                issued == null ? Instant.EPOCH : issued.toInstant(),
                set.getStringClaim("name"), set.getStringClaim("username"), set.getStringClaim("email"));
    }

    static boolean jwtShaped(String token) {
        int dots = 0;
        for (int i = 0; i < token.length(); i++) if (token.charAt(i) == '.') dots++;
        return dots == 2;
    }

    private static @Nullable String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isString() && !value.stringValue().isEmpty() ? value.stringValue() : null;
    }

    private static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    static ApiError unauthorized(String message) {
        return ApiError.unauthorized(message);
    }
}
