// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The REST of {@code docs/API.md}, with Spring MVC on virtual threads. Request bodies are
 * read from {@code JsonNode} with {@link masterkey.core.Body}, never bound to records (§16);
 * answers are records written by {@link masterkey.core.Json#MAPPER}. Transactions go through
 * {@link masterkey.store.Database#tx}, frames and jobs after the commit.
 */
@NullMarked
package masterkey.api;

import org.jspecify.annotations.NullMarked;
