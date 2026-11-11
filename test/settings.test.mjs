// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The phone's settings (settingsStore): what the user chose survives a restart
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

describe('settings', () => {
  it('keeps the saved theme when a setting changes while they load', async () => {
    await AsyncStorage.setItem('settings:v1', JSON.stringify({ theme: 'dark', mapStartInvisible: false }));
    // A fresh start of the app: nothing read yet
    const { updateSetting, loadSettings } = await import('../src/features/settings/settingsStore.js');
    await updateSetting('mapLastMode', 'visible');
    const saved = JSON.parse(await AsyncStorage.getItem('settings:v1'));
    assert.equal(saved.theme, 'dark');
    assert.equal(saved.mapStartInvisible, false);
    assert.equal(saved.mapLastMode, 'visible');
    assert.equal((await loadSettings()).theme, 'dark');
    assert.equal(Appearance.scheme, 'dark');
  });

  it('gives the last choice to a page opened after it, not the one read at startup', async () => {
    const { updateSetting, loadSettings } = await import('../src/features/settings/settingsStore.js');
    await loadSettings();
    await updateSetting('theme', 'light');
    // What useSettings shows when the settings page opens again
    assert.equal((await loadSettings()).theme, 'light');
    await updateSetting('theme', 'dark');
    assert.equal((await loadSettings()).theme, 'dark');
    assert.equal(JSON.parse(await AsyncStorage.getItem('settings:v1')).theme, 'dark');
  });
});

describe('saved event filters', () => {
  it('keeps what is still an option and drops the rest', async () => {
    const { savedFilters, DEFAULT_FILTERS } = await import('../src/features/events/model/eventModel.js');
    const ids = new Set(['music', 'sport']);
    assert.equal(savedFilters(undefined, ids), null);
    // A distance saved by an older version is dropped: there is none to choose
    assert.deepEqual(savedFilters({ range: 5000, categories: ['music', 'gone'], when: 'today' }, ids), { categories: ['music'], when: 'today' });
    assert.deepEqual(savedFilters({ range: 123, categories: 'x', when: 'someday' }, ids), DEFAULT_FILTERS);
  });

  it('leaves no choice to be seen on the map to whoever signs in next', async () => {
    const { updateSetting, loadSettings } = await import('../src/features/settings/settingsStore.js');
    const { forgetMapChoices } = await import('../src/features/map/state/mapVisibility.js');
    await updateSetting('mapLastMode', 'visible');
    await updateSetting('mapStartInvisible', false);
    await updateSetting('mapModeExplained', true);
    forgetMapChoices();
    await new Promise((done) => { setTimeout(done, 20); });
    const settings = await loadSettings();
    assert.equal(settings.mapLastMode, 'invisible');
    assert.equal(settings.mapStartInvisible, true);
    assert.equal(settings.mapModeExplained, false);
    const saved = JSON.parse(await AsyncStorage.getItem('settings:v1'));
    assert.equal(saved.mapLastMode, 'invisible');
    assert.equal(saved.mapStartInvisible, true);
  });
});
