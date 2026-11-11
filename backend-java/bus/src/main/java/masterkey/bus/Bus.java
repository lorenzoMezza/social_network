// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.bus;

import java.util.UUID;

/**
 * Messages between the roles by subject. {@code publish} never blocks the caller for long
 * and never throws for a missing listener: a frame for a user nobody has a socket for is
 * simply nobody's. The payload is never a position (JAVA-BACKEND.md §3).
 */
public interface Bus {

    void publish(String subject, byte[] payload);

    /** Everything published under the prefix ({@code "u."}); closing it stops the deliveries. */
    Subscription subscribe(String prefix, Listener listener);

    interface Listener {
        /** Called on a thread of the bus: it must not block, only hand the message on. */
        void message(String subject, byte[] payload);
    }

    interface Subscription extends AutoCloseable {
        @Override
        void close();
    }

    /** A frame for the sockets of one user (API.md, Server → client), wherever they are. */
    static String user(UUID user) {
        return "u." + user;
    }

    /** The user of a {@link #user} subject. */
    static UUID userOf(String subject) {
        return UUID.fromString(subject.substring(2));
    }
}
