// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import org.jspecify.annotations.Nullable;

/** How someone is on the map (API.md, Presence rules): the less precise of two wins. */
public enum Mode {
    VISIBLE("visible"),
    APPROXIMATE("approximate"),
    INVISIBLE("invisible");

    private final String wire;

    Mode(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    public static @Nullable Mode of(@Nullable String wire) {
        if (wire == null) return null;
        for (Mode mode : values()) if (mode.wire.equals(wire)) return mode;
        return null;
    }
}
