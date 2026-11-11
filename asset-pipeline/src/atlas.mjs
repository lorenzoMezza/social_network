// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// One texture for a whole avatar (mapAvatar.mjs): every material's picture gets a
// region of a square atlas, sized for what it covers on the body, with a border of its
// own pixels around it (wrapped for repeating textures, stretched for clamped ones), so
// filtering and the smaller mip levels never pick up a neighbour.
import sharp from 'sharp';

// sRGB ↔ linear, the GPU's curves
const TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
export const toLinear = (byte) => TO_LINEAR[byte];
function toSrgbByte(linear) {
  const c = Math.min(Math.max(linear, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Skyline packing: rectangles ({ width, height }, padding included) into a square of
 * `side`, tallest first. Answers [{ x, y }] in the input order, or null if they do not fit.
 */
export function pack(rects, side) {
  const order = rects.map((rect, index) => ({ ...rect, index }))
    .sort((a, b) => b.height - a.height || b.width - a.width);
  let skyline = [{ x: 0, y: 0, width: side }];
  const placed = new Array(rects.length);
  for (const rect of order) {
    let best = null;
    for (let i = 0; i < skyline.length; i++) {
      const x = skyline[i].x;
      if (x + rect.width > side) break;
      let y = 0;
      let covered = 0;
      for (let j = i; j < skyline.length && covered < rect.width; j++) {
        y = Math.max(y, skyline[j].y);
        covered = skyline[j].x + skyline[j].width - x;
      }
      if (y + rect.height > side) continue;
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
    }
    if (!best) return null;
    placed[rect.index] = best;
    // The skyline under the new rectangle rises to its top
    const right = best.x + rect.width;
    const next = [];
    for (const segment of skyline) {
      const end = segment.x + segment.width;
      if (end <= best.x || segment.x >= right) {
        next.push(segment);
        continue;
      }
      if (segment.x < best.x) next.push({ x: segment.x, y: segment.y, width: best.x - segment.x });
      if (end > right) next.push({ x: right, y: segment.y, width: end - right });
    }
    next.push({ x: best.x, y: best.y + rect.height, width: rect.width });
    next.sort((a, b) => a.x - b.x);
    skyline = [];
    for (const segment of next) {
      const last = skyline.at(-1);
      if (last && last.y === segment.y && last.x + last.width === segment.x) last.width += segment.width;
      else skyline.push({ ...segment });
    }
  }
  return placed;
}

/**
 * Source pixels (raw RGBA8, sRGB as stored) of a part of a picture, at a size.
 * soft: a kernel that never overshoots, for pictures with transparency (Lanczos rings
 * around their edges, and the faint ghosts it leaves in the alpha show as lines)
 */
export async function decodeAt(image, width, height, crop = null, soft = false) {
  let pipeline = sharp(image, { ignoreIcc: true }).ensureAlpha();
  if (crop) pipeline = pipeline.extract(crop);
  const { data } = await pipeline
    .resize(width, height, { fit: 'fill', kernel: soft ? 'linear' : 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/**
 * The atlas being painted: RGBA8 sRGB, `side` square
 */
export function createAtlas(side) {
  const data = Buffer.alloc(side * side * 4);
  return {
    side,
    data,
    /**
     * Paints a region: `pixel(i, j, out)` writes linear RGBA of the region's own pixel
     * (i, j) in [0, width) × [0, height) into `out`; the border of `pad` around it repeats
     * the region (wrap) or its edges (clamp).
     */
    paint({ x, y, width, height, pad, wrap }, pixel) {
      const out = [0, 0, 0, 1];
      const at = (value, size) => (wrap ? ((value % size) + size) % size : Math.min(Math.max(value, 0), size - 1));
      for (let j = -pad; j < height + pad; j++) {
        for (let i = -pad; i < width + pad; i++) {
          pixel(at(i, width), at(j, height), out);
          const offset = ((y + pad + j) * side + (x + pad + i)) * 4;
          data[offset] = toSrgbByte(out[0]);
          data[offset + 1] = toSrgbByte(out[1]);
          data[offset + 2] = toSrgbByte(out[2]);
          data[offset + 3] = Math.round(Math.min(Math.max(out[3], 0), 1) * 255);
        }
      }
    },
    /**
     * The colour of a region's see-through texels taken from their visible
     * neighbours (alpha bleeding): filtering and coverage near an edge then show the
     * edge's colour, not whatever the picture kept there (often white)
     */
    bleed({ x, y, width, height }) {
      const visible = new Uint8Array(width * height);
      const at = (i, j) => ((y + j) * side + (x + i)) * 4;
      let sum = [0, 0, 0];
      let count = 0;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const o = at(i, j);
          if (data[o + 3] >= 16) {
            visible[j * width + i] = 1;
            sum[0] += data[o];
            sum[1] += data[o + 1];
            sum[2] += data[o + 2];
            count++;
          }
        }
      }
      if (count === 0 || count === width * height) return;
      // Rings outwards from the visible texels, a few at a time
      for (let pass = 0; pass < 16; pass++) {
        const next = visible.slice();
        let grown = 0;
        for (let j = 0; j < height; j++) {
          for (let i = 0; i < width; i++) {
            if (visible[j * width + i]) continue;
            let r = 0;
            let g = 0;
            let b = 0;
            let n = 0;
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const ni = i + di;
                const nj = j + dj;
                if (ni < 0 || nj < 0 || ni >= width || nj >= height || !visible[nj * width + ni]) continue;
                const o = at(ni, nj);
                r += data[o];
                g += data[o + 1];
                b += data[o + 2];
                n++;
              }
            }
            if (!n) continue;
            const o = at(i, j);
            data[o] = Math.round(r / n);
            data[o + 1] = Math.round(g / n);
            data[o + 2] = Math.round(b / n);
            next[j * width + i] = 1;
            grown++;
          }
        }
        visible.set(next);
        if (!grown) break;
      }
      // Farther away: the region's average colour
      sum = sum.map((value) => Math.round(value / count));
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          if (visible[j * width + i]) continue;
          const o = at(i, j);
          data[o] = sum[0];
          data[o + 1] = sum[1];
          data[o + 2] = sum[2];
        }
      }
    },
  };
}

/** The mip chain of a square RGBA8 image, `levels` levels from the full size down */
export async function mipLevels(data, side, levels) {
  const images = [{ data, width: side, height: side }];
  for (let level = 1, size = side >> 1; level < levels; level++, size >>= 1) {
    const { data: smaller } = await sharp(data, { raw: { width: side, height: side, channels: 4 } })
      .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    images.push({ data: smaller, width: size, height: size });
  }
  return images;
}
