// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { roundedRect } from './billboards.js';

// How the people's names and speech bubbles look, drawn into billboard slots
// (billboards.js). Sizes in CSS pixels; each painter answers the size it used.

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
// Room around the shapes for their soft shadow
const MARGIN = 7;

const ellipsize = (ctx, text, maxWidth) => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
};

const shadow = (ctx, strength = 0.22) => {
  ctx.shadowColor = `rgba(16, 20, 28, ${strength})`;
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 2;
};
const noShadow = (ctx) => {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
};

/**
 * A name in a pill, after a dot of the person's colour.
 * look: 'plain' | 'area' (shown by area: lighter, dashed edge) | 'selected' (dark)
 */
// `friend`: the colour of a ring around the tag (one of the user's connections), or null
export function paintNameTag({ name, tone = '#5b6475', look = 'plain', friend = null }) {
  return (ctx, maxWidth) => {
    const height = 26;
    const dot = 8;
    const left = 9;
    const right = 11;
    const gap = 6;
    ctx.font = `600 13px ${FONT}`;
    const text = ellipsize(ctx, name, Math.min(150, maxWidth - 2 * MARGIN - left - dot - gap - right));
    const width = left + dot + gap + ctx.measureText(text).width + right;
    const x = MARGIN;
    const y = MARGIN;

    shadow(ctx, look === 'area' ? 0.12 : 0.22);
    ctx.fillStyle = look === 'selected' ? '#14161a' : look === 'area' ? 'rgba(255, 255, 255, 0.82)' : 'rgba(255, 255, 255, 0.96)';
    roundedRect(ctx, x, y, width, height, height / 2);
    ctx.fill();
    noShadow(ctx);
    if (friend) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = friend;
      roundedRect(ctx, x + 1, y + 1, width - 2, height - 2, height / 2 - 1);
      ctx.stroke();
    } else if (look === 'area') {
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(20, 22, 26, 0.3)';
      roundedRect(ctx, x + 0.75, y + 0.75, width - 1.5, height - 1.5, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(x + left + dot / 2, y + height / 2, dot / 2, 0, Math.PI * 2);
    ctx.fillStyle = tone;
    ctx.fill();
    if (look === 'selected') {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    ctx.fillStyle = look === 'selected' ? '#ffffff' : look === 'area' ? '#3a3f48' : '#14161a';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + left + dot + gap, y + height / 2 + 0.5);
    return { width: width + 2 * MARGIN, height: height + 2 * MARGIN };
  };
}

// Only emoji (a gesture): shown big, in a round bubble
const EMOJI_ONLY = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

const wrap = (ctx, text, maxWidth, maxLines) => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const shown = lines.slice(0, maxLines).map((entry) => ellipsize(ctx, entry, maxWidth));
  if (lines.length === maxLines && words.join(' ').length > shown.join(' ').length) {
    shown[maxLines - 1] = ellipsize(ctx, `${shown[maxLines - 1]}…`, maxWidth);
  }
  return shown;
};

// A speech bubble with a tail pointing down at the speaker. Words said to everyone
// around (everyone: true) are dark, after a megaphone; words to the user are light.
export function paintBubble(text, { everyone = false } = {}) {
  const fill = everyone ? '#14161a' : '#ffffff';
  const ink = everyone ? '#ffffff' : '#14161a';
  return (ctx, maxWidth, maxHeight) => {
    const tail = 7;
    const x = MARGIN;
    const y = MARGIN;
    if (EMOJI_ONLY.test(text)) {
      const size = 46;
      shadow(ctx);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + size / 2 - 6, y + size - 3);
      ctx.lineTo(x + size / 2, y + size + tail);
      ctx.lineTo(x + size / 2 + 6, y + size - 3);
      ctx.fill();
      noShadow(ctx);
      ctx.font = `26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text.trim(), x + size / 2, y + size / 2 + 1);
      return { width: size + 2 * MARGIN, height: size + tail + 2 * MARGIN };
    }

    const paddingX = 12;
    const paddingY = 9;
    const lineHeight = 18;
    ctx.font = `500 14px ${FONT}`;
    const maxText = Math.min(210, maxWidth - 2 * MARGIN - 2 * paddingX);
    const maxLines = Math.max(1, Math.min(3, Math.floor((maxHeight - 2 * MARGIN - 2 * paddingY - tail) / lineHeight)));
    const lines = wrap(ctx, everyone ? `📣 ${text}` : text, maxText, maxLines);
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width), 24) + 2 * paddingX;
    const height = lines.length * lineHeight + 2 * paddingY;

    shadow(ctx);
    ctx.fillStyle = fill;
    roundedRect(ctx, x, y, width, height, 16);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + width / 2 - 7, y + height - 1);
    ctx.lineTo(x + width / 2, y + height + tail);
    ctx.lineTo(x + width / 2 + 7, y + height - 1);
    ctx.fill();
    noShadow(ctx);
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    lines.forEach((line, index) => ctx.fillText(line, x + width / 2, y + paddingY + lineHeight * (index + 0.5) + 0.5));
    return { width: width + 2 * MARGIN, height: height + tail + 2 * MARGIN };
  };
}
