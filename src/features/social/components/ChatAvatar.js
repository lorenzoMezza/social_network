// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CategoryTile } from '../../events/components/CategoryTile';
import { OfflineImage } from '../../offline/OfflineImage';
import { PRIORITY } from '../../../lib/offline/diskCache';
import { PersonAvatar } from './PersonAvatar';

// The face of a chat, telling its kind at a glance: a person (round), a group (a
// rounded square: its picture, or its colour) or an event (its category, like everywhere else)
export function ChatAvatar({ chat, size = 52, nearby }) {
  if (chat.kind === 'direct') return <PersonAvatar person={chat.with} size={size} ring={nearby} />;
  if (chat.kind === 'event') return <CategoryTile event={chat.event} size={size} />;
  const square = { width: size, height: size, borderRadius: size * 0.3, borderCurve: 'continuous' };
  const tile = (
    <View style={[square, { alignItems: 'center', justifyContent: 'center', backgroundColor: `${chat.color ?? '#6E7FF5'}26` }]}>
      <Ionicons name="people" size={size * 0.46} color={chat.color ?? '#6E7FF5'} />
    </View>
  );
  if (!chat.pictureUrl) return tile;
  return (
    <OfflineImage
      url={chat.pictureUrl}
      kind="people"
      priority={PRIORITY.CLOSE}
      placeholder={tile}
      style={square}
      contentFit="cover"
      transition={120}
      recyclingKey={chat.pictureUrl}
      accessibilityIgnoresInvertColors
    />
  );
}
