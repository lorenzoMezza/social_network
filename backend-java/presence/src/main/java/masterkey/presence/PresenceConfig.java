// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.time.Duration;

/**
 * The numbers of the presence (API.md, Presence rules; JAVA-BACKEND.md §4.6, §4.10), the
 * same as {@code realtime.py} and {@code position_guard.py}.
 *
 * <p>{@code areaKey}: the secret of the area points, stable across restarts (AREA_HMAC_KEY):
 * a random key per process would move every point at each restart, and averaging the points
 * would give the place away.
 */
public final class PresenceConfig {

    private final byte[] areaKey;
    final int maxShown;
    final double rangeMetres;
    final double shownAdvantage;
    final double areaCellMetres;
    final double areaJitterMetres;
    final long ttlNanos;
    final long roundNanos;
    final long rematchEveryNanos;
    final double rematchAfterMetres;
    final long pinnedNanos;
    final long pinDelayNanos;
    /** m/s: a plane, for the position guard (MAX_TRAVEL_SPEED_MPS). */
    final double maxTravelSpeed;
    final int frameQueue;
    final int maxSocketsPerUser;

    private PresenceConfig(byte[] areaKey, int maxShown, double maxTravelSpeed, Duration ttl) {
        if (areaKey.length < 32) throw new IllegalArgumentException("the area key needs 32 bytes at least");
        this.areaKey = areaKey.clone();
        this.maxShown = maxShown;
        this.rangeMetres = 1000;
        this.shownAdvantage = 0.85;
        this.areaCellMetres = 300;
        this.areaJitterMetres = 100;
        this.ttlNanos = ttl.toNanos();
        this.roundNanos = Duration.ofMillis(500).toNanos();
        this.rematchEveryNanos = Duration.ofSeconds(5).toNanos();
        this.rematchAfterMetres = 25;
        this.pinnedNanos = Duration.ofSeconds(60).toNanos();
        this.pinDelayNanos = Duration.ofMillis(300).toNanos();
        this.maxTravelSpeed = maxTravelSpeed;
        // About 2 s of traffic: a frame a second from each of 25.000 phones on the map
        this.frameQueue = 50_000;
        this.maxSocketsPerUser = 5;
    }

    public static PresenceConfig of(byte[] areaKey, double maxTravelSpeed) {
        return new PresenceConfig(areaKey, 25, maxTravelSpeed, Duration.ofSeconds(45));
    }

    /** For tests: fewer people on a map, to see the cap with a small crowd. */
    public PresenceConfig withMaxShown(int value) {
        return new PresenceConfig(areaKey, value, maxTravelSpeed, Duration.ofNanos(ttlNanos));
    }

    byte[] areaKey() {
        return areaKey.clone();
    }

    @Override
    public String toString() {
        return "PresenceConfig[maxShown=" + maxShown + ", range=" + rangeMetres + "]";
    }
}
