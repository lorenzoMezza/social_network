// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The avatar format of the app: one source of truth for the backend (avatar-server,
// later the real backend) and the app (src/features/avatar). Both import this file.
//
// Two documents (JSON Schemas in ../schema/):
//  - the CATALOG: every item an avatar can wear, with its files per body shape and
//    the rules of what covers what. Built from the Decentraland avatar assets.
//  - an AVATAR: what one user chose. Small and stable: a body shape, three colours,
//    one item per slot. It never contains file URLs, so the catalog can move files
//    (or a CDN can serve them) without touching saved avatars.
//
// resolveAvatar(avatar, catalog) turns an avatar into a render plan: which models to
// load, which face textures, which parts of the bare body to hide, which colours.
// The viewer only ever draws render plans.

export const AVATAR_FORMAT = 'masterkey.avatar';
export const AVATAR_VERSION = 1;
export const CATALOG_FORMAT = 'masterkey.avatar-catalog';
export const CATALOG_VERSION = 1;

export const BODY_SHAPES = {
  male: 'base-avatars:BaseMale',
  female: 'base-avatars:BaseFemale',
};

// Every slot of an avatar. `kind`: model (a GLB rigged on the shared skeleton) or
// texture (a PNG painted on the face). `required`: an avatar always has one.
// `covers`: parts of the bare body hidden under it (unless the item says otherwise).
export const CATEGORIES = [
  { id: 'body_shape', label: 'Body', group: 'body', kind: 'model', required: true },
  { id: 'eyes', label: 'Eyes', group: 'face', kind: 'texture', required: true },
  { id: 'eyebrows', label: 'Eyebrows', group: 'face', kind: 'texture', required: true },
  { id: 'mouth', label: 'Mouth', group: 'face', kind: 'texture', required: true },
  { id: 'hair', label: 'Hair', group: 'hair', kind: 'model' },
  { id: 'facial_hair', label: 'Beard', group: 'hair', kind: 'model' },
  { id: 'upper_body', label: 'Top', group: 'top', kind: 'model', covers: ['upper_body', 'hands'] },
  { id: 'lower_body', label: 'Bottom', group: 'bottom', kind: 'model', covers: ['lower_body'] },
  { id: 'feet', label: 'Shoes', group: 'shoes', kind: 'model', covers: ['feet'] },
  { id: 'hat', label: 'Hat', group: 'accessories', kind: 'model' },
  { id: 'helmet', label: 'Helmet', group: 'accessories', kind: 'model' },
  { id: 'mask', label: 'Mask', group: 'accessories', kind: 'model' },
  { id: 'eyewear', label: 'Glasses', group: 'accessories', kind: 'model' },
  { id: 'earring', label: 'Earrings', group: 'accessories', kind: 'model' },
  { id: 'tiara', label: 'Tiara', group: 'accessories', kind: 'model' },
  { id: 'top_head', label: 'Head top', group: 'accessories', kind: 'model' },
  { id: 'hands_wear', label: 'Gloves', group: 'accessories', kind: 'model', covers: ['hands'] },
  { id: 'skin', label: 'Full body', group: 'accessories', kind: 'model', covers: ['head', 'upper_body', 'lower_body', 'feet', 'hands'] },
];

// Parts of the bare body that items can hide
export const BODY_PARTS = ['head', 'upper_body', 'lower_body', 'feet', 'hands'];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));
export const categoryInfo = (id) => CATEGORY_BY_ID.get(id) ?? null;

// Colour palettes offered by the editor. Any #RRGGBB is valid in an avatar.
export const PALETTES = {
  skin: ['#FFE4C6', '#F7D2B2', '#ECBC95', '#DDA77F', '#C98E66', '#B07650', '#8E5A3A', '#6E4429', '#4F2F1E', '#3A2216'],
  hair: ['#1C1C1E', '#3B2A20', '#5A3A24', '#8A5A33', '#B07A45', '#D9B37A', '#EAD8A8', '#9C9C9C', '#E8E8E8', '#B33A3A', '#D97A2B', '#3F6FD8', '#7B4CC2', '#2E9E6A', '#E46FA6'],
  eyes: ['#2B1D14', '#5A3A24', '#7A5A2F', '#3E6C3A', '#2F7A73', '#3D6FB6', '#7A8C99', '#6B4C9A'],
};

const HEX = /^#[0-9A-F]{6}$/i;

// The avatar of a new user: plain and complete, with base items that always exist
export function defaultAvatar(bodyShape = BODY_SHAPES.female) {
  const male = bodyShape === BODY_SHAPES.male;
  return {
    format: AVATAR_FORMAT,
    version: AVATAR_VERSION,
    bodyShape,
    colors: { skin: PALETTES.skin[3], hair: PALETTES.hair[2], eyes: PALETTES.eyes[1] },
    wearables: male
      ? {
        eyes: 'base-avatars:eyes_00', eyebrows: 'base-avatars:eyebrows_00', mouth: 'base-avatars:mouth_00',
        hair: 'base-avatars:casual_hair_01', upper_body: 'base-avatars:green_hoodie', lower_body: 'base-avatars:brown_pants', feet: 'base-avatars:sneakers',
      }
      : {
        eyes: 'base-avatars:f_eyes_00', eyebrows: 'base-avatars:f_eyebrows_00', mouth: 'base-avatars:f_mouth_00',
        hair: 'base-avatars:shoulder_bob_hair', upper_body: 'base-avatars:f_sweater', lower_body: 'base-avatars:f_jeans', feet: 'base-avatars:bun_shoes',
      },
    updatedAt: null,
  };
}

const itemIndex = (catalog) => {
  if (!catalog._index) {
    Object.defineProperty(catalog, '_index', { value: new Map(catalog.items.map((item) => [item.id, item])), enumerable: false });
  }
  return catalog._index;
};
export const findItem = (catalog, id) => itemIndex(catalog).get(id) ?? null;

// Checks an avatar against the format and the catalog. Returns the avatar cleaned up
// (unknown slots and items dropped, required slots filled) and what was wrong.
// The backend refuses avatars with errors; the app repairs old saved ones.
export function validateAvatar(input, catalog) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['not an object'], avatar: defaultAvatar() };
  if (input.format !== AVATAR_FORMAT) errors.push(`format must be "${AVATAR_FORMAT}"`);
  if (input.version !== AVATAR_VERSION) errors.push(`version must be ${AVATAR_VERSION}`);

  const bodyShape = findItem(catalog, input.bodyShape)?.category === 'body_shape' ? input.bodyShape : null;
  if (!bodyShape) errors.push(`unknown bodyShape "${input.bodyShape}"`);
  const fallback = defaultAvatar(bodyShape ?? BODY_SHAPES.female);
  const avatar = { ...fallback, bodyShape: bodyShape ?? fallback.bodyShape, updatedAt: input.updatedAt ?? null, wearables: {} };

  for (const key of ['skin', 'hair', 'eyes']) {
    const color = input.colors?.[key];
    if (typeof color === 'string' && HEX.test(color)) avatar.colors[key] = color.toUpperCase();
    else errors.push(`colors.${key} must be #RRGGBB`);
  }

  for (const [slot, id] of Object.entries(input.wearables ?? {})) {
    const item = findItem(catalog, id);
    if (!categoryInfo(slot) || slot === 'body_shape') errors.push(`unknown slot "${slot}"`);
    else if (!item) errors.push(`unknown item "${id}"`);
    else if (item.category !== slot) errors.push(`"${id}" is a ${item.category}, not a ${slot}`);
    else if (!item.representations[avatar.bodyShape]) errors.push(`"${id}" has no version for ${avatar.bodyShape}`);
    else avatar.wearables[slot] = id;
  }
  for (const category of CATEGORIES) {
    if (category.required && category.id !== 'body_shape' && !avatar.wearables[category.id]) {
      errors.push(`missing required slot "${category.id}"`);
      const fill = fallback.wearables[category.id];
      if (findItem(catalog, fill)) avatar.wearables[category.id] = fill;
    }
  }
  return { ok: errors.length === 0, errors, avatar };
}

// Wearing `itemId` in its slot, and what it takes off: the items it replaces or hides
// entirely (e.g. a helmet replaces the hat). Used by the editor, so an avatar is
// always valid as the user builds it.
export function wearItem(avatar, catalog, itemId) {
  const item = findItem(catalog, itemId);
  if (!item) return avatar;
  if (item.category === 'body_shape') return switchBodyShape(avatar, catalog, itemId);
  const wearables = { ...avatar.wearables, [item.category]: itemId };
  for (const slot of item.replaces) if (slot !== item.category && !categoryInfo(slot)?.required) delete wearables[slot];
  // An item already worn that would take this one off goes instead
  for (const [slot, id] of Object.entries(wearables)) {
    if (slot === item.category) continue;
    if (findItem(catalog, id)?.replaces.includes(item.category)) delete wearables[slot];
  }
  return { ...avatar, wearables };
}

export function removeItem(avatar, slot) {
  if (categoryInfo(slot)?.required) return avatar;
  const wearables = { ...avatar.wearables };
  delete wearables[slot];
  return { ...avatar, wearables };
}

// Same look on the other body shape: items without a version for it are swapped
// for the defaults of that shape
export function switchBodyShape(avatar, catalog, bodyShape) {
  const fallback = defaultAvatar(bodyShape);
  const wearables = {};
  for (const [slot, id] of Object.entries(avatar.wearables)) {
    if (findItem(catalog, id)?.representations[bodyShape]) wearables[slot] = id;
    else if (fallback.wearables[slot]) wearables[slot] = fallback.wearables[slot];
  }
  for (const category of CATEGORIES) {
    if (category.required && !wearables[category.id] && fallback.wearables[category.id]) wearables[category.id] = fallback.wearables[category.id];
  }
  return { ...avatar, bodyShape, wearables };
}

const join = (base, path) => (base ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : path);

// Avatar → what the viewer draws. `baseUrl` prefixes the catalog's relative file paths.
export function resolveAvatar(input, catalog, baseUrl = '') {
  const { avatar } = validateAvatar(input, catalog);
  const shape = avatar.bodyShape;
  const worn = Object.entries(avatar.wearables)
    .map(([slot, id]) => ({ slot, item: findItem(catalog, id) }))
    .filter(({ item }) => item);

  // Slots hidden by what is worn (a hood hides the hair). A name can be both a slot and
  // a body part ("lower_body": the trousers and the legs)
  const hiddenSlots = new Set();
  for (const { slot, item } of worn) {
    for (const name of [...item.hides, ...item.replaces]) if (name !== slot && categoryInfo(name)) hiddenSlots.add(name);
  }
  const visible = worn.filter(({ slot }) => !hiddenSlots.has(slot));
  const files = (item) => item.representations[shape];
  // Parts of the bare body a drawn item hides: the ones it names (a costume can hide
  // the head or the legs), and the ones its slot covers (a top: the torso and, unless
  // it says otherwise, the hands) where it has geometry of its own for them (catalog
  // `parts`): a sweater without hands, a watch or a ring leave the hands bare
  const hidesOf = ({ slot, item }) => {
    const parts = files(item).parts;
    const keep = new Set(item.removesDefaultHiding);
    const covered = (categoryInfo(slot)?.covers ?? []).filter((part) => !keep.has(part) && (!parts || parts.includes(part)));
    const named = [...item.hides, ...item.replaces].filter((name) => BODY_PARTS.includes(name));
    return [...new Set([...covered, ...named])];
  };
  const face = {};
  const models = [];
  for (const { slot, item } of visible) {
    const file = files(item);
    if (categoryInfo(slot).kind === 'texture') {
      face[slot] = { id: item.id, texture: join(baseUrl, file.texture), mask: file.mask ? join(baseUrl, file.mask) : null };
    } else {
      models.push({ id: item.id, slot, model: join(baseUrl, file.model), hides: hidesOf({ slot, item }) });
    }
  }
  const hiddenParts = new Set(models.flatMap((model) => model.hides));
  if (hiddenParts.has('head')) for (const slot of ['eyes', 'eyebrows', 'mouth']) delete face[slot];

  return {
    bodyShape: shape,
    body: { id: shape, model: join(baseUrl, files(findItem(catalog, shape)).model) },
    models,
    face,
    colors: avatar.colors,
    hiddenParts: [...hiddenParts],
  };
}

// The file of an emote for a body shape, or null
export function emoteUrl(catalog, emoteId, bodyShape, baseUrl = '') {
  const file = catalog.emotes?.find((emote) => emote.id === emoteId)?.files[bodyShape];
  return file ? join(baseUrl, file) : null;
}
