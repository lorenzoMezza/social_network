// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Event categories, exactly the values of Event.categories in the API
// (docs/API.md, Events): users pick from these, never type their own.
// Colour is a small accent only (the icon tile of an event): a few muted tones shared
// by related categories, so a list never turns into a rainbow. `emoji`: the badge of
// the event's beacon on the 3D map, where the icon font is not available.
const TONES = {
  blue: '#4D78BF',
  violet: '#7466B8',
  rose: '#B85D78',
  orange: '#C2733D',
  amber: '#A9832C',
  green: '#4A8F63',
  teal: '#3A8C84',
  slate: '#66738A',
};

export const CATEGORIES = [
  { id: 'social', label: 'Social', icon: 'people', color: TONES.blue, emoji: '🙌' },
  { id: 'party', label: 'Party', icon: 'happy', color: TONES.rose, emoji: '🎉' },
  { id: 'music', label: 'Music', icon: 'musical-notes', color: TONES.violet, emoji: '🎵' },
  { id: 'food', label: 'Food', icon: 'restaurant', color: TONES.orange, emoji: '🍕' },
  { id: 'drinks', label: 'Drinks', icon: 'wine', color: TONES.rose, emoji: '🍹' },
  { id: 'sports', label: 'Sports', icon: 'football', color: TONES.green, emoji: '⚽' },
  { id: 'competitive', label: 'Competitive', icon: 'trophy', color: TONES.amber, emoji: '🏆' },
  { id: 'games', label: 'Games', icon: 'game-controller', color: TONES.violet, emoji: '🎮' },
  { id: 'relaxing', label: 'Relaxing', icon: 'leaf', color: TONES.green, emoji: '🌿' },
  { id: 'exposition', label: 'Exposition', icon: 'color-palette', color: TONES.amber, emoji: '🎨' },
  { id: 'festival', label: 'Festival', icon: 'sparkles', color: TONES.rose, emoji: '🎪' },
  { id: 'festivities', label: 'Festivities', icon: 'gift', color: TONES.amber, emoji: '🎁' },
  { id: 'convention', label: 'Convention', icon: 'business', color: TONES.slate, emoji: '🏛️' },
  { id: 'technology', label: 'Technology', icon: 'hardware-chip', color: TONES.blue, emoji: '💻' },
  { id: 'shopping', label: 'Shopping', icon: 'bag-handle', color: TONES.orange, emoji: '🛍️' },
  { id: 'clothes', label: 'Clothes', icon: 'shirt', color: TONES.teal, emoji: '👕' },
  { id: 'sales', label: 'Sales', icon: 'pricetag', color: TONES.orange, emoji: '🏷️' },
  { id: 'free entry', label: 'Free entry', icon: 'ticket', color: TONES.teal, emoji: '🎟️' },
];

const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));
const FALLBACK = { id: 'other', label: 'Event', icon: 'calendar', color: TONES.slate, emoji: '📍' };

// The everyday kinds: the flash event's grid, and the ones the event editor shows first
// (the others behind "More")
export const QUICK_CATEGORIES = ['sports', 'social', 'drinks', 'food', 'games', 'music', 'party', 'relaxing'];

export function categoryInfo(id) {
  return BY_ID.get(id) ?? FALLBACK;
}

// The category that gives an event its icon
export function mainCategory(event) {
  return categoryInfo(event?.categories?.[0]);
}

// "Sports, Competitive": the categories of an event as one short line
export function categoryLine(event, max = 2) {
  const labels = (event?.categories ?? []).map((id) => categoryInfo(id).label);
  const extra = labels.length > max ? ` +${labels.length - max}` : '';
  return labels.slice(0, max).join(', ') + extra;
}

// The colours an organizer can give their event's page (and its tile everywhere): the
// same muted tones, so a custom event still sits well in a list
export const EVENT_COLORS = Object.values(TONES);

// The colour of an event: the one its organizer chose, else its main category's
export const eventColor = (event) => event?.theme?.color ?? mainCategory(event).color;

// Its symbol on the map: the emoji its organizer chose, else its category's
export const eventEmoji = (event) => event?.theme?.emoji ?? mainCategory(event).emoji;

// Pale background of a category tile, from its tone (hex + alpha)
export const tileBackground = (color, scheme) => `${color}${scheme === 'dark' ? '33' : '1F'}`;
