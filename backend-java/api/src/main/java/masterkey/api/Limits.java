// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api;

import java.util.ArrayDeque;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import masterkey.core.ApiError;

/**
 * How often one user may do something (API.md, Rate limits; {@code limits.py}): a sliding
 * window per user and action. What a script could abuse is limited, what a person does is
 * never noticed. In memory on one machine; with more, the same interface over Valkey (§6).
 */
public final class Limits {

    /** action → times, seconds. */
    public enum Action {
        MESSAGE("message", 20, 10),
        DIRECT_CHAT("direct-chat", 30, 3600),
        EVENT("event", 20, 3600),
        UPLOAD("upload", 120, 3600),
        PICTURE("picture", 30, 3600),
        PURCHASE("purchase", 30, 3600),
        REPORT("report", 20, 3600),
        CONNECT_SESSION("connect-session", 10, 60),
        CONNECT_CLAIM("connect-claim", 10, 60),
        SAVE("save", 120, 60),
        CHAT_EDIT("chat-edit", 120, 3600),
        BLOCK("block", 60, 3600),
        CONNECT_TOKEN("connect-token", 30, 60),
        REQUESTS("requests", 3000, 60),
        PEOPLE("people", 600, 60),
        PROFILE("profile", 300, 3600),
        USERNAME("username", 5, 86400),
        EXPORT("export", 5, 3600),
        VOTE("vote", 30, 60),
        GROUP("group", 20, 3600),
        MEMBERS("members", 60, 3600),
        JOIN("join", 60, 60),
        RATING("rating", 30, 3600),
        EVENT_EDIT("event-edit", 120, 3600),
        AVATAR("avatar", 60, 3600);

        final String wire;
        final int times;
        final long windowNanos;

        Action(String wire, int times, long seconds) {
            this.wire = wire;
            this.times = times;
            this.windowNanos = seconds * 1_000_000_000L;
        }

        public String wire() {
            return wire;
        }

        public int times() {
            return times;
        }
    }

    private record Key(UUID user, Action action) {
    }

    private final Map<Key, ArrayDeque<Long>> hits = new ConcurrentHashMap<>();

    /** Counts one more, or 429 with Retry-After. */
    public void check(UUID user, Action action) {
        long now = System.nanoTime();
        ArrayDeque<Long> mine = hits.computeIfAbsent(new Key(user, action), key -> new ArrayDeque<>());
        synchronized (mine) {
            while (!mine.isEmpty() && mine.getFirst() <= now - action.windowNanos) mine.pollFirst();
            if (mine.size() >= action.times) {
                long wait = mine.getFirst() + action.windowNanos - now;
                throw ApiError.rateLimited(Math.max(1, (wait + 999_999_999L) / 1_000_000_000L));
            }
            mine.addLast(now);
        }
    }

    /** Forgets the windows that ran out (called now and then). */
    public void sweep() {
        long now = System.nanoTime();
        hits.entrySet().removeIf(entry -> {
            ArrayDeque<Long> mine = entry.getValue();
            synchronized (mine) {
                Long last = mine.peekLast();
                return last == null || last <= now - entry.getKey().action.windowNanos;
            }
        });
    }

    public void forget(UUID user) {
        hits.keySet().removeIf(key -> key.user.equals(user));
    }
}
