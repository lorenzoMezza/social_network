// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import com.google.api.client.googleapis.json.GoogleJsonResponseException;
import com.google.api.client.http.HttpRequestInitializer;
import com.google.api.client.http.javanet.NetHttpTransport;
import com.google.api.client.json.gson.GsonFactory;
import com.google.api.services.androidpublisher.AndroidPublisher;
import com.google.api.services.androidpublisher.AndroidPublisherScopes;
import com.google.api.services.androidpublisher.model.ProductPurchase;
import com.google.auth.http.HttpCredentialsAdapter;
import com.google.auth.oauth2.GoogleCredentials;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import masterkey.core.ApiError;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Purchases on Google Play ({@code stores.py}): the purchase token is looked up with the Play
 * Developer API (a service account allowed to read the app's orders); its state, kind and
 * obfuscatedExternalAccountId (the wallet's account token) are checked. Refunds come as
 * real-time developer notifications, a Pub/Sub push to an address with {@code ?secret=}.
 */
public final class GoogleStore {

    static final int TIMEOUT_MS = 10_000;
    static final int MAX_TOKEN = 4096;

    private final String packageName;
    private final boolean allowTest;
    private final byte @Nullable [] noticeSecret;
    private final AndroidPublisher publisher;

    public GoogleStore(String packageName, Path serviceAccount, boolean allowTest, @Nullable String noticeSecret) {
        this.packageName = packageName;
        this.allowTest = allowTest;
        this.noticeSecret = noticeSecret == null || noticeSecret.isEmpty() ? null : noticeSecret.getBytes(StandardCharsets.UTF_8);
        GoogleCredentials credentials;
        try (InputStream in = Files.newInputStream(serviceAccount)) {
            credentials = GoogleCredentials.fromStream(in).createScoped(List.of(AndroidPublisherScopes.ANDROIDPUBLISHER));
        } catch (IOException error) {
            throw new UncheckedIOException("GOOGLE_SERVICE_ACCOUNT_FILE cannot be read", error);
        }
        HttpCredentialsAdapter signed = new HttpCredentialsAdapter(credentials);
        HttpRequestInitializer requests = request -> {
            signed.initialize(request);
            request.setConnectTimeout(TIMEOUT_MS);
            request.setReadTimeout(TIMEOUT_MS);
            request.setNumberOfRetries(0);
        };
        this.publisher = new AndroidPublisher.Builder(new NetHttpTransport(), GsonFactory.getDefaultInstance(), requests)
                .setApplicationName("masterkey-backend").build();
    }

    /** The order id and product of a purchase paid by this account, or 400 invalid_purchase; 503 when Play does not answer. */
    public Stores.Purchase verify(String productId, String purchaseToken, String accountToken) {
        if (purchaseToken.length() > MAX_TOKEN) throw AppleStore.refused("unknown purchase");
        ProductPurchase purchase;
        try {
            // The client escapes both: from the app, they cannot reach another address with our credentials
            purchase = publisher.purchases().products().get(packageName, productId, purchaseToken).execute();
        } catch (GoogleJsonResponseException error) {
            int status = error.getStatusCode();
            if (status == 400 || status == 404 || status == 410) throw AppleStore.refused("unknown purchase");
            throw ApiError.unavailable("Google Play did not answer", 10);
        } catch (IOException error) {
            throw ApiError.unavailable("Google Play did not answer", 10);
        }
        // 0 purchased, 1 cancelled, 2 pending (credited once paid: the app sends it again)
        if (purchase.getPurchaseState() == null || purchase.getPurchaseState() != 0) throw AppleStore.refused("not paid");
        // 0: a licence-testing account, which pays nothing
        if (Integer.valueOf(0).equals(purchase.getPurchaseType()) && !allowTest) throw AppleStore.refused("a test purchase");
        if (!accountToken.equals(purchase.getObfuscatedExternalAccountId())) throw AppleStore.refused("bought by another account");
        String order = purchase.getOrderId();
        return new Stores.Purchase(order == null || order.isBlank() ? purchaseToken : order, productId);
    }

    /** The sender of a notice knows the secret (constant time). */
    public boolean sender(@Nullable String secret) {
        byte[] expected = noticeSecret;
        return expected != null && secret != null && MessageDigest.isEqual(secret.getBytes(StandardCharsets.UTF_8), expected);
    }

    /** The order id a push of Play's notifications refunds (voidedPurchaseNotification), or null; 400 when it is not a push. */
    public @Nullable String refunded(@Nullable JsonNode body) {
        JsonNode data;
        try {
            String encoded = body == null ? null : body.path("message").path("data").stringValue(null);
            if (encoded == null) throw ApiError.badRequest("not a Pub/Sub push");
            data = Json.parse(Base64.getDecoder().decode(encoded));
        } catch (IllegalArgumentException | tools.jackson.core.JacksonException error) {
            throw ApiError.badRequest("not a Pub/Sub push");
        }
        if (!packageName.equals(data.path("packageName").stringValue(null))) return null;
        String order = data.path("voidedPurchaseNotification").path("orderId").stringValue(null);
        return order == null || order.isBlank() ? null : order;
    }
}
