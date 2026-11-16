// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * Money (API.md, Promotions; PROMOTIONS.md; {@code promotions.py}, {@code stores.py}): the
 * promotions of events, the wallet of credits and its ledger, the store purchases checked
 * with the stores. It knows the tables, never the routes of events: those use it.
 *
 * <p>Locks are always taken in this order, so that two transactions never wait for each other:
 * the person (advisory), the event, the promotion, the wallet last.
 */
@NullMarked
package masterkey.api.money;

import org.jspecify.annotations.NullMarked;
