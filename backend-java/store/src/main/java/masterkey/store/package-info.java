// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The database (JAVA-BACKEND.md §7): the Flyway migrations are the source of truth of the
 * schema, jOOQ's classes are made from them ({@code masterkey.store.db}, generated), and
 * {@link masterkey.store.Database} runs the transactions.
 */
@NullMarked
package masterkey.store;

import org.jspecify.annotations.NullMarked;
