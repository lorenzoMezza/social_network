// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The sky the map shows, from what the weather service answers
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { weatherFromOpenMeteo } from '../webview/map/src/scene/environment/weather.js';
import { weatherRequestUrl } from '../webview/shared/weatherRequest.js';

const answer = (current) => ({ current: { weather_code: 1, cloud_cover: 0, ...current }, hourly: {} });
const percent = (current) => Math.round(weatherFromOpenMeteo(answer(current)).cloudCover * 100);

describe('cloud cover', () => {
  it('is not raised by the weather code', () => {
    assert.equal(percent({ weather_code: 3, cloud_cover: 82 }), 82);
    assert.equal(percent({ weather_code: 3, cloud_cover: 50 }), 50);
  });

  it('counts a thin veil in the high sky for little', () => {
    // Rome, 2026-11-05: the models said 100%, airports no cloud under 1500 m
    const veil = { weather_code: 3, cloud_cover: 100, cloud_cover_low: 0, cloud_cover_mid: 50, cloud_cover_high: 100 };
    assert.equal(percent(veil), 51);
    assert.equal(percent({ ...veil, cloud_cover_mid: 0 }), 25);
  });

  it('counts low clouds in full, and a sky closed at every height as closed', () => {
    assert.equal(percent({ cloud_cover: 100, cloud_cover_low: 100, cloud_cover_mid: 0, cloud_cover_high: 0 }), 100);
    assert.equal(percent({ cloud_cover: 100, cloud_cover_low: 100, cloud_cover_mid: 100, cloud_cover_high: 100 }), 100);
    assert.equal(percent({ cloud_cover: 0, cloud_cover_low: 0, cloud_cover_mid: 0, cloud_cover_high: 0 }), 0);
  });

  it('is never more than the total the model gives', () => {
    assert.equal(percent({ cloud_cover: 30, cloud_cover_low: 30, cloud_cover_mid: 30, cloud_cover_high: 30 }), 30);
  });

  it('is the total when the layers are not there (a copy kept from before)', () => {
    assert.equal(percent({ cloud_cover: 64 }), 64);
  });

  it('is not a clear sky while it rains', () => {
    assert.ok(percent({ cloud_cover: 20, cloud_cover_low: 0, cloud_cover_mid: 0, cloud_cover_high: 20, rain: 1, interval: 900 }) >= 85);
  });

  it('dims the light only under what really closes the sky', () => {
    const veil = weatherFromOpenMeteo(answer({ weather_code: 3, cloud_cover: 100, cloud_cover_low: 0, cloud_cover_mid: 50, cloud_cover_high: 100 }));
    const closed = weatherFromOpenMeteo(answer({ weather_code: 3, cloud_cover: 100, cloud_cover_low: 100, cloud_cover_mid: 100, cloud_cover_high: 100 }));
    assert.equal(veil.overcast, 0);
    assert.ok(closed.overcast > 0.5);
  });

  it('asks the service for the three layers', () => {
    const url = decodeURIComponent(weatherRequestUrl(41.9, 12.42));
    for (const layer of ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']) assert.ok(url.includes(layer), layer);
  });
});
