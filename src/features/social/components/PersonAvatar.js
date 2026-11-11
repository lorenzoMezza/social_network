// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../../theme/colors';
import { OfflineImage } from '../../offline/OfflineImage';
import { priorityOfPerson } from '../../offline/peoplePriority';

// Soft colours for people without a photo, picked from their username: the same
// person always has the same colour, in every screen
const TONES = ['#F2546B', '#2F7BFF', '#1F9D63', '#A855F7', '#E08A00', '#0EA5A4', '#F06A3D', '#6E7FF5'];
export const toneOf = (username = '') => {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
};

// A person: their picture, or their initial on a disc of their colour (also while the
// picture comes). `person`: a UserSummary of the API ({ id, username, name,
// pictureUrl }); or `id`, `username`, `name` and `picture` apart. The picture is kept
// on the phone, the user's own and their connections' longest (offline/). `ring`: a
// green ring when they are nearby right now; `badge`: a small mark at the bottom
// right (e.g. connected)
export function PersonAvatar({ person, id = person?.id, username = person?.username, name = person?.name, picture = person?.pictureUrl, size = 44, ring, badge }) {
  const colors = useColors();
  const tone = toneOf(username);
  const letter = (name || username || '?').trim()[0]?.toUpperCase() ?? '?';
  const round = { width: size, height: size, borderRadius: size / 2 };
  const disc = (
    <View
      style={[
        styles.disc,
        round,
        { backgroundColor: `${tone}26` },
        ring && { borderWidth: 2.5, borderColor: colors.live },
      ]}
    >
      <Text style={{ fontSize: size * 0.42, fontWeight: '700', color: tone }}>{letter}</Text>
    </View>
  );
  return (
    <View style={{ width: size, height: size }}>
      {picture ? (
        <OfflineImage
          url={picture}
          kind="people"
          priority={priorityOfPerson(id)}
          placeholder={disc}
          style={[round, { backgroundColor: `${tone}26` }, ring && { borderWidth: 2.5, borderColor: colors.live }]}
          contentFit="cover"
          transition={120}
          recyclingKey={picture}
          accessibilityIgnoresInvertColors
        />
      ) : disc}
      {badge ? <View style={[styles.badge, { right: -2, bottom: -2, borderColor: colors.page }]}>{badge}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 10,
  },
});
