// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * Who is calling (API.md, Conventions, Auth; JAVA-BACKEND.md §16, Tokens): the access token
 * is checked locally with Logto's cached JWKS, signature, {@code iss}, {@code aud} and
 * {@code exp} with a minute of leeway. Never a token, a hash of one or a claim in a log.
 */
@NullMarked
package masterkey.auth;

import org.jspecify.annotations.NullMarked;
