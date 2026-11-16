// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.net.URI;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import masterkey.core.ApiError;
import org.junit.jupiter.api.Test;

/** The rules proved in JAVA-BACKEND.md §16 for Tokens, on keys made here. */
class TokenVerifierTest {

    static final String ISSUER = "https://example.logto.app/oidc";
    static final String RESOURCE = "https://api.example.com";
    static final String APP = "app-client-id";
    static final Instant NOW = Instant.parse("2026-11-11T10:00:00Z");

    final ECKey key = generate("k1");
    final ECKey other = generate("k1");
    final Map<String, Instant> erased = new HashMap<>();
    final TokenVerifier verifier = new TokenVerifier(
            new AuthConfig(ISSUER, URI.create(ISSUER + "/jwks"), URI.create(ISSUER + "/me"), RESOURCE, APP, false, true),
            InstantSource.fixed(NOW), erased::get, new ImmutableJWKSet<>(new JWKSet(key.toPublicJWK())));

    static ECKey generate(String kid) {
        try {
            return new ECKeyGenerator(Curve.P_384).keyID(kid).generate();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    String token(ECKey signer, String type, JWTClaimsSet claims) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.ES384).keyID(signer.getKeyID())
                    .type(new JOSEObjectType(type)).build(), claims);
            jwt.sign(new ECDSASigner(signer));
            return jwt.serialize();
        } catch (Exception error) {
            throw new IllegalStateException(error);
        }
    }

    JWTClaimsSet.Builder access() {
        return new JWTClaimsSet.Builder().issuer(ISSUER).audience(RESOURCE).subject("sub-1")
                .issueTime(Date.from(NOW.minusSeconds(60))).expirationTime(Date.from(NOW.plusSeconds(3600)));
    }

    @Test
    void aValidAccessTokenGivesItsSubject() {
        assertThat(verifier.verify(token(key, "at+jwt", access().build())).sub()).isEqualTo("sub-1");
        assertThat(verifier.verify(token(key, "JWT", access().build())).sub()).isEqualTo("sub-1");
    }

    @Test
    void aMinuteOfLeewayAndNoMore() {
        assertThat(verifier.verify(token(key, "at+jwt", access().expirationTime(Date.from(NOW.minusSeconds(30))).build())).sub())
                .isEqualTo("sub-1");
        assertThatThrownBy(() -> verifier.verify(token(key, "at+jwt", access().expirationTime(Date.from(NOW.minusSeconds(120))).build())))
                .isInstanceOf(ApiError.class).hasMessage("access token expired");
    }

    @Test
    void everyForgeryIsRefused() throws Exception {
        String[] bad = {
            token(key, "at+jwt", access().issuer("https://evil.example").build()),
            token(key, "at+jwt", access().audience("https://another.api").build()),
            token(key, "at+jwt", access().subject(null).build()),
            token(key, "at+jwt", access().expirationTime(null).build()),
            token(other, "at+jwt", access().build()),
            token(generate("unknown"), "at+jwt", access().build()),
            token(key, "id+jwt", access().build()),
        };
        for (String token : bad) {
            assertThatThrownBy(() -> verifier.verify(token)).isInstanceOf(ApiError.class)
                    .satisfies(error -> assertThat(((ApiError) error).status()).isEqualTo(401));
        }
        // alg none, and HS256 signed with the public key as the secret
        String body = token(key, "at+jwt", access().build()).split("\\.", -1)[1];
        String none = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("{\"alg\":\"none\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8)) + "." + body + ".";
        SignedJWT hmac = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256).keyID("k1").build(), access().build());
        hmac.sign(new MACSigner(java.util.Arrays.copyOf(key.toPublicJWK().toJSONString().getBytes(java.nio.charset.StandardCharsets.UTF_8), 64)));
        // Content changed after signing
        String[] parts = token(key, "at+jwt", access().build()).split("\\.", -1);
        String tampered = parts[0] + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(access().subject("sub-2").build().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)) + "." + parts[2];
        for (String token : new String[] {none, hmac.serialize(), tampered, "not-a-token", "", "a.b.c"}) {
            assertThatThrownBy(() -> verifier.verify(token)).isInstanceOf(ApiError.class)
                    .satisfies(error -> assertThat(((ApiError) error).status()).isEqualTo(401));
        }
    }

    @Test
    void aDeletedAccountRefusesItsOlderTokens() {
        String token = token(key, "at+jwt", access().build());
        assertThat(verifier.verify(token).sub()).isEqualTo("sub-1");
        erased.put("sub-1", NOW.minusSeconds(10));
        assertThatThrownBy(() -> verifier.verify(token)).isInstanceOf(ApiError.class).hasMessage("this account was deleted");
        // A sign-in after the deletion makes a new account
        assertThat(verifier.verify(token(key, "at+jwt", access().issueTime(Date.from(NOW)).build())).sub()).isEqualTo("sub-1");
    }

    @Test
    void anOpaqueTokenIsRefusedWithAnApiResource() {
        assertThatThrownBy(() -> verifier.verify("opaque-token-of-logto")).isInstanceOf(ApiError.class)
                .satisfies(error -> assertThat(((ApiError) error).status()).isEqualTo(401));
    }

    @Test
    void theIdTokenNamesTheAccountEvenWhenExpired() {
        JWTClaimsSet id = new JWTClaimsSet.Builder().issuer(ISSUER).audience(APP).subject("sub-1")
                .claim("name", "Sara Moretti").claim("username", "sara_m").claim("email", "sara@example.com")
                .expirationTime(Date.from(NOW.minusSeconds(86_400))).build();
        Claims names = verifier.idToken(token(key, "JWT", id), "sub-1");
        assertThat(names).isNotNull();
        assertThat(names.name()).isEqualTo("Sara Moretti");
        assertThat(names.username()).isEqualTo("sara_m");
        assertThat(names.email()).isEqualTo("sara@example.com");
        assertThat(verifier.idToken(token(key, "JWT", id), "sub-2")).isNull();
        assertThat(verifier.idToken(token(other, "JWT", id), "sub-1")).isNull();
        JWTClaimsSet wrongApp = new JWTClaimsSet.Builder(id).audience("another-app").build();
        assertThat(verifier.idToken(token(key, "JWT", wrongApp), "sub-1")).isNull();
        // The unsigned hint names nobody in production
        assertThat(verifier.hint("%7B%22name%22%3A%22X%22%7D", "sub-1")).isNull();
    }

    @Test
    void claimsSayNothingWhenPrinted() {
        assertThat(verifier.verify(token(key, "at+jwt", access().build())).toString()).isEqualTo("Claims[…]");
    }

    @Test
    void tooOldAppsAreAskedToUpdate() {
        AppVersion minimum = new AppVersion("1.2.0");
        assertThat(minimum.tooOld("1.1.9 (ios)")).isTrue();
        assertThat(minimum.tooOld("1.2.0 (android)")).isFalse();
        assertThat(minimum.tooOld("1.10.0 (ios)")).isFalse();
        assertThat(minimum.tooOld("1.2")).isFalse();
        assertThat(minimum.tooOld(null)).isFalse();
        assertThat(minimum.tooOld("browser")).isFalse();
        assertThat(new AppVersion(null).tooOld("0.0.1 (ios)")).isFalse();
    }
}
