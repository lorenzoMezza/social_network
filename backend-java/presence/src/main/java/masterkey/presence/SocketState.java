// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * One socket of a person. The view is per user, but what the phone already knows is per
 * socket: the app forgets names at each {@code ready}, so the {@code user} goes again on a new
 * connection, and a socket gets deltas only after its snapshot.
 */
final class SocketState {

    final SocketId id;
    final Person person;
    final long opened;
    boolean started;
    /** How many people see the user, as last told on this socket; -1: not told. */
    int audienceTold = -1;
    /** Person → the version of their UserSummary this socket received. */
    final Map<UUID, Integer> known = new HashMap<>();

    SocketState(SocketId id, Person person, long opened) {
        this.id = id;
        this.person = person;
        this.opened = opened;
    }

    @Override
    public String toString() {
        return "SocketState[" + id + "]";
    }
}
