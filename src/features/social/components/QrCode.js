// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo, useMemo } from 'react';
import { View } from 'react-native';
import createQrCode from 'qrcode-generator';

// A QR code of `value`, drawn with plain views (one per dark run of a row): no native
// module, crisp at any size
export const QrCode = memo(function QrCode({ value, size = 200, color = '#000000', background = '#FFFFFF' }) {
  const rows = useMemo(() => {
    const code = createQrCode(0, 'M');
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    const runs = [];
    for (let y = 0; y < count; y++) {
      let start = -1;
      for (let x = 0; x <= count; x++) {
        const dark = x < count && code.isDark(y, x);
        if (dark && start < 0) start = x;
        if (!dark && start >= 0) {
          runs.push({ y, x: start, length: x - start });
          start = -1;
        }
      }
    }
    return { count, runs };
  }, [value]);

  // A quiet zone of two modules all around
  const cell = size / (rows.count + 4);
  return (
    <View style={{ width: size, height: size, backgroundColor: background }} accessibilityRole="image" accessibilityLabel="Your QR code">
      {rows.runs.map((run) => (
        <View
          key={`${run.y}-${run.x}`}
          style={{ position: 'absolute', left: (run.x + 2) * cell, top: (run.y + 2) * cell, width: run.length * cell + 0.5, height: cell + 0.5, backgroundColor: color }}
        />
      ))}
    </View>
  );
});
