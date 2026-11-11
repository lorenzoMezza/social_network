// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { mainCategory, tileBackground } from '../model/categories';

// The icon of an event's main category on a pale square of its tone; the colour and
// the emoji its organizer chose (Event.theme), if they did
export function CategoryTile({ event, category = mainCategory(event), size = 44, theme = event?.theme }) {
  const colors = useColors();
  const color = theme?.color ?? category.color;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tileBackground(color, colors.scheme),
      }}
    >
      {theme?.emoji ? (
        <Text style={{ fontSize: size * 0.5 }}>{theme.emoji}</Text>
      ) : (
        <Ionicons name={category.icon} size={size * 0.46} color={color} />
      )}
    </View>
  );
}
