// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.DefaultJOSEObjectTypeVerifier;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.BadJWTException;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import java.net.MalformedURLException;
import java.net.URI;
import java.time.InstantSource;
import java.util.Date;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The two checkers of JAVA-BACKEND.md §16, as proved there: access tokens (RFC 9068
 * {@code typ: at+jwt} or plain {@code JWT}: Nimbus refuses {@code at+jwt} by default, which
 * would be a 401 to everything), and ID tokens, valid even when expired: they only say who
 * signed in, to name the account made by that sign-in.
 */
final class Tokens {

    static final Set<JWSAlgorithm> ALGORITHMS = Set.of(JWSAlgorithm.ES384, JWSAlgorithm.ES256, JWSAlgorithm.RS256);

    private Tokens() {
    }

    /** Keys cached an hour, fetched again for an unknown {@code kid}, kept 6 h while Logto is away. */
    static JWKSource<SecurityContext> keys(URI jwks) {
        try {
            return JWKSourceBuilder.<SecurityContext>create(jwks.toURL())
                    .cache(3_600_000, 15_000)
                    .rateLimited(30_000)
                    .refreshAheadCache(true)
                    .outageTolerant(6 * 3_600_000)
                    .retrying(true)
                    .build();
        } catch (MalformedURLException error) {
            throw new IllegalArgumentException("LOGTO_JWKS_URL is not a URL", error);
        }
    }

    static DefaultJWTProcessor<SecurityContext> accessTokens(JWKSource<SecurityContext> keys, String issuer, @Nullable String audience,
                                                             InstantSource clock) {
        DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        processor.setJWSKeySelector(new JWSVerificationKeySelector<>(ALGORITHMS, keys));
        processor.setJWSTypeVerifier(new DefaultJOSEObjectTypeVerifier<>(new JOSEObjectType("at+jwt"), JOSEObjectType.JWT, null));
        // A minute of leeway on exp and nbf (the default of DefaultJWTClaimsVerifier)
        // One clock for the whole server (InstantSource), not Nimbus's own
        processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(audience,
                new JWTClaimsSet.Builder().issuer(issuer).build(), Set.of("sub", "exp")) {
            @Override
            protected Date currentTime() {
                return Date.from(clock.instant());
            }
        });
        return processor;
    }

    static DefaultJWTProcessor<SecurityContext> idTokens(JWKSource<SecurityContext> keys, String issuer, String appId) {
        DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        processor.setJWSKeySelector(new JWSVerificationKeySelector<>(ALGORITHMS, keys));
        processor.setJWTClaimsSetVerifier((claims, context) -> {
            if (!issuer.equals(claims.getIssuer()) || claims.getAudience() == null || !claims.getAudience().contains(appId)
                    || claims.getSubject() == null) {
                throw new BadJWTException("not an ID token of the app");
            }
        });
        return processor;
    }
}
