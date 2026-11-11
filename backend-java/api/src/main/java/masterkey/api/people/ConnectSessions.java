// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import masterkey.core.Ids;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Connecting in person (API.md, Connecting in person; CONNECT-PROTOCOL.md): a session of the one who
 * shows their code, and codes that last 10 s. In memory on one machine (§8: with more, Valkey
 * behind the same methods). An account deleted takes its sessions and codes with it at once.
 */
public final class ConnectSessions {

    static final Duration TOKEN_TTL = Duration.ofSeconds(10);
    static final Duration SESSION_KEPT = Duration.ofHours(1);

    /** {@code location}: what the host's phone sent, used for the distance check only, never stored elsewhere. */
    static final class Session {
        final UUID host;
        final Instant created;
        volatile String status = "waiting";
        volatile @Nullable UUID guest;
        volatile @Nullable JsonNode location;

        Session(UUID host, Instant created) {
            this.host = host;
            this.created = created;
        }

        @Override
        public String toString() {
            return "Session[…]";
        }
    }

    record Token(String session, Instant expires) {
        @Override
        public String toString() {
            return "Token[…]";
        }
    }

    record Issued(String token, Instant expires) {
        @Override
        public String toString() {
            return "Issued[…]";
        }
    }

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, Token> tokens = new ConcurrentHashMap<>();
    private final InstantSource clock;

    public ConnectSessions(InstantSource clock) {
        this.clock = clock;
    }

    String open(UUID host) {
        sweep();
        String id = "cs_" + Ids.secret(16);
        sessions.put(id, new Session(host, clock.instant()));
        return id;
    }

    @Nullable Session own(String id, UUID host) {
        Session session = sessions.get(id);
        return session != null && session.host.equals(host) ? session : null;
    }

    /** A new code: 18 random bytes, 24 characters of base64url without padding (§11, the QR). */
    Issued issue(String session, @Nullable JsonNode location) {
        Session found = sessions.get(session);
        if (found != null) found.location = location;
        String token = Ids.secret(18);
        Instant expires = clock.instant().plus(TOKEN_TTL);
        tokens.put(token, new Token(session, expires));
        return new Issued(token, expires);
    }

    /** The code, once: taken whatever happens next. */
    @Nullable Token take(String token) {
        return tokens.remove(token);
    }

    @Nullable Session session(String id) {
        return sessions.get(id);
    }

    void close(String id) {
        Session session = sessions.get(id);
        if (session != null && "waiting".equals(session.status)) session.status = "closed";
        tokens.values().removeIf(token -> token.session.equals(id));
    }

    void connected(String id, UUID guest) {
        Session session = sessions.get(id);
        if (session != null) {
            session.status = "connected";
            session.guest = guest;
        }
        tokens.values().removeIf(token -> token.session.equals(id));
    }

    /** DELETE /me: a code still valid would connect to an account that no longer exists. */
    public void forget(UUID user) {
        sessions.entrySet().removeIf(entry -> {
            boolean theirs = entry.getValue().host.equals(user) || user.equals(entry.getValue().guest);
            if (theirs) tokens.values().removeIf(token -> token.session.equals(entry.getKey()));
            return theirs;
        });
    }

    void sweep() {
        Instant now = clock.instant();
        tokens.values().removeIf(token -> token.expires.isBefore(now));
        sessions.values().removeIf(session -> session.created.plus(SESSION_KEPT).isBefore(now));
    }
}
