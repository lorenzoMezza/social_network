// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import org.jspecify.annotations.Nullable;

/**
 * What a file really is, from its first bytes, before anything opens it (§19, Cosa fa imaged, 1):
 * JPEG, PNG, WebP or HEIC; anything else is refused whatever its name or its Content-Type.
 */
public final class Sniff {

    private Sniff() {
    }

    public static @Nullable String format(byte[] head) {
        if (head.length >= 3 && (head[0] & 0xff) == 0xFF && (head[1] & 0xff) == 0xD8 && (head[2] & 0xff) == 0xFF) return "jpeg";
        if (head.length >= 8 && (head[0] & 0xff) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G'
                && head[4] == 0x0D && head[5] == 0x0A && head[6] == 0x1A && head[7] == 0x0A) return "png";
        if (head.length >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') return "webp";
        if (head.length >= 12 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') {
            String brand = new String(head, 8, 4, java.nio.charset.StandardCharsets.US_ASCII);
            if (brand.equals("heic") || brand.equals("heix") || brand.equals("hevc") || brand.equals("mif1")) return "heic";
        }
        return null;
    }
}
