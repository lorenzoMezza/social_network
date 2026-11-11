// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import java.net.URI;
import org.jspecify.annotations.Nullable;

/**
 * How tokens are checked. {@code apiResource}: the {@code aud} every access token must have
 * (the same as the app's EXPO_PUBLIC_API_RESOURCE); null only in development, where the app
 * may send an opaque token, checked with Logto's userinfo. {@code appId}: the {@code aud} of
 * the app's ID tokens. {@code trustUnverified}: development only, when Logto cannot be
 * reached; with PRODUCTION=1 the server does not start with it.
 */
public record AuthConfig(
        String issuer,
        URI jwks,
        URI userinfo,
        @Nullable String apiResource,
        String appId,
        boolean trustUnverified,
        boolean production) {

    public static AuthConfig logto(String issuer, @Nullable String apiResource, String appId) {
        String base = issuer.endsWith("/") ? issuer.substring(0, issuer.length() - 1) : issuer;
        return new AuthConfig(base, URI.create(base + "/jwks"), URI.create(base + "/me"), apiResource, appId, false, false);
    }
}
