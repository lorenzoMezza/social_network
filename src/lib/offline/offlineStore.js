// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { AppState } from 'react-native';
import { CACHE_BUDGETS } from '../../../webview/shared/cacheBudgets';
import { createDiskCache, hashKey } from './diskCache';
import { fileSystem } from './fileSystem';

// What the app keeps on the phone for the signed-in account, so its pages show at
// once and work without a connection (each provider fills its own cache and shows it
// while the server answers):
//   people  profiles, avatar documents, pictures (social/, profile/, avatar/)
//   events  the events' summaries and details, their pictures (events/)
//   chats   the inbox, messages, members, the messages waiting to be sent (social/)
// Limits: webview/shared/cacheBudgets.js. One folder per account: signing out deletes
// them all (accountStorage.js), so the next person on the phone sees nothing of it.
// Whatever was shown from here is checked with the server as soon as it can be: a
// cache shows the last known state, never a decision (who can be messaged, the
// avatar someone wears now: the server's answers replace it).

const KINDS = ['people', 'events', 'chats'];
let current = null; // { accountId, caches }

// The caches of this account (opened the first time they are asked for)
export function offlineFor(accountId) {
  if (!accountId) return null;
  if (current?.accountId !== accountId) {
    const folder = hashKey(accountId);
    current = {
      accountId,
      caches: Object.fromEntries(KINDS.map((kind) => [kind, createDiskCache({
        dir: `${folder}/${kind}`,
        maxBytes: CACHE_BUDGETS[kind],
        fs: fileSystem,
        label: `Offline ${kind}`,
      })])),
    };
  }
  return current.caches;
}

// Every account's data deleted (sign-out)
export async function forgetOfflineData() {
  const open = current;
  current = null;
  if (open) await Promise.all(Object.values(open.caches).map((cache) => cache.clear()));
  await fileSystem.removeDir('').catch(() => {});
}

// What is waiting goes to storage before the app may be stopped in the background
AppState.addEventListener?.('change', (state) => {
  if (state !== 'active' && current) for (const cache of Object.values(current.caches)) cache.flush().catch(() => {});
});
