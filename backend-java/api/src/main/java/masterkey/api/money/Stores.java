// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import masterkey.core.ApiError;
import org.jspecify.annotations.Nullable;

/**
 * The stores this server checks purchases with. A store not configured answers 503
 * unavailable: nothing is ever credited unchecked. {@code dev} (test top-ups without a store)
 * exists only with DEV_TOOLS, which a production server refuses.
 */
public record Stores(@Nullable AppleStore apple, @Nullable GoogleStore google, boolean devPurchases) {

    /** What a store said was bought: its transaction (order) id and product. */
    public record Purchase(String transactionId, String productId) {
    }

    public AppleStore requireApple() {
        AppleStore store = apple;
        if (store == null) throw ApiError.unavailable("App Store purchases are not set up on this server", 3600);
        return store;
    }

    public GoogleStore requireGoogle() {
        GoogleStore store = google;
        if (store == null) throw ApiError.unavailable("Google Play purchases are not set up on this server", 3600);
        return store;
    }
}
