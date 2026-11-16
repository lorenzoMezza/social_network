// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { ChatInfoScreen } from '../../features/social/screens/ChatInfoScreen';

export default function ChatInfoRoute() {
  const { id } = useLocalSearchParams();
  return <ChatInfoScreen key={id} id={id} />;
}
