// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogto } from '@logto/rn';
import { useApi } from '../../api/useApi';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { normalizeEvent } from '../../events/api/eventsApi';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';

// The user's notifications (docs/API.md, Notifications): the list and how many are
// unread, loaded at sign-in and kept current over the socket (`notification`: a new
// one, or one that gathered more). Opening the panel marks them read.

const NotificationsContext = createContext(null);

const normalize = (item) => ({ ...item, actors: item.actors ?? [], event: item.event ? normalizeEvent(item.event) : null });

export function NotificationsProvider({ children }) {
  const { isAuthenticated } = useLogto();
  const request = useApi();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  // The panel is on screen: what arrives is seen at once, so it is never counted as new
  const panelOpen = useRef(false);
  const readTimer = useRef(null);
  const tellRead = useCallback(() => {
    clearTimeout(readTimer.current);
    // A moment later, once: several can arrive together
    readTimer.current = setTimeout(() => {
      request('/me/notifications/read', { method: 'POST' }).catch(() => {
        // Marked again the next time
      });
    }, 1000);
  }, [request]);
  useEffect(() => () => clearTimeout(readTimer.current), []);

  // One per sign-in: an answer asked for by the account before never shows to the next one
  const session = useRef(0);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    const started = session.current;
    try {
      const answer = await request('/me/notifications', { revalidate: true });
      if (started !== session.current) return;
      setItems((answer?.items ?? []).map(normalize));
      setUnread(panelOpen.current ? 0 : answer?.unread ?? 0);
      if (panelOpen.current && answer?.unread) tellRead();
      setStatus('ready');
      setError(null);
    } catch (failure) {
      if (started !== session.current) return;
      setError(failure);
      setStatus((current) => (current === 'ready' ? current : 'error'));
    }
  }, [isAuthenticated, request, tellRead]);

  useEffect(() => {
    session.current++;
    if (!isAuthenticated) return undefined;
    let alive = true;
    request('/me/notifications', { revalidate: true }).then((answer) => {
      if (!alive) return;
      setItems((answer?.items ?? []).map(normalize));
      setUnread(answer?.unread ?? 0);
      setStatus('ready');
    }).catch((failure) => {
      if (!alive) return;
      setError(failure);
      setStatus('error');
    });
    return () => {
      alive = false;
      // The counter as it is now, on purpose: it only ever moves on
      // eslint-disable-next-line react-hooks/exhaustive-deps
      session.current++;
      // Signed out: the next user never sees these
      setItems([]);
      setUnread(0);
      setStatus('idle');
      setError(null);
    };
  }, [isAuthenticated, request]);
  useNetworkRecovery(refresh);
  // The socket is closed in the background, and what happened meanwhile is not sent again:
  // back in front (or reconnected), the list is asked for
  const { status: socketStatus } = useRealtime();
  const socketOpened = useRef(false);
  useEffect(() => {
    if (socketStatus !== 'open') return;
    if (socketOpened.current) refresh();
    socketOpened.current = true;
  }, [socketStatus, refresh]);

  useRealtimeEvent('notification', useCallback((frame) => {
    if (!frame.notification) return;
    const next = normalize(frame.notification);
    setItems((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    if (panelOpen.current) {
      // Read as it arrives: no badge on the tab for what the user is looking at (its dot
      // in the list stays until the panel closes, as for the others)
      setUnread(0);
      tellRead();
    } else {
      setUnread(frame.unread ?? 0);
    }
  }, [tellRead]));

  // Seen: the count goes, the dots stay until the panel is opened again
  const markRead = useCallback(async () => {
    setUnread(0);
    try {
      await request('/me/notifications/read', { method: 'POST' });
    } catch {
      // Marked again the next time
    }
  }, [request]);
  const setPanelOpen = useCallback((open) => {
    panelOpen.current = open;
  }, []);
  const settle = useCallback(() => setItems((current) => current.map((item) => (item.read ? item : { ...item, read: true }))), []);

  const value = useMemo(() => ({ items, unread, status, error, refresh, markRead, settle, setPanelOpen }), [items, unread, status, error, refresh, markRead, settle, setPanelOpen]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const context = use(NotificationsContext);
  if (!context) throw new Error('useNotifications must be used inside <NotificationsProvider>');
  return context;
}
