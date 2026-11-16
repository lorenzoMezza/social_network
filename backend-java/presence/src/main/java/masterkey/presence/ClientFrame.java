// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * The frames a phone sends that the presence handles, read and checked by the gateway
 * (API.md, WebSocket). A closed set: a switch without default does not compile when one is
 * missing.
 */
public sealed interface ClientFrame {

    /**
     * The {@code ref} the phone gave, as JSON text ({@code "\"a1\""}, {@code "7"}), echoed as
     * it is in the {@code ack} or {@code error}; null when there was none.
     */
    @Nullable String ref();

    /**
     * {@code position} null: the user leaves the map (or is invisible). Numbers a phone may
     * not say (a heading of 10^300) are already null here: they would reach other phones.
     */
    record PresenceUpdate(@Nullable String ref, Mode mode, @Nullable Position position) implements ClientFrame {
    }

    record Position(double latitude, double longitude, @Nullable Double accuracy, @Nullable Double heading,
                    @Nullable Double speed, @Nullable Boolean moving) {
        @Override
        public String toString() {
            return "Position[…]";
        }
    }

    record Gesture(@Nullable String ref, UUID to, String gesture) implements ClientFrame {
    }

    record Broadcast(@Nullable String ref, String text) implements ClientFrame {
        @Override
        public String toString() {
            return "Broadcast[…]";
        }
    }

    record ConnectInvite(@Nullable String ref, UUID to) implements ClientFrame {
    }

    record ConnectAnswer(@Nullable String ref, String invite, boolean accept) implements ClientFrame {
    }
}
