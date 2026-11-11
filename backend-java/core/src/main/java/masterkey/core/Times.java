// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import org.jspecify.annotations.Nullable;

/** Times in and out of the API: ISO 8601 in UTC with milliseconds (API.md, Conventions). */
public final class Times {

    public static final long SECOND = 1000;
    public static final long MINUTE = 60 * SECOND;
    public static final long HOUR = 60 * MINUTE;
    public static final long DAY = 24 * HOUR;

    private Times() {
    }

    public static @Nullable String iso(@Nullable Instant instant) {
        return instant == null ? null : Json.time(instant);
    }

    /**
     * A time sent by the app, with its offset ({@code Z} or {@code +02:00}); anything else is
     * a 400. Cut to milliseconds, as everything the server keeps.
     */
    public static Instant parse(String value, String field) {
        try {
            Instant at = OffsetDateTime.parse(value).toInstant();
            return Instant.ofEpochMilli(at.toEpochMilli());
        } catch (DateTimeParseException e) {
            throw ApiError.badRequest(field + ": an ISO 8601 time with its offset is needed");
        }
    }

    /** Milliseconds, as Postgres keeps them only to the microsecond and the app to the ms. */
    public static Instant ms(Instant at) {
        return Instant.ofEpochMilli(at.toEpochMilli());
    }
}
