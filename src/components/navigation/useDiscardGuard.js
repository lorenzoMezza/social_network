// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { usePreventRemove } from 'expo-router';

// A form with unsaved changes does not disappear on its own: leaving it any way at all
// (Cancel, swiping the sheet down, Android's back) asks first; a sheet being swiped
// springs back while it asks. Returns the function to call right before leaving after a
// save, which has nothing to ask about.
export function useDiscardGuard(dirty) {
  const [leaving, setLeaving] = useState(false);
  const stopGuarding = usePreventRemove(dirty && !leaving, ({ repeat }) => {
    Alert.alert('Discard changes?', 'What you entered will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          setLeaving(true);
          repeat();
        },
      },
    ]);
  });
  return useCallback(() => {
    setLeaving(true);
    stopGuarding();
  }, [stopGuarding]);
}
