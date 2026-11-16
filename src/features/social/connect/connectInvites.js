// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';

// "Connect" on someone nearby (docs/API.md, `connect.invite`): the one who invited shows
// their QR code, the other gets an invitation to accept and, accepting, scans it. The
// connection is still made by the token, in person: an invitation connects nobody.

// The Connect screen for an invitation: `mode` its tab, `with` the other's name,
// `invite` its id, `invited` on the phone of the one who accepted
const connectRoute = ({ mode, name, invite, invited }) => ({
  pathname: '/connect',
  params: { mode, with: name ?? '', invite: invite ?? '', ...(invited ? { invited: '1' } : {}) },
});

/**
 * Mounted with the RealtimeProvider (app/_layout.js): shows the invitations that arrive.
 */
export function ConnectListener() {
  const { send } = useRealtime();

  // One invitation on screen at a time; the others wait for the next "Connect"
  const showing = useRef(false);
  useRealtimeEvent('connect.invite', useCallback((invite) => {
    if (showing.current || !invite?.id) return;
    showing.current = true;
    const name = invite.from?.name || invite.from?.username || 'Someone';
    let answered = false;
    const answer = (accept) => {
      if (answered) return;
      answered = true;
      showing.current = false;
      send({ type: 'connect.answer', invite: invite.id, accept });
    };
    Alert.alert(
      `${name} wants to connect`,
      `Scan the code on ${name}'s phone to connect.`,
      [
        { text: 'Not now', style: 'cancel', onPress: () => answer(false) },
        {
          text: 'Connect',
          isPreferred: true,
          onPress: () => {
            answer(true);
            router.push(connectRoute({ mode: 'scan', name, invite: invite.id, invited: true }));
          },
        },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    );
  }, [send]));

  return null;
}

/**
 * connectWith({ id, name }): invites someone nearby and opens the Connect screen on the
 * user's code. Answers 'already' when they are connected already;
 * when the invitation cannot be sent (they do not see the user on the map now, no
 * network) the usual Connect screen opens, where the two choose.
 */
export function useConnectInvite() {
  const { request } = useRealtime();
  return useCallback(async ({ id, name }) => {
    try {
      const sent = await request({ type: 'connect.invite', to: id });
      router.push(connectRoute({ mode: 'qr', name, invite: sent.invite }));
      return null;
    } catch (error) {
      if (error?.code === 'already') return 'already';
      router.push('/connect');
      return null;
    }
  }, [request]);
}
