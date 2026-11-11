// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useColors } from '../../../theme/colors';
import { OfflineImage } from '../../offline/OfflineImage';
import { PRIORITY } from '../../../lib/offline/diskCache';

// The pictures its organizer gave the event, at the top of its page: one, or several
// swiped through with dots under them. Without any the page has no banner at all (the
// caller shows nothing). They are kept on the phone (offline/), the user's own and
// saved events' (`own`) longest.
export function EventCover({ photos, label, own = false, style }) {
  const colors = useColors();
  const priority = own ? PRIORITY.OWN : PRIORITY.RECENT;
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const many = photos.length > 1;

  return (
    <View style={style}>
      <View
        accessibilityRole="image"
        accessibilityLabel={many ? `${label}, ${page + 1} of ${photos.length}` : label}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.cover, { backgroundColor: colors.surface }]}
      >
        {many && width ? (
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / width))}
          >
            {photos.map((photo) => (
              <OfflineImage key={photo} url={photo} kind="events" priority={priority} style={{ width, height: '100%' }} contentFit="cover" transition={150} />
            ))}
          </ScrollView>
        ) : (
          <OfflineImage url={photos[0]} kind="events" priority={priority} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
        )}
      </View>
      {many ? (
        <View style={styles.dots} importantForAccessibility="no-hide-descendants">
          {photos.map((photo, index) => (
            <View key={photo} style={[styles.dot, { backgroundColor: index === page ? colors.active : colors.border }]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
