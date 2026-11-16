// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import masterkey.core.ApiError;

/**
 * How often one user may do something, over a sliding window (as {@code limits.py}). Kept in
 * the presence for what only the presence does (gestures, invitations), by user and not by
 * socket: reconnecting does not reset it.
 */
final class RateWindow {

    private final int times;
    private final long windowNanos;
    private final Map<UUID, ArrayDeque<Long>> hits = new HashMap<>();

    RateWindow(int times, long windowNanos) {
        this.times = times;
        this.windowNanos = windowNanos;
    }

    /** Counts one more, or answers 429 with how long to wait. */
    void check(UUID user, long now) {
        ArrayDeque<Long> mine = hits.computeIfAbsent(user, key -> new ArrayDeque<>());
        while (!mine.isEmpty() && mine.peekFirst() <= now - windowNanos) mine.pollFirst();
        if (mine.size() >= times) {
            long first = mine.getFirst();
            throw ApiError.rateLimited((first + windowNanos - now + 999_999_999L) / 1_000_000_000L);
        }
        mine.addLast(now);
    }

    void forget(UUID user) {
        hits.remove(user);
    }

    void sweep(long now) {
        for (Iterator<ArrayDeque<Long>> it = hits.values().iterator(); it.hasNext(); ) {
            ArrayDeque<Long> mine = it.next();
            Long last = mine.peekLast();
            if (last == null || last <= now - windowNanos) it.remove();
        }
    }
}
