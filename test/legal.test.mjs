// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The legal documents the app shows: present in both languages, parsed into blocks
// the screen can draw, and the licences of every shipped package with their text.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMarkdown } from '../src/features/legal/parseMarkdown.js';
import { DOCUMENTS } from '../src/features/legal/documents.js';
import { NOTICES } from '../src/features/legal/thirdParty.js';

describe('legal documents', () => {
  it('has every document in full and in short, in English and Italian', () => {
    for (const id of ['privacy', 'terms', 'guidelines']) {
      for (const language of ['en', 'it']) {
        const { full, short } = DOCUMENTS[id];
        assert.ok(full?.[language]?.length > 1500, `${id} ${language} full`);
        assert.ok(short?.[language]?.length > 500, `${id} ${language} short`);
        assert.ok(short[language].length < full[language].length / 1.4, `${id} ${language}: the short one is short`);
        for (const text of [full[language], short[language]]) {
          assert.equal(parseMarkdown(text)[0].kind, 'heading', `${id} ${language} starts with its title`);
        }
        // The short one points to the full text as the one that applies
        assert.match(short[language], language === 'it' ? /vale il testo completo/ : /full text is the one that applies/);
      }
    }
  });

  it('parses headings, lists, tables, quotes and paragraphs', () => {
    const blocks = parseMarkdown([
      '# Title', '', 'One line', 'continued.', '', '- a', '  - nested', '- b', '',
      '| Data | How long |', '|---|---|', '| Position | 45 s |', '| Account | Until deleted |', '', '> quoted',
    ].join('\n'));
    assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'paragraph', 'list', 'table', 'quote']);
    assert.equal(blocks[1].text, 'One line continued.');
    assert.deepEqual(blocks[2].items.map((item) => item.depth), [0, 1, 0]);
    assert.deepEqual(blocks[3].header, ['Data', 'How long']);
    assert.deepEqual(blocks[3].rows[1], ['Account', 'Until deleted']);
  });

  it('tells the same retention in both languages', () => {
    for (const language of ['en', 'it']) {
      for (const text of [DOCUMENTS.privacy.full[language], DOCUMENTS.privacy.short[language]]) {
        assert.match(text, /45/, 'the position is kept 45 seconds');
        assert.match(text, /18/, 'the minimum age');
        assert.match(text, /300 m/, 'the approximate area');
      }
    }
  });
});

describe('third-party notices', () => {
  it('gives every package a licence text', () => {
    assert.ok(NOTICES.groups.length > 10);
    for (const group of NOTICES.groups) {
      assert.ok(group.text.length > 20, group.license);
      assert.ok(!group.text.startsWith('The package declares'), `${group.license}: ${group.packages.map((p) => p[0]).join(', ')}`);
    }
    const names = NOTICES.groups.flatMap((group) => group.packages.map(([name]) => name));
    for (const name of ['react-native', 'three', 'expo', 'lm-three-geo-play', 'Hermes', 'Folly', 'Ionicons (font)']) assert.ok(names.includes(name), name);
    // Only what the app ships: no build tools, nothing whose licence asks for no notice
    for (const name of ['typescript', 'eslint', 'metro', '@babel/core', 'esbuild', 'fmt', 'boost']) assert.ok(!names.includes(name), name);
  });

  it('credits the map data and the avatar assets', () => {
    assert.ok(NOTICES.data.some((item) => /OpenStreetMap/.test(item.detail) && /ODbL/.test(item.detail) && item.url === 'https://www.openstreetmap.org/copyright'));
    assert.ok(NOTICES.assets.every((item) => item.license === 'Apache-2.0' && /Apache License/.test(item.text)));
  });
});
