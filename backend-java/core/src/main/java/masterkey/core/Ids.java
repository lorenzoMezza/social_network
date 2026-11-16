// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import java.nio.ByteBuffer;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Identifiers (JAVA-BACKEND.md §7.2). In the tables: UUID version 7 made here with
 * {@link SecureRandom} (74 random bits; Postgres's {@code uuidv7()} gives 62, below the 72
 * the contract asks). Towards the app: a type prefix and the 16 bytes in base64url
 * ({@code ev_AaGoiVCMeXe_JMQn9ho_vQ}), opaque. Users are the exception: their UUID is random
 * through and through (version 4), so a public id never tells how old an account is.
 * Anything malformed is "not found", like everything that does not exist (§20).
 */
public final class Ids {

    static final SecureRandom RANDOM = new SecureRandom();
    static final Pattern BODY = Pattern.compile("[A-Za-z0-9_-]{22}");

    private Ids() {
    }

    /** Version 7: 48 bits of time, 74 random. */
    public static UUID next() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        long ms = System.currentTimeMillis();
        for (int i = 0; i < 6; i++) b[i] = (byte) (ms >>> (40 - 8 * i));
        b[6] = (byte) ((b[6] & 0x0f) | 0x70);
        b[8] = (byte) ((b[8] & 0x3f) | 0x80);
        ByteBuffer x = ByteBuffer.wrap(b);
        return new UUID(x.getLong(), x.getLong());
    }

    /** Version 4: all random (122 bits), for users. */
    public static UUID random() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        b[6] = (byte) ((b[6] & 0x0f) | 0x40);
        b[8] = (byte) ((b[8] & 0x3f) | 0x80);
        ByteBuffer x = ByteBuffer.wrap(b);
        return new UUID(x.getLong(), x.getLong());
    }

    public static String publicId(String prefix, UUID id) {
        byte[] b = ByteBuffer.allocate(16).putLong(id.getMostSignificantBits()).putLong(id.getLeastSignificantBits()).array();
        return prefix + "_" + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** The UUID of a public id of this type, or empty: then the answer is 404. */
    public static Optional<UUID> parse(String prefix, String s) {
        if (!s.startsWith(prefix + "_")) return Optional.empty();
        String body = s.substring(prefix.length() + 1);
        if (!BODY.matcher(body).matches()) return Optional.empty();
        ByteBuffer x;
        try {
            x = ByteBuffer.wrap(Base64.getUrlDecoder().decode(body));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        UUID id = new UUID(x.getLong(), x.getLong());
        return publicId(prefix, id).equals(s) ? Optional.of(id) : Optional.empty();   // only the canonical form
    }

    /** The UUID of a public id, or a 404. */
    public static UUID require(String prefix, String s, String what) {
        return parse(prefix, s).orElseThrow(() -> ApiError.notFound(what + " not found"));
    }

    /** A secret: {@code bytes} random bytes in base64url without padding (tokens, keys). */
    public static String secret(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    public static int randomInt(int bound) {
        return RANDOM.nextInt(bound);
    }

    /**
     * The order of Postgres for uuid (bytes, unsigned): {@code UUID.compareTo} compares signed
     * longs and disagrees with it, which would break a {@code CHECK (a < b)}.
     */
    public static int compare(UUID a, UUID b) {
        int high = Long.compareUnsigned(a.getMostSignificantBits(), b.getMostSignificantBits());
        return high != 0 ? high : Long.compareUnsigned(a.getLeastSignificantBits(), b.getLeastSignificantBits());
    }

    /** The two ids of a pair, the lower first (tables with {@code CHECK (a < b)}). */
    public static UUID low(UUID a, UUID b) {
        return compare(a, b) <= 0 ? a : b;
    }

    public static UUID high(UUID a, UUID b) {
        return compare(a, b) <= 0 ? b : a;
    }
}
