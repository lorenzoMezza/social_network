// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { UserProfileScreen } from '../../features/profile/UserProfileScreen';

// /user/<id>?name=…&username=… : what the link already knows is shown at once
export default function UserRoute() {
  const { id, name, username } = useLocalSearchParams();
  return <UserProfileScreen key={id} id={id} name={name} username={username} />;
}
