// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import java.time.Instant;
import java.time.InstantSource;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.store.Database;
import masterkey.store.db.tables.records.PromotionsRecord;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/**
 * The wallet of promotion credits and the store purchases (API.md, Promotions;
 * {@code routes/promotions.py}). A purchase is checked with the store first, outside any
 * transaction (the network never holds a connection, §16), then credited once.
 */
@RestController
@RequestMapping("/v1")
public class WalletController {

    private static final Logger log = LoggerFactory.getLogger(WalletController.class);
    static final Set<String> PLATFORMS = Set.of("ios", "android", "dev");

    private final Database db;
    private final Stores stores;
    private final Watchers watchers;
    private final Limits limits;
    private final InstantSource clock;

    public WalletController(Database db, Stores stores, Watchers watchers, Limits limits, InstantSource clock) {
        this.db = db;
        this.stores = stores;
        this.watchers = watchers;
        this.limits = limits;
        this.clock = clock;
    }

    @GetMapping("/me/wallet")
    public Map<String, Object> wallet(Viewer viewer) {
        return db.tx(ctx -> Wallets.view(ctx, viewer.id()));
    }

    /** A store purchase of credits. The app finishes (consumes) the transaction only after this answers. */
    @PostMapping("/me/wallet/purchases")
    public Map<String, Object> purchase(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        limits.check(viewer.id(), Limits.Action.PURCHASE);
        Body body = Body.of(raw);
        String platform = text(body, "platform");
        String productId = text(body, "productId");
        String token = text(body, "purchaseToken");
        if (platform == null || !PLATFORMS.contains(platform) || productId == null || token == null || token.isEmpty()) {
            throw ApiError.badRequest("platform (ios, android), productId and purchaseToken");
        }
        // Before asking a store about it
        if (Wallets.packCredits(productId) < 0) throw ApiError.badRequest("productId: not a credit pack");
        String account = db.tx(ctx -> Wallets.accountToken(ctx, viewer.id()));
        Stores.Purchase checked = switch (platform) {
            case "ios" -> stores.requireApple().verify(token, account);
            case "android" -> stores.requireGoogle().verify(productId, token, account);
            default -> {
                // Development: a test top-up without a store; the token is its transaction id
                if (!stores.devPurchases()) throw ApiError.forbidden("test purchases are off");
                if (token.length() > 200) throw ApiError.badRequest("purchaseToken: at most 200 characters");
                yield new Stores.Purchase(token, productId);
            }
        };
        if (!checked.productId().equals(productId)) throw new ApiError(400, "invalid_purchase", "another product");
        Instant now = clock.instant();
        return db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            // The order of money's locks: the promotions to resume before the wallet
            List<PromotionsRecord> paused = Promotions.pausedOf(ctx, viewer.id(), now);
            boolean credited = Wallets.credit(ctx, viewer.id(), platform, checked.transactionId(), productId, now);
            // A promotion paused for lack of credits starts again at once
            if (credited) for (UUID event : Promotions.resume(ctx, paused, now)) watchers.reachChanged(event, 0);
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("credited", credited);
            answer.putAll(Wallets.view(ctx, viewer.id()));
            return answer;
        });
    }

    private static @Nullable String text(Body body, String field) {
        JsonNode value = body.raw(field);
        return value != null && value.isString() ? value.stringValue() : null;
    }

    // --- the stores' notices of refunds (server to server, without login) ---

    /** App Store Server Notifications V2: a refunded or revoked purchase takes its credits back. */
    @PostMapping("/store/apple/notifications")
    public ResponseEntity<Void> apple(@RequestBody(required = false) @Nullable JsonNode raw) {
        AppleStore apple = stores.requireApple();
        JsonNode signed = raw == null ? null : raw.get("signedPayload");
        if (signed == null || !signed.isString()) throw AppleStore.refused("not a signed App Store notification");
        String transaction = apple.refunded(signed.stringValue());
        if (transaction != null) reverse("ios", transaction);
        return ResponseEntity.ok().build();
    }

    /** Play real-time developer notifications: a Pub/Sub push subscription to this address, with ?secret=. */
    @PostMapping("/store/google/notifications")
    public ResponseEntity<Void> google(@RequestParam(required = false) @Nullable String secret,
                                       @RequestBody(required = false) @Nullable JsonNode raw) {
        GoogleStore google = stores.google();
        if (google == null || !google.sender(secret)) throw ApiError.forbidden("unknown sender");
        String order = google.refunded(raw);
        if (order != null) reverse("android", order);
        return ResponseEntity.noContent().build();
    }

    private void reverse(String platform, String transaction) {
        Instant now = clock.instant();
        boolean reversed = db.tx(ctx -> Wallets.reverse(ctx, platform, transaction, now));
        if (reversed) log.info("wallet: a {} purchase was refunded, its credits taken back", platform);
    }
}
