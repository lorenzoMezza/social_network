// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// How far the keyboard covers the screen (0 when hidden): the map's cards rise with it
export function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subscriptions = [
      Keyboard.addListener(showEvent, (event) => setHeight(event.endCoordinates.height)),
      Keyboard.addListener(hideEvent, () => setHeight(0)),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return height;
}
