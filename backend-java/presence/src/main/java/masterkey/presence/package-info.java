// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The presence service (JAVA-BACKEND.md §4): who sees whom on the map, with each person's
 * 25 kept in memory and only their changes delivered. One thread owns every index and pair;
 * the rest of the server talks to it through {@link masterkey.presence.Presence}.
 */
@NullMarked
package masterkey.presence;

import org.jspecify.annotations.NullMarked;
