// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import com.apple.itunes.storekit.model.Environment;
import com.apple.itunes.storekit.model.JWSTransactionDecodedPayload;
import com.apple.itunes.storekit.model.NotificationTypeV2;
import com.apple.itunes.storekit.model.ResponseBodyV2DecodedPayload;
import com.apple.itunes.storekit.model.Type;
import com.apple.itunes.storekit.verification.SignedDataVerifier;
import com.apple.itunes.storekit.verification.VerificationException;
import com.apple.itunes.storekit.verification.VerificationStatus;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import masterkey.core.ApiError;
import org.jspecify.annotations.Nullable;

/**
 * Purchases on the App Store (StoreKit 2; {@code stores.py}): the transaction is a JWS signed by
 * Apple, checked by Apple's own library ({@code SignedDataVerifier}): the chain up to Apple's
 * root, the kind of each certificate, their revocation online, the signature, the app and the
 * environment (§16: never by hand). Then the product kind, a refund, and the account that bought it.
 * Sandbox purchases (TestFlight, development builds) only with {@code APPLE_ALLOW_SANDBOX}.
 */
public final class AppleStore {

    private final SignedDataVerifier production;
    private final @Nullable SignedDataVerifier sandbox;

    public AppleStore(String bundleId, long appAppleId, List<Path> roots, boolean allowSandbox, boolean onlineChecks) {
        List<byte[]> certificates = roots.stream().map(AppleStore::read).toList();
        this.production = new SignedDataVerifier(streams(certificates), bundleId, appAppleId, Environment.PRODUCTION, onlineChecks);
        this.sandbox = allowSandbox ? new SignedDataVerifier(streams(certificates), bundleId, appAppleId, Environment.SANDBOX, onlineChecks) : null;
    }

    private static byte[] read(Path path) {
        try {
            return Files.readAllBytes(path);
        } catch (IOException error) {
            throw new UncheckedIOException("APPLE_ROOT_CA: " + path + " cannot be read", error);
        }
    }

    private static Set<InputStream> streams(List<byte[]> certificates) {
        Set<InputStream> streams = new HashSet<>();
        for (byte[] certificate : certificates) streams.add(new ByteArrayInputStream(certificate));
        return streams;
    }

    static ApiError refused(String reason) {
        return new ApiError(400, "invalid_purchase", reason);
    }

    /** The transaction id and product of a consumable bought by this account, or 400 invalid_purchase. */
    public Stores.Purchase verify(String signedTransaction, String accountToken) {
        JWSTransactionDecodedPayload transaction = transaction(signedTransaction);
        if (transaction.getType() != Type.CONSUMABLE) throw refused("not a consumable");
        if (transaction.getRevocationDate() != null) throw refused("the purchase was refunded");
        UUID bought = transaction.getAppAccountToken();
        if (bought == null || !bought.toString().equalsIgnoreCase(accountToken)) throw refused("bought by another account");
        String id = transaction.getTransactionId();
        String product = transaction.getProductId();
        if (id == null || id.isBlank() || product == null) throw refused("not a signed App Store transaction");
        return new Stores.Purchase(id, product);
    }

    private JWSTransactionDecodedPayload transaction(String signed) {
        try {
            return production.verifyAndDecodeTransaction(signed);
        } catch (VerificationException error) {
            if (error.getStatus() == VerificationStatus.INVALID_ENVIRONMENT && sandbox != null) {
                try {
                    return sandbox.verifyAndDecodeTransaction(signed);
                } catch (VerificationException again) {
                    throw refusal(again);
                }
            }
            throw refusal(error);
        }
    }

    private static ApiError refusal(VerificationException error) {
        return refused(switch (error.getStatus()) {
            case INVALID_APP_IDENTIFIER -> "another app's transaction";
            case INVALID_ENVIRONMENT -> "a sandbox transaction";
            case INVALID_CERTIFICATE, INVALID_CHAIN_LENGTH, INVALID_CHAIN -> "not signed under Apple's root";
            case VERIFICATION_FAILURE -> "bad signature";
            default -> "not a signed App Store transaction";
        });
    }

    /**
     * App Store Server Notifications V2: the transaction id a refund or revocation takes back,
     * or null (another kind of notice, another environment). A notice not signed by Apple: 400.
     */
    public @Nullable String refunded(String signedPayload) {
        ResponseBodyV2DecodedPayload notice;
        try {
            notice = production.verifyAndDecodeNotification(signedPayload);
        } catch (VerificationException error) {
            if (error.getStatus() != VerificationStatus.INVALID_ENVIRONMENT) throw refusal(error);
            if (sandbox == null) return null;
            try {
                notice = sandbox.verifyAndDecodeNotification(signedPayload);
            } catch (VerificationException again) {
                throw refusal(again);
            }
        }
        NotificationTypeV2 kind = notice.getNotificationType();
        if (kind != NotificationTypeV2.REFUND && kind != NotificationTypeV2.REVOKE) return null;
        if (notice.getData() == null || notice.getData().getSignedTransactionInfo() == null) return null;
        try {
            return transaction(notice.getData().getSignedTransactionInfo()).getTransactionId();
        } catch (ApiError refused) {
            return null;
        }
    }
}
