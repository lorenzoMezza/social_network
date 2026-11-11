// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Whether the phone is online (features/api/networkStatus.js): one native listener for
// the whole app, and the changes its subscribers hear (a recovery: offline → online)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { networkStatus, subscribeNetwork } from '../src/features/api/networkStatus.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const offline = { isConnected: false, isInternetReachable: false };
const online = { isConnected: true, isInternetReachable: true };

describe('network status', () => {
  it('opens one native listener however many subscribe, and closes it with the last', async () => {
    const stop = [subscribeNetwork(() => {}), subscribeNetwork(() => {}), subscribeNetwork(() => {})];
    assert.equal(globalThis.__network.listeners.size, 1);
    stop.forEach((unsubscribe) => unsubscribe());
    assert.equal(globalThis.__network.listeners.size, 0);
    assert.equal(networkStatus(), 'unknown');
  });

  it('tells a recovery only after being offline, once per change', async () => {
    const heard = [];
    const unsubscribe = subscribeNetwork((next, previous) => heard.push(`${previous}→${next}`));
    await tick(); // the first reading: online
    globalThis.__network.set(online); // the same again: nothing new
    globalThis.__network.set(offline);
    globalThis.__network.set({ isConnected: true, isInternetReachable: null }); // connected, not known to reach: online
    unsubscribe();
    assert.deepEqual(heard, ['unknown→online', 'online→offline', 'offline→online']);
  });

  it('keeps what it knows when a reading says nothing', async () => {
    const heard = [];
    const unsubscribe = subscribeNetwork((next) => heard.push(next));
    await tick();
    globalThis.__network.set({ isConnected: null, isInternetReachable: null });
    assert.equal(networkStatus(), 'online');
    unsubscribe();
    assert.deepEqual(heard, ['online']);
  });
});
