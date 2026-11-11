// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * What the presence asks outside itself (JAVA-BACKEND.md §5): it never touches the database
 * and never blocks its thread. Each answer comes back as a message to the presence thread.
 */
public interface Directory {

    /** The user's connections, and everyone with a block with them in either direction. */
    CompletableFuture<Relations> relations(UUID user);

    /** The user's UserSummary as JSON, and their avatar version. */
    CompletableFuture<Summary> summary(UUID user);

    /** A "Connect" invitation is also one of the invited person's notifications. */
    void connectInvited(UUID target, UUID actor);

    record Relations(Set<UUID> connections, Set<UUID> blocked) {
        public Relations {
            connections = Set.copyOf(connections);
            blocked = Set.copyOf(blocked);
        }
    }

    /** {@code json}: the UserSummary exactly as the REST answers carry it. */
    record Summary(String json, int avatarVersion) {
    }
}
