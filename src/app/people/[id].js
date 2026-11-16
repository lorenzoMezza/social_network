// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { TheirConnectionsScreen } from '../../features/social/screens/TheirConnectionsScreen';

// /people/<user id>?name=…: someone's connections, the ones in common first
export default function PeopleRoute() {
  const { id, name } = useLocalSearchParams();
  return <TheirConnectionsScreen key={id} id={id} name={name} />;
}
