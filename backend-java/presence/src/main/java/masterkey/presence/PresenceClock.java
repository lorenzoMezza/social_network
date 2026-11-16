// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.time.Instant;

/**
 * The two times of the presence: {@code nanos} for durations (TTL, cooldowns, the round),
 * which never jumps; {@code instant} for what goes on the wire ({@code updatedAt}, {@code at})
 * and for the UTC day of the area points. Tests move both by hand.
 */
public interface PresenceClock {

    long nanos();

    Instant instant();

    static PresenceClock system() {
        return new PresenceClock() {
            @Override
            public long nanos() {
                return System.nanoTime();
            }

            @Override
            public Instant instant() {
                return Instant.now();
            }
        };
    }
}
