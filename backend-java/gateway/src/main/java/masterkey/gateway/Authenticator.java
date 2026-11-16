// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.time.Instant;
import java.util.UUID;

/**
 * Who an access token belongs to (implemented by {@code auth}). It may ask Logto for keys
 * and touch the database, so the gateway calls it on a virtual thread, never inside a
 * callback of the socket (JAVA-BACKEND.md §4.10).
 */
public interface Authenticator {

    /**
     * The user of the token, creating the account the first time as {@code GET /me} does.
     *
     * @throws masterkey.core.ApiError 401 when the token is not valid, or the account was deleted
     */
    Identity authenticate(String token);

    /** {@code expires}: when the token runs out; the socket closes with 4001 then. */
    record Identity(UUID user, Instant expires) {
    }
}
