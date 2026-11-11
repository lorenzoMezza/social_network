// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { NewGroupScreen } from '../features/social/screens/NewGroupScreen';

export default function NewGroupRoute() {
  const { add } = useLocalSearchParams();
  return <NewGroupScreen key={add ?? 'new'} />;
}
