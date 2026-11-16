// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.time.Instant;
import masterkey.core.ApiError;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;

/**
 * The text of the frames the presence writes. The records of the people on the map are built
 * by hand, once per change, and their bytes copied to every viewer; the rare frames (an ack,
 * a gesture) go through Jackson, which escapes what users wrote.
 */
final class Wire {

    private Wire() {
    }

    /** Degrees in millionths ({@code round(x, 6)}) as a JSON number. */
    static void micro(StringBuilder out, long millionths) {
        decimal(out, millionths, 1_000_000, 6);
    }

    /** Tenths ({@code round(x, 1)}) as a JSON number. */
    static void tenths(StringBuilder out, long tenths) {
        decimal(out, tenths, 10, 1);
    }

    private static void decimal(StringBuilder out, long value, long unit, int digits) {
        if (value < 0) {
            out.append('-');
            value = -value;
        }
        out.append(value / unit);
        long fraction = value % unit;
        if (fraction == 0) return;
        String text = Long.toString(fraction);
        out.append('.');
        for (int i = text.length(); i < digits; i++) out.append('0');
        int end = text.length();
        while (end > 1 && text.charAt(end - 1) == '0') end--;
        out.append(text, 0, end);
    }

    static String time(Instant at) {
        return Json.time(at);
    }

    static String quote(String text) {
        return Json.text(text);
    }

    /** {@code {type:"ack", ref, …}}: {@code fields} is empty or starts with a comma. */
    static String ack(@Nullable String ref, String fields) {
        return "{\"type\":\"ack\",\"ref\":" + (ref == null ? "null" : ref) + fields + "}";
    }

    static String error(@Nullable String ref, ApiError error) {
        String message = error.getMessage();
        return "{\"type\":\"error\",\"ref\":" + (ref == null ? "null" : ref)
                + ",\"code\":" + quote(error.code())
                + ",\"message\":" + quote(message == null ? error.code() : message) + "}";
    }
}
