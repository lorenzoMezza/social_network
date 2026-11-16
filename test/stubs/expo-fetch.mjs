// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// expo/fetch: the global fetch, replaceable by a test (globalThis.fetch)
export const fetch = (...args) => globalThis.fetch(...args);
