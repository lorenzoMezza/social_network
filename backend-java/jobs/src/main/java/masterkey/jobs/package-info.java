// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The jobs (JAVA-BACKEND.md §6 and §8, Lavori asincroni): db-scheduler on Postgres. The
 * recurring ones run once per schedule whatever the number of machines; every job can run twice
 * (a machine falling halfway) and changes nothing the second time: what was done is written on
 * the rows ({@code starting_notified_for}, {@code chat_closed_at}, {@code chat_purged_at}) or read
 * again under lock (money, §7.3).
 */
@NullMarked
package masterkey.jobs;

import org.jspecify.annotations.NullMarked;
