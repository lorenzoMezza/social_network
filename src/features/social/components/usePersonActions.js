// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { successFeedback } from '../../../lib/haptics';
import { useSocial } from '../state/SocialProvider';

// What the user can do about another person (`person`: a UserSummary), with the
// confirmations social apps ask for: disconnect (no more messages until they connect
// again in person), block (no contact at all, they are hidden), report (to the
// moderators). Returns the ActionSheet props and a function to open it.
export function usePersonActions(person) {
  const { isConnection, isBlocked, disconnect, block, unblock } = useSocial();
  const [visible, setVisible] = useState(false);
  const userId = person?.id ?? null;
  const shown = person?.name || (person?.username ? `@${person.username}` : 'them');

  const run = useCallback((action, failure) => {
    action(userId)
      .then(() => successFeedback())
      .catch(() => Alert.alert(failure, 'Try again in a moment.'));
  }, [userId]);

  const confirmDisconnect = useCallback(() => {
    Alert.alert(`Disconnect from ${shown}?`, 'You will not be able to message each other until you connect again in person. They are not told.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => run(disconnect, 'Could not disconnect') },
    ]);
  }, [disconnect, run, shown]);

  const confirmBlock = useCallback(() => {
    Alert.alert(`Block ${shown}?`, 'They will not be able to find you nearby, message you or connect with you. Your connection ends. They are not told. You can unblock them in Settings.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => run(block, 'Could not block') },
    ]);
  }, [block, run, shown]);

  const items = useMemo(() => {
    if (!userId) return [];
    const list = [];
    if (isConnection(userId)) list.push({ label: 'Disconnect', icon: 'unlink-outline', onPress: confirmDisconnect });
    if (isBlocked(userId)) list.push({ label: 'Unblock', icon: 'lock-open-outline', onPress: () => run(unblock, 'Could not unblock') });
    else list.push({ label: 'Block', icon: 'hand-left-outline', onPress: confirmBlock, destructive: true });
    list.push({
      label: 'Report',
      icon: 'flag-outline',
      onPress: () => router.push({ pathname: '/report-user', params: { id: userId, username: person?.username ?? '', name: person?.name ?? '' } }),
      destructive: true,
    });
    return list;
  }, [userId, person, isConnection, isBlocked, unblock, run, confirmDisconnect, confirmBlock]);

  return {
    open: () => setVisible(true),
    sheet: { visible, onClose: () => setVisible(false), title: shown, items },
  };
}
