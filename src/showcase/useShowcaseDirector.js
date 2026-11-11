// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Showcase mode only (EXPO_PUBLIC_SHOWCASE=1, show-case/tools/ready.sh): the map page takes
// scripts from the director on the computer (show-case/tools/director.mjs, port 8095),
// to stage a recording: test crowds and events, the hour of the day, camera moves.
// Without the setting this hook does nothing.
import { useEffect } from 'react';
import { API_URL } from '../features/api/apiConfig';

export const SHOWCASE = process.env.EXPO_PUBLIC_SHOWCASE === '1';
// (on the computer running the backend; the web demo, whose backend is in the browser, has none)
const DIRECTOR = SHOWCASE && /:\d+\/v1$/.test(API_URL ?? '') ? API_URL.replace(/:\d+\/v1$/, ':8095') : null;

export function useShowcaseDirector(run) {
  useEffect(() => {
    if (!DIRECTOR) return undefined;
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const answer = await fetch(`${DIRECTOR}/next`, { signal: AbortSignal.timeout(2000) });
        const script = answer.ok ? await answer.text() : '';
        if (script) run(script);
      } catch {
        // No director running: asked again
      }
      if (alive) timer = setTimeout(poll, 200);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [run]);
}
