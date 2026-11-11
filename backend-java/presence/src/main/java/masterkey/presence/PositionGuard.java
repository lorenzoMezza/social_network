// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import masterkey.core.Geo;

/**
 * Whether the position a phone claims is physically possible for this user, as
 * {@code position_guard.py}: a point farther from the last one than a plane could have flown
 * meanwhile is refused. It stops jumps across the world, not a cheat of a few kilometres.
 *
 * <p>What is kept, in memory only: one point per user rounded to about 1 km, and when, for
 * 16 hours at most. Never a history, never on disk (conservazione-dati.md).
 */
final class PositionGuard {

    /** Margin for a first bad fix, the rounding of the point and a jump indoors. */
    static final double SLACK_METRES = 2000;
    /** The point moves on only this often: else a cheat would hop SLACK_METRES at a time. */
    static final long ANCHOR_NANOS = 60L * 1_000_000_000L;
    /** After this long anywhere on Earth is reachable: nothing left to compare. */
    static final long KEEP_NANOS = 16L * 3600 * 1_000_000_000L;

    private record Anchor(double latitude, double longitude, long at) {
        @Override
        public String toString() {
            return "Anchor[…]";
        }
    }

    private final double maxSpeed;
    private final Map<UUID, Anchor> anchors = new HashMap<>();

    PositionGuard(double maxSpeed) {
        this.maxSpeed = maxSpeed;
    }

    /** Whether the user can be there now; remembers the position when they can. */
    boolean plausible(UUID user, double latitude, double longitude, long now) {
        Anchor anchor = anchors.get(user);
        if (anchor != null && now - anchor.at < KEEP_NANOS) {
            double seconds = (now - anchor.at) / 1e9;
            double reachable = SLACK_METRES + maxSpeed * seconds;
            if (Geo.distance(anchor.latitude, anchor.longitude, latitude, longitude) > reachable) return false;
            if (now - anchor.at < ANCHOR_NANOS) return true;
        }
        anchors.put(user, new Anchor(round2(latitude), round2(longitude), now));
        return true;
    }

    void forget(UUID user) {
        anchors.remove(user);
    }

    void sweep(long now) {
        for (Iterator<Anchor> it = anchors.values().iterator(); it.hasNext(); ) {
            if (now - it.next().at >= KEEP_NANOS) it.remove();
        }
    }

    int size() {
        return anchors.size();
    }

    static double round2(double value) {
        return Math.round(value * 100) / 100.0;
    }
}
