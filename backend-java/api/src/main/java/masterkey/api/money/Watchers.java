// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.money;

import java.util.UUID;

/** Who must hear that an event's reach changed (a promotion resumed by a top-up): the events' notifier. */
@FunctionalInterface
public interface Watchers {

    /** After the transaction commits: the event to whoever sees it now, and to who saw it within {@code alsoWithin} metres. */
    void reachChanged(UUID event, int alsoWithin);
}
