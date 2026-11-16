// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The live weather of the map: one request to the weather service (Open-Meteo), made
// by the app (src/features/map/hooks/useMapWeather.js) and, in the browser, by the
// map's development page. The map turns the answer into its weather
// (webview/map/src/scene/environment/weather.js: weatherFromOpenMeteo).

// Asked when the map opens, then every WEATHER_REFRESH_MS, or after a journey of
// WEATHER_REFETCH_DISTANCE_KM; after a failure again WEATHER_RETRY_MS later (at once
// when the network comes back). For commercial use Open-Meteo needs its paid API:
// EXPO_PUBLIC_WEATHER_URL (e.g. https://customer-api.open-meteo.com/v1/forecast) and
// EXPO_PUBLIC_WEATHER_KEY.
export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_REFRESH_MS = 30 * 60 * 1000;
export const WEATHER_REFETCH_DISTANCE_KM = 25;
export const WEATHER_RETRY_MS = 5 * 60 * 1000;

// The address of the current weather at a place, with the precipitation of the last
// hours. The coordinates are rounded to about 1 km: enough for weather models (their
// grid is 1–10 km), without sending the exact position. Self-contained (the
// development page inlines it)
export function weatherRequestUrl(latitude, longitude, url = 'https://api.open-meteo.com/v1/forecast', key = null) {
  const params = {
    latitude: latitude.toFixed(2),
    longitude: longitude.toFixed(2),
    current: 'weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_direction_10m,rain,showers,snowfall,snow_depth,temperature_2m',
    hourly: 'precipitation,snowfall',
    // Hourly sums cover the hour before their time: the last 3 hours up to the current one
    past_hours: '2',
    forecast_hours: '1',
    wind_speed_unit: 'ms',
    timezone: 'GMT',
  };
  if (key) params.apikey = key;
  const query = Object.entries(params).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${url}?${query}`;
}

// Kilometres between two places ({ latitude, longitude }), for the journey rule
export function weatherDistanceKm(a, b) {
  const dLat = (b.latitude - a.latitude) * 111;
  const dLon = (b.longitude - a.longitude) * 111 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
