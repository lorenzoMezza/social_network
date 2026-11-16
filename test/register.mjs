// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Runs the app's pure modules under Node's test runner (`make test`): relative imports
// without an extension resolve to .js (as Metro does), and native modules (expo,
// react-native…) resolve to small stubs in test/stubs, so models, API clients and the
// motion fusion are tested without a phone.
import { registerHooks } from 'node:module';
import { resolve } from './resolve.mjs';

registerHooks({ resolve });

// As in a release build: no development server (src/lib/devHost.js)
globalThis.__DEV__ = false;
