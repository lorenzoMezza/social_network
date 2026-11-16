// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What an avatar shows of the bare body under what it wears (avatar-server/shared/avatarFormat.js):
// no hands, legs or torso may go missing under an item that has no geometry for them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BODY_SHAPES, defaultAvatar, resolveAvatar, validateAvatar } from '../avatar-server/shared/avatarFormat.js';

const MALE = BODY_SHAPES.male;
const item = (id, category, { parts, hides = [], replaces = [], removesDefaultHiding = [] } = {}) => ({
  id,
  category,
  representations: { [MALE]: category === 'eyes' || category === 'eyebrows' || category === 'mouth' ? { texture: `${id}.png` } : { model: `${id}.glb`, ...(parts ? { parts } : {}) } },
  hides,
  replaces,
  removesDefaultHiding,
});
const base = defaultAvatar(MALE).wearables;
const catalog = {
  items: [
    item(MALE, 'body_shape'),
    item(base.eyes, 'eyes'), item(base.eyebrows, 'eyebrows'), item(base.mouth, 'mouth'),
    item(base.hair, 'hair'),
    item('sweater', 'upper_body', { parts: ['upper_body'] }),
    item('old-coat', 'upper_body', { parts: ['upper_body', 'hands'] }),
    item('new-hoodie', 'upper_body', { parts: ['upper_body'], removesDefaultHiding: ['hands'] }),
    item('legacy-top', 'upper_body'),
    item('hood', 'upper_body', { parts: ['upper_body', 'hands'], hides: ['hair'] }),
    item('watch', 'hands_wear', { parts: [] }),
    item('glove', 'hands_wear', { parts: ['hands'] }),
    item('trousers', 'lower_body', { parts: ['lower_body'] }),
    item('costume', 'upper_body', { parts: ['upper_body'], hides: ['lower_body', 'feet', 'hands', 'head'] }),
    item('boots', 'feet', { parts: [] }),
  ],
};
const wearing = (wearables) => resolveAvatar({
  format: 'masterkey.avatar', version: 1, bodyShape: MALE, colors: { skin: '#AA8866', hair: '#111111', eyes: '#223344' },
  wearables: { eyes: base.eyes, eyebrows: base.eyebrows, mouth: base.mouth, ...wearables },
}, catalog);
const hidden = (wearables) => wearing(wearables).hiddenParts.sort();

describe('an avatar that is not what it should be', () => {
  it('says what is wrong, also with colours of the wrong type, and never throws', () => {
    const avatar = { format: 'masterkey.avatar', version: 1, bodyShape: MALE, wearables: {} };
    for (const skin of [['#FFFFFF'], 123, { a: 1 }, null, '#GGGGGG']) {
      const checked = validateAvatar({ ...avatar, colors: { skin, hair: '#111111', eyes: '#223344' } }, catalog);
      assert.equal(checked.ok, false);
      assert.ok(checked.errors.includes('colors.skin must be #RRGGBB'), String(skin));
    }
  });
});

describe('the bare body under what is worn', () => {
  it('keeps the hands of a top that has none of its own (a sweater ending at the wrists)', () => {
    assert.deepEqual(hidden({ upper_body: 'sweater' }), ['upper_body']);
  });

  it('hides the hands under a top that brings its own', () => {
    assert.deepEqual(hidden({ upper_body: 'old-coat' }), ['hands', 'upper_body']);
  });

  it('keeps the hands when the item says so', () => {
    assert.deepEqual(hidden({ upper_body: 'new-hoodie' }), ['upper_body']);
  });

  it('a watch or a ring leaves the hands, a glove replaces them', () => {
    assert.deepEqual(hidden({ hands_wear: 'watch' }), []);
    assert.deepEqual(hidden({ hands_wear: 'glove' }), ['hands']);
  });

  it('keeps a slot that has no geometry for its part (boots leave the feet)', () => {
    assert.deepEqual(hidden({ feet: 'boots' }), []);
  });

  it('honours what an item names (a costume hides the body it envelops, the face too)', () => {
    const plan = wearing({ upper_body: 'costume', lower_body: 'trousers' });
    assert.deepEqual(plan.hiddenParts.sort(), ['feet', 'hands', 'head', 'lower_body', 'upper_body']);
    assert.deepEqual(plan.models.map((model) => model.id), ['costume']);
    assert.deepEqual(Object.keys(plan.face), []);
  });

  it('trusts the slot for catalogs without geometry info', () => {
    assert.deepEqual(hidden({ upper_body: 'legacy-top' }), ['hands', 'upper_body']);
  });

  it('gives each model what it hides, so a viewer can show the body where a model failed', () => {
    const plan = wearing({ upper_body: 'hood', hair: base.hair, lower_body: 'trousers' });
    assert.deepEqual(plan.models.map(({ id, hides }) => [id, hides.sort()]), [['hood', ['hands', 'upper_body']], ['trousers', ['lower_body']]]);
  });
});
