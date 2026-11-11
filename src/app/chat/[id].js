// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { ChatScreen } from '../../features/social/screens/ChatScreen';

export default function ChatRoute() {
  const { id } = useLocalSearchParams();
  return <ChatScreen key={id} id={id} />;
}
