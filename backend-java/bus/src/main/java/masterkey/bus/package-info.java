// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The bus between the roles (JAVA-BACKEND.md §6, Consegna): fire and forget, at most once,
 * like core NATS. What must not get lost (a block, a charge) never relies on it alone: it
 * starts from a db-scheduler task written in the same transaction, repeated until confirmed.
 */
@NullMarked
package masterkey.bus;

import org.jspecify.annotations.NullMarked;
