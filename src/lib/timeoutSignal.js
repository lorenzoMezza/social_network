// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// An abort signal that fires after `ms`, or as soon as `signal` (the caller's, if any)
// does. React Native has no AbortSignal.timeout nor AbortSignal.any, so a request
// without this would wait forever on a network that never answers. Call `clear()`
// once the request is over.
export function timeoutSignal(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    // Whether it was the time that ran out (not the caller that gave up)
    timedOut: () => controller.signal.aborted && !signal?.aborted,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    },
  };
}
