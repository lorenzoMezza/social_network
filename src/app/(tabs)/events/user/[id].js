// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { UserProfileScreen } from '../../../../features/profile/UserProfileScreen';

// A profile opened from inside this tab: it stays in the tab, with the tab bar
export default function TabUserRoute() {
  const { id, name, username } = useLocalSearchParams();
  return <UserProfileScreen key={id} id={id} name={name} username={username} />;
}
