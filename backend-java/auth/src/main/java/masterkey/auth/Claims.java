// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import java.time.Instant;
import org.jspecify.annotations.Nullable;

/**
 * What a verified token says: who ({@code sub}), until when, since when, and the names
 * Logto signed (only an ID token or the userinfo carries them). Its {@code toString} says
 * nothing: claims never reach a log.
 */
public record Claims(String sub, Instant expires, Instant issued, @Nullable String name, @Nullable String username,
                     @Nullable String email) {

    public boolean named() {
        return name != null || username != null || email != null;
    }

    @Override
    public String toString() {
        return "Claims[…]";
    }
}
