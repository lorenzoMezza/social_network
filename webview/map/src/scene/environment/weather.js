// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Weather of the scene: a few 0–1 amounts that the sky, clouds, light and
// precipitation all read, so they always agree with each other.
//   cloudCover  how much of the sky the clouds cover
//   overcast    how grey and dim the light is (thick clouds, rain)
//   rain, snow  precipitation intensity
//   fog         mist: greys the haze (the fog distance never changes)
//   storm       thunderstorm: darker sky and lightning
//   windSpeed   m/s, windDirection degrees (where the wind comes from, like weather reports)
//   wetGround   how wet the ground is (recent rain), snowGround how much of it snow
//               covers (measured snow depth); null = follow the precipitation
export const CLEAR_WEATHER = Object.freeze({
  cloudCover: 0.25, overcast: 0, rain: 0, snow: 0, fog: 0, storm: 0, windSpeed: 3, windDirection: 270,
  wetGround: null, snowGround: null,
});

// Ready-made situations for the developer panel
export const WEATHER_PRESETS = Object.freeze({
  clear: { ...CLEAR_WEATHER, cloudCover: 0.05 },
  fewClouds: { ...CLEAR_WEATHER, cloudCover: 0.3 },
  cloudy: { ...CLEAR_WEATHER, cloudCover: 0.62, overcast: 0.15 },
  overcast: { ...CLEAR_WEATHER, cloudCover: 0.95, overcast: 0.75 },
  fog: { ...CLEAR_WEATHER, cloudCover: 0.7, overcast: 0.45, fog: 1, windSpeed: 1 },
  drizzle: { ...CLEAR_WEATHER, cloudCover: 0.9, overcast: 0.65, rain: 0.3 },
  rain: { ...CLEAR_WEATHER, cloudCover: 1, overcast: 0.85, rain: 0.7, windSpeed: 6 },
  storm: { ...CLEAR_WEATHER, cloudCover: 1, overcast: 1, rain: 1, storm: 1, windSpeed: 11 },
  snow: { ...CLEAR_WEATHER, cloudCover: 0.95, overcast: 0.7, snow: 0.8, windSpeed: 2 },
  snowyDay: { ...CLEAR_WEATHER, cloudCover: 0.2, snowGround: 1 },
});

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

// WMO weather code → precipitation, fog and storm amounts. Used when the model
// reports the weather but no measurable precipitation (or no amounts at all).
function weatherFromCode(code) {
  const amounts = { rain: 0, snow: 0, fog: 0, storm: 0 };
  if (code === 45 || code === 48) amounts.fog = code === 48 ? 1 : 0.8;
  else if (code >= 51 && code <= 57) amounts.rain = [0.2, 0.3, 0.4][Math.min((code - 51) >> 1, 2)];
  else if (code >= 61 && code <= 67) amounts.rain = code === 61 || code === 66 ? 0.45 : code === 63 ? 0.7 : 0.95;
  else if (code >= 71 && code <= 77) amounts.snow = code === 71 ? 0.4 : code === 73 ? 0.7 : 0.95;
  else if (code >= 80 && code <= 82) amounts.rain = [0.5, 0.75, 1][code - 80];
  else if (code === 85 || code === 86) amounts.snow = code === 85 ? 0.6 : 0.95;
  else if (code >= 95) Object.assign(amounts, { rain: 1, storm: 1 });
  return amounts;
}

// How much of the sky each layer of clouds really covers, for someone looking up. A weather
// model's total counts every layer alike, so a thin veil of cirrus at 10 km makes "100%" under
// a sky with the sun or the stars showing through. Low clouds hide the sky, middle ones mostly,
// high ones are nearly see-through. Checked on 2026-11-05 in Rome: airports reporting no cloud
// under 1500 m for hours, models at 100% (low 0, middle 50, high 100), people seeing about half
const LAYER_WEIGHT = { low: 1, mid: 0.7, high: 0.25 };

function seenCloudCover(current) {
  const { cloud_cover_low: low, cloud_cover_mid: mid, cloud_cover_high: high } = current;
  // Without the layers (a copy kept from before, another service): the total as it is
  if (![low, mid, high].every(Number.isFinite)) return current.cloud_cover / 100;
  const clear = (1 - (low / 100) * LAYER_WEIGHT.low) * (1 - (mid / 100) * LAYER_WEIGHT.mid) * (1 - (high / 100) * LAYER_WEIGHT.high);
  // Never more than the total: the layers overlap
  return Math.min(1 - clear, current.cloud_cover / 100);
}

const sum = (values) => (values ?? []).reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

/**
 * Open-Meteo answer (the app asks for it: src/features/map/hooks/useMapWeather.js)
 * → scene weather. Precipitation intensity comes from the
 * measured amounts (mm of rain, cm of snow per hour), the type from the weather
 * code; the ground from the snow depth and the rain of the last hours.
 */
export function weatherFromOpenMeteo({ current, hourly }) {
  const code = current.weather_code;
  const amounts = weatherFromCode(code);
  // current.* precipitation covers the last `interval` seconds (15 minutes)
  const perHour = 3600 / (current.interval || 900);
  const rainRate = ((current.rain ?? 0) + (current.showers ?? 0)) * perHour; // mm/h
  const snowRate = (current.snowfall ?? 0) * perHour; // cm/h
  // 0.5 mm/h is drizzle, 4 mm/h steady rain, 10+ mm/h a downpour; 3 cm/h is heavy snow
  const rain = rainRate > 0.1 ? clamp01(0.15 + Math.sqrt(rainRate / 10) * 0.85) : amounts.rain;
  const snow = snowRate > 0.05 ? clamp01(0.2 + Math.sqrt(snowRate / 3) * 0.8) : amounts.snow;
  const precipitation = Math.max(rain, snow);
  // It cannot rain from a clear sky, whatever the layers say
  const cloudCover = Math.max(seenCloudCover(current), precipitation > 0 ? 0.85 : 0);
  const visibilityFog = Number.isFinite(current.visibility) ? 1 - Math.min(current.visibility / 8000, 1) : 0;

  // The ground: 5 cm of snow cover it all; rain wets it, and it stays wet for a
  // few hours after (less when it is warm)
  const snowDepth = Number.isFinite(current.snow_depth) ? current.snow_depth : 0; // metres
  const recentRain = sum(hourly?.precipitation?.slice(-3)) - sum(hourly?.snowfall?.slice(-3)) * 0.7;
  const warmth = Number.isFinite(current.temperature_2m) ? clamp01((current.temperature_2m - 15) / 15) : 0;
  return {
    cloudCover,
    // The model's total, for the developer panel
    reportedCloudCover: current.cloud_cover / 100,
    // Grey light only under a (nearly) closed sky, rain and storms: a cloudy sky
    // keeps its blue between the clouds
    overcast: Math.min(1, Math.max(0, (cloudCover - 0.8) / 0.2) * 0.6 + precipitation * 0.3 + amounts.storm * 0.25),
    rain,
    snow,
    fog: Math.max(amounts.fog, visibilityFog * 0.8),
    storm: amounts.storm,
    windSpeed: Number.isFinite(current.wind_speed_10m) ? current.wind_speed_10m : 3,
    windDirection: Number.isFinite(current.wind_direction_10m) ? current.wind_direction_10m : 270,
    wetGround: Math.max(rain > 0.05 ? 0.6 + rain * 0.4 : 0, clamp01(recentRain / 1.5) * (1 - warmth * 0.6)),
    snowGround: clamp01(snowDepth / 0.05) ** 0.6,
    snowDepthCm: snowDepth * 100,
    temperature: current.temperature_2m,
  };
}
