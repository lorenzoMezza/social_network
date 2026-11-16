// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.ERASED_ACCOUNTS;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import masterkey.auth.TokenVerifier;
import masterkey.store.Database;
import org.jspecify.annotations.Nullable;

/**
 * Accounts deleted in the last 2 hours ({@code erased_accounts}): a token issued before must
 * not make the account again. Looked up once a minute per account at most; the machine that
 * deletes knows at once, the others within the minute (with more machines, the bus tells them).
 */
final class ErasedAccounts implements TokenVerifier.Erased {

    private final Database db;
    private final Cache<String, Optional<Instant>> known = Caffeine.newBuilder()
            .maximumSize(200_000).expireAfterWrite(Duration.ofMinutes(1)).build();

    ErasedAccounts(Database db) {
        this.db = db;
    }

    @Override
    public @Nullable Instant erasedAt(String sub) {
        Optional<Instant> at = known.get(sub, key -> Optional.ofNullable(db.read(ctx ->
                ctx.select(ERASED_ACCOUNTS.AT).from(ERASED_ACCOUNTS).where(ERASED_ACCOUNTS.SUB.eq(key)).fetchOne(ERASED_ACCOUNTS.AT))));
        return at.orElse(null);
    }

    void erased(String sub, Instant at) {
        known.put(sub, Optional.of(at));
    }
}
