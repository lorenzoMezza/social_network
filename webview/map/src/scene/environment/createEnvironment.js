// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { MAP_CONFIG, FOG_NEAR, fogFarAt } from '../../config.js';
import { computeSky } from './astronomy.js';
import { createLighting, sampleLighting } from './lightingPalette.js';
import { CLEAR_WEATHER, weatherFromOpenMeteo } from './weather.js';
import { look } from '../../looks/index.js';

// Reported cloud cover → share of the cloud layer to fill, so that the sky looks
// as covered as reported. Measured on screen at the default zoom: towards the
// horizon clouds stack up in perspective (seen cover ≈ 1 − (1 − layer cover)^2.2),
// so the layer needs far fewer clouds than the share reported. Below 10% the sky still keeps a few fair-
// weather clouds, so it never looks empty. Above MAX_CLOUD_COVER the sky looks the
// same: even with a fully overcast report the map keeps gaps of sky.
const MAX_CLOUD_COVER = 0.8;
const SKY_COVER = [[0, 0.09], [0.1, 0.09], [0.3, 0.165], [0.5, 0.27], [0.65, 0.38], [0.8, 0.52]];
const skyCover = (reported) => {
  const cover = Math.min(reported, MAX_CLOUD_COVER);
  const i = SKY_COVER.findIndex(([at]) => at >= cover);
  if (i <= 0) return SKY_COVER[Math.max(i, 0)][1];
  const [a, low] = SKY_COVER[i - 1];
  const [b, high] = SKY_COVER[i];
  return low + ((cover - a) / (b - a)) * (high - low);
};
// Seconds between lightning strikes in a full storm
const LIGHTNING_INTERVAL = [9, 26];
// Share of the strikes whose bolt shows, somewhere along the horizon
const BOLT_SHARE = 0.5;
// Seconds for the scene to settle into new weather
const WEATHER_TRANSITION_SECONDS = 4;
// Clouds drift faster than the ground wind (they are high up), and a bit faster
// still so the movement reads on a phone
const CLOUD_DRIFT_PER_WIND = 9;
// Time-lapse of the developer panel: one day per minute
const TIME_LAPSE_HOURS_PER_SECOND = 24 / 60;
// The sun and moon move a fraction of a degree a minute: their positions are
// computed again after this much clock time (every frame in a time-lapse)
const SKY_REFRESH_MS = 5000;
const WEATHER_KEYS = ['cloudCover', 'overcast', 'rain', 'snow', 'fog', 'storm'];
// The ground follows the weather: it gets wet in about half a minute of rain and
// dries in a few minutes; snow settles in about a minute and melts in five. The
// first live weather sets it at once (real snow depth, rain of the last hours).
const WETTING_PER_SECOND = 1 / 25;
const DRYING_PER_SECOND = 1 / 180;
const SNOW_SETTLING_PER_SECOND = 1 / 60;
const SNOW_MELTING_PER_SECOND = 1 / 300;

// Colours of a grey sky, at night and by day (the look's)
const OVERCAST = Object.fromEntries(
  Object.entries(look.overcast)
    .map(([key, [night, day]]) => [key, [new THREE.Color(night), new THREE.Color(day)]]),
);
const WEATHER_GRADE = look.weather;
const CITY_GLOW = new THREE.Color(look.night.glow);
const FAR_TINT_MAX = 1.35;
const scratch = new THREE.Color();
const wetTint = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const overcastColor = (key, daylight) => scratch.copy(OVERCAST[key][0]).lerp(OVERCAST[key][1], daylight);

// Where the ground is going under this weather (0–1 wet, 0–1 snow)
const groundTarget = (weather) => ({
  wetness: weather.wetGround ?? (weather.rain > 0.05 ? Math.min(1, 0.4 + weather.rain) : 0),
  snowCover: weather.snowGround ?? (weather.snow > 0.05 ? 1 : 0),
});

/**
 * Time of day and weather of the scene. Real by default (clock, player position,
 * live weather: the app asks for it and sends it, setLiveWeather); the developer panel
 * can override both. update() returns the state every part of the scene reads (see
 * the fields of `env` below).
 */
export function createEnvironment() {
  const location = { ...MAP_CONFIG.originLatLon };

  // Live weather and its bookkeeping
  let liveWeather = { ...CLEAR_WEATHER };
  let liveWeatherCode = null;
  let liveWeatherFetchedAt = -Infinity; // Date.now() of the answer
  let groundSettled = false; // the first live weather sets the ground at once

  // Developer overrides (null = real)
  let timeOverrideHours = null;
  let timeLapse = false;
  let weatherOverride = null;
  let groundOverride = null;

  // Weather actually shown, easing towards the target
  const shown = { ...CLEAR_WEATHER };
  const shownWind = new THREE.Vector2();
  const targetWind = new THREE.Vector2();
  let flashTimer = 2;
  let flashAge = Infinity;
  let boltShown = false;
  // A strike asked for (developer panel): shown whatever the storm
  let forcedStrike = false;
  let elapsed = 0;

  const lighting = createLighting();
  const env = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    moonDirection: new THREE.Vector3(0, -1, 0),
    sunAltitude: 90,
    moonIllumination: 0,
    sunVisibility: 1,
    moonVisibility: 0,
    sunColor: new THREE.Color(),
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    haze: new THREE.Color(),
    // The haze on the side of the sun (or moon): the far map and the horizon turn
    // towards it there
    hazeSun: new THREE.Color(),
    lightDirection: new THREE.Vector3(0, 1, 0),
    lightColor: new THREE.Color(),
    lightIntensity: 1,
    shadowStrength: 1,
    ambientSky: new THREE.Color(),
    ambientGround: new THREE.Color(),
    ambientIntensity: 1,
    tint: new THREE.Color(),
    saturation: 1,
    fogNear: FOG_NEAR,
    fogFar: fogFarAt(MAP_CONFIG.originLatLon.lat),
    mist: 0,
    // What far map colours turn towards (the sky's hue), Pokémon GO style
    farTint: new THREE.Color(),
    streetLights: 0,
    stars: 0,
    cloudCover: 0,
    cloudDensity: 1,
    cloudLit: new THREE.Color(),
    cloudShade: new THREE.Color(),
    cloudOffset: new THREE.Vector2(),
    wind: new THREE.Vector2(),
    rain: 0,
    snow: 0,
    wetness: 0,
    snowCover: 0,
    cloudShadowStrength: 0,
    reflection: new THREE.Color(),
    // Glint of the sun (or moon) on glossy surfaces: colour × strength
    glint: new THREE.Color(),
    flash: 0,
    // A bolt seen far away (some strikes): azimuth, seed, brightness
    bolt: new THREE.Vector3(),
    time: 0,
  };

  // An answer of the weather service (Open-Meteo: { current, hourly }), from the app
  const useLiveWeather = (data, fetchedAt) => {
    const first = !Number.isFinite(liveWeatherFetchedAt);
    liveWeather = { ...CLEAR_WEATHER, ...weatherFromOpenMeteo(data) };
    liveWeatherCode = data.current.weather_code;
    liveWeatherFetchedAt = fetchedAt;
    // Opening the map: show the real weather right away, not a transition from clear
    if (first && !weatherOverride) {
      for (const key of WEATHER_KEYS) shown[key] = liveWeather[key];
    }
  };

  // Clock time of the scene (ms since 1970)
  const currentTime = () => {
    if (timeOverrideHours === null) return Date.now();
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime() + timeOverrideHours * 3600 * 1000;
  };
  let skyTime = -Infinity; // clock time of the last sun and moon positions

  const updateLightning = (deltaSeconds) => {
    flashAge += deltaSeconds;
    if (shown.storm > 0.4) {
      flashTimer -= deltaSeconds;
      if (flashTimer <= 0) {
        flashAge = 0;
        boltShown = Math.random() < BOLT_SHARE;
        env.bolt.x = Math.random() * Math.PI * 2;
        env.bolt.y = Math.floor(Math.random() * 1000);
        const [shortest, longest] = LIGHTNING_INTERVAL;
        flashTimer = (shortest + Math.random() * (longest - shortest)) / shown.storm;
      }
    }
    // Two quick pulses, like a real strike
    const pulse = (start) => Math.max(0, 1 - Math.abs(flashAge - start) / 0.06);
    if (flashAge > 0.6) forcedStrike = false;
    const storm = forcedStrike ? 1 : shown.storm;
    // The bolt lasts as long as the two pulses, flickering with them
    env.bolt.z = boltShown && flashAge < 0.32 ? Math.min(1, 0.45 + pulse(0.05) + pulse(0.22) * 0.8) * storm : 0;
    return Math.min(1, pulse(0.05) + pulse(0.22) * 0.7 + Math.max(0, 1 - flashAge / 0.6) * 0.25);
  };

  return {
    env,

    // The live weather the app asked for: { data (the weather service's answer), fetchedAt }
    setLiveWeather({ data, fetchedAt }) {
      if (!data?.current) return;
      useLiveWeather(data, Number.isFinite(fetchedAt) ? fetchedAt : Date.now());
    },
    setLocation(lat, lon) {
      if (lat !== location.lat || lon !== location.lon) skyTime = -Infinity;
      location.lat = lat;
      location.lon = lon;
    },
    setTimeOverride(hours) {
      timeOverrideHours = hours === null ? null : THREE.MathUtils.euclideanModulo(hours, 24);
      skyTime = -Infinity;
    },
    // Developer panel: a lightning strike now, its bolt at this azimuth (radians, as
    // atan2(z, x) of a direction)
    strike(azimuth) {
      flashAge = 0;
      forcedStrike = true;
      boltShown = true;
      env.bolt.x = azimuth;
      env.bolt.y = Math.floor(Math.random() * 1000);
    },
    setTimeLapse(enabled) {
      timeLapse = enabled;
      if (enabled && timeOverrideHours === null) {
        const now = new Date();
        timeOverrideHours = now.getHours() + now.getMinutes() / 60;
      }
    },
    // Developer panel: set the state of the ground (held until the weather changes)
    setGround({ wetness, snowCover }) {
      groundOverride = { ...groundOverride };
      if (wetness !== undefined) groundOverride.wetness = env.wetness = THREE.MathUtils.clamp(wetness, 0, 1);
      if (snowCover !== undefined) groundOverride.snowCover = env.snowCover = THREE.MathUtils.clamp(snowCover, 0, 1);
    },
    setWeatherOverride(weather) {
      weatherOverride = weather ? { ...CLEAR_WEATHER, ...weather } : null;
      groundOverride = null;
    },
    getStatus() {
      return {
        timeHours: timeOverrideHours,
        timeLapse,
        weatherOverride,
        liveWeather,
        liveWeatherCode,
        liveWeatherAgeMinutes: Number.isFinite(liveWeatherFetchedAt)
          ? (Date.now() - liveWeatherFetchedAt) / 60000
          : null,
        sunAltitude: env.sunAltitude,
        wetness: env.wetness,
        snowCover: env.snowCover,
        shown: { ...shown },
      };
    },

    update(deltaSeconds) {
      elapsed += deltaSeconds;
      env.time = elapsed;
      if (timeLapse) {
        timeOverrideHours = THREE.MathUtils.euclideanModulo(
          timeOverrideHours + deltaSeconds * TIME_LAPSE_HOURS_PER_SECOND,
          24,
        );
      }

      // Sun, moon and the colours of this hour
      const now = currentTime();
      if (Math.abs(now - skyTime) >= SKY_REFRESH_MS) {
        skyTime = now;
        const sky = computeSky(now, location.lat, location.lon, env.sunDirection, env.moonDirection);
        env.sunAltitude = sky.sunAltitudeDegrees;
        env.moonIllumination = sky.moonIllumination;
      }
      sampleLighting(env.sunAltitude, lighting);

      // Ease the shown weather towards the target
      const target = weatherOverride ?? liveWeather;
      const ease = 1 - Math.exp(-deltaSeconds / WEATHER_TRANSITION_SECONDS);
      for (const key of WEATHER_KEYS) shown[key] += (target[key] - shown[key]) * ease;
      const toward = THREE.MathUtils.degToRad(target.windDirection + 180);
      targetWind.set(Math.sin(toward), -Math.cos(toward)).multiplyScalar(target.windSpeed);
      shownWind.lerp(targetWind, ease);
      env.wind.copy(shownWind);
      env.cloudOffset.addScaledVector(shownWind, deltaSeconds * CLOUD_DRIFT_PER_WIND);

      const { cloudCover, overcast, rain, snow, fog, storm } = shown;
      const daylight = THREE.MathUtils.smoothstep(env.sunAltitude, -8, 10);
      const grey = Math.min(1, overcast + storm * 0.25);

      env.zenith.copy(lighting.zenith).lerp(overcastColor('zenith', daylight), grey * 0.7);
      env.horizon.copy(lighting.horizon).lerp(overcastColor('horizon', daylight), grey * 0.65);
      env.haze.copy(lighting.haze).lerp(overcastColor('haze', daylight), Math.max(grey * 0.6, fog * 0.6));
      env.hazeSun.copy(lighting.hazeSun).lerp(overcastColor('hazeSun', daylight), Math.max(grey * 0.6, fog * 0.6));
      env.cloudLit.copy(lighting.cloudLit).lerp(overcastColor('cloudLit', daylight), grey * 0.7);
      env.cloudShade.copy(lighting.cloudShade).lerp(overcastColor('cloudShade', daylight), grey * 0.6);
      // Rain and storms darken the whole atmosphere, about as much as they darken
      // the map (its tint below), so the horizon never glows above a dark ground:
      // the sky, the haze where map and sky meet, and the clouds, whose bases turn
      // heavy and dark
      env.zenith.multiplyScalar(1 - storm * 0.45 - rain * 0.15);
      const hazeShade = 1 - storm * 0.38 - rain * 0.14;
      env.horizon.multiplyScalar(hazeShade);
      env.haze.multiplyScalar(hazeShade);
      env.hazeSun.multiplyScalar(hazeShade);
      env.cloudLit.multiplyScalar(1 - storm * 0.4 - rain * 0.15);
      env.cloudShade.multiplyScalar(Math.max(0.25, 1 - storm * 0.6 - rain * 0.3));

      // Direct light: the sun by day, the moon by night
      const sunUp = THREE.MathUtils.smoothstep(env.sunAltitude, -3, 2);
      env.sunVisibility = THREE.MathUtils.smoothstep(env.sunAltitude, -1.5, 1) * (1 - grey);
      env.moonVisibility = THREE.MathUtils.smoothstep(env.moonDirection.y, -0.03, 0.05)
        * (1 - daylight) * (1 - grey * 0.9);
      env.sunColor.copy(lighting.light);
      const lightSource = sunUp > 0.5 || env.moonDirection.y < 0.05 ? env.sunDirection : env.moonDirection;
      env.lightDirection.copy(lightSource);
      // Keep the light above the horizon: long, grazing shadows hide the avatar
      env.lightDirection.y = Math.max(env.lightDirection.y, 0.45);
      env.lightDirection.normalize();
      env.lightColor.copy(lighting.light);
      env.lightIntensity = lighting.lightIntensity * (1 - grey * 0.72);
      env.shadowStrength = (1 - grey * 0.85) * (sunUp > 0.5 ? 1 : 0.45);
      env.ambientSky.copy(lighting.ambientSky);
      env.ambientGround.copy(lighting.ambientGround);
      env.ambientIntensity = lighting.ambientIntensity;

      // Grade of the map colours
      env.flash = updateLightning(deltaSeconds) * (forcedStrike ? 1 : shown.storm);
      const grade = WEATHER_GRADE;
      env.tint.copy(lighting.tint).multiplyScalar(1 - grey * grade.greyShade - storm * grade.stormShade - rain * grade.rainShade);
      // Wet, cool light under rain
      env.tint.multiply(wetTint.setRGB(
        1 + rain * grade.rainTint[0],
        1 + rain * grade.rainTint[1],
        1 + rain * grade.rainTint[2],
      ));
      env.tint.r += env.flash * 0.55;
      env.tint.g += env.flash * 0.6;
      env.tint.b += env.flash * 0.75;
      // Snow brightens and softens the colours of the whole scene
      env.tint.multiplyScalar(1 + snow * 0.08);
      env.saturation = lighting.saturation
        * (1 - grey * grade.greyDesaturate - rain * grade.rainDesaturate - snow * grade.snowDesaturate);

      // The fog distance never changes with the weather (the map must always be
      // readable to its edge): it is complete where the loaded map always reaches, at
      // the player's latitude. Fog and precipitation only make the haze a little
      // denser at the horizon
      env.fogNear = FOG_NEAR;
      env.fogFar = fogFarAt(location.lat);
      env.mist = Math.max(fog, rain * 0.35, snow * 0.5);
      // Far colours take the hue of the sky (aerial perspective, stronger by day)
      env.farTint.copy(env.zenith).lerp(env.horizon, 0.35);
      const farLuma = Math.max(env.farTint.r * 0.2126 + env.farTint.g * 0.7152 + env.farTint.b * 0.0722, 0.02);
      env.farTint.multiplyScalar(1 / farLuma).lerp(WHITE, Math.min(1, look.aerial.whiten + grey * 0.3));
      // A deep blue sky (night) has a tiny luma: never more than this per channel, or
      // the far map would glow saturated blue under the fog
      env.farTint.setRGB(Math.min(env.farTint.r, FAR_TINT_MAX), Math.min(env.farTint.g, FAR_TINT_MAX), Math.min(env.farTint.b, FAR_TINT_MAX));
      // Street lamps are on from dusk to dawn, off before the light gets bright
      env.streetLights = 1 - THREE.MathUtils.smoothstep(env.sunAltitude, -9, -3);
      // The glow of the lit city on the haze and the low sky at night (the look's)
      const cityGlow = env.streetLights * look.night.glowAmount;
      env.haze.lerp(CITY_GLOW, cityGlow);
      env.hazeSun.lerp(CITY_GLOW, cityGlow);
      env.horizon.lerp(CITY_GLOW, cityGlow * 0.5);
      env.stars = lighting.stars;
      env.cloudCover = skyCover(cloudCover);
      env.cloudDensity = 1 + grey * 1.4 + storm * 0.8;
      env.rain = rain;
      env.snow = snow;

      // The ground moves towards the state of the weather: wet while it rains or
      // after recent rain, snow where it lies (measured depth) or while it snows
      const ground = { ...groundTarget(target), ...groundOverride };
      if (!groundSettled && !weatherOverride && Number.isFinite(liveWeatherFetchedAt)) {
        env.wetness = ground.wetness;
        env.snowCover = ground.snowCover;
        groundSettled = true;
      }
      const approach = (value, goal, up, down) => (goal > value
        ? Math.min(goal, value + up * deltaSeconds)
        : Math.max(goal, value - down * deltaSeconds));
      env.wetness = approach(env.wetness, ground.wetness, WETTING_PER_SECOND * Math.max(rain, 0.3), DRYING_PER_SECOND);
      env.snowCover = approach(
        env.snowCover,
        ground.snowCover,
        SNOW_SETTLING_PER_SECOND * Math.max(snow, 0.3),
        SNOW_MELTING_PER_SECOND * (1 + rain * 4),
      );
      // Cloud shadows: clear on sunny days with scattered clouds, gone under a grey sky
      env.cloudShadowStrength = THREE.MathUtils.smoothstep(env.sunAltitude, 2, 15) * (1 - grey * 0.85);
      // What wet surfaces mirror: the lower sky
      env.reflection.copy(env.horizon).lerp(env.zenith, 0.35);
      env.glint.copy(env.sunColor).multiplyScalar(env.sunVisibility * 0.9 + env.moonVisibility * 0.25);
      return env;
    },
  };
}
