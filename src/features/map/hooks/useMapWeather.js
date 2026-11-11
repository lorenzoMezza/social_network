// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import {
  WEATHER_REFETCH_DISTANCE_KM, WEATHER_REFRESH_MS, WEATHER_RETRY_MS, WEATHER_URL, weatherDistanceKm, weatherRequestUrl,
} from '../../../../webview/shared/weatherRequest';

// The last answer, kept on the phone: the map shows it at once at the next start
const STORAGE_KEY = 'map-weather:v2';
const URL = process.env.EXPO_PUBLIC_WEATHER_URL || WEATHER_URL;
const KEY = process.env.EXPO_PUBLIC_WEATHER_KEY || null;
// How often the rules below are looked at while the map is open
const CHECK_MS = 60 * 1000;

/**
 * The live weather at the player, for the map (mapRef: MapWebView): asked of the weather
 * service when the map opens (the copy kept on the phone is shown meanwhile), every
 * half hour, after a long journey, again a few minutes after a failure and at once
 * when the network comes back. The map makes no request of its own but its tiles and
 * avatar files. `here`: { latitude, longitude } (every 20 m), or null.
 */
export function useMapWeather(mapRef, here) {
  const hereRef = useRef(here);
  // { data, fetchedAt, latitude, longitude }
  const latest = useRef(null);
  const asking = useRef(false);
  const nextTry = useRef(0);

  const send = useCallback((entry) => mapRef.current?.setWeather({ data: entry.data, fetchedAt: entry.fetchedAt }), [mapRef]);

  const refresh = useCallback(async ({ now = false } = {}) => {
    const at = hereRef.current;
    if (!at || asking.current) return;
    const last = latest.current;
    const fresh = last && Date.now() - last.fetchedAt < WEATHER_REFRESH_MS && weatherDistanceKm(last, at) < WEATHER_REFETCH_DISTANCE_KM;
    if (fresh || (!now && Date.now() < nextTry.current)) return;
    asking.current = true;
    try {
      const response = await fetch(weatherRequestUrl(at.latitude, at.longitude, URL, KEY));
      if (!response.ok) throw new Error(`weather: HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.current) throw new Error('weather: no current conditions');
      // About 1 km is all the weather needs: the phone keeps no exact place in it
      const entry = { data, fetchedAt: Date.now(), latitude: Math.round(at.latitude * 100) / 100, longitude: Math.round(at.longitude * 100) / 100 };
      latest.current = entry;
      send(entry);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entry)).catch(() => {});
    } catch {
      // Clear skies meanwhile; tried again later, or as soon as the network is back
      nextTry.current = Date.now() + WEATHER_RETRY_MS;
    } finally {
      asking.current = false;
    }
  }, [send]);

  // The copy on the phone first, if it is about here
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (!alive || latest.current || !stored) return;
      const entry = JSON.parse(stored);
      if (!entry?.data?.current || !Number.isFinite(entry.fetchedAt)) return;
      const at = hereRef.current;
      if (at && weatherDistanceKm(entry, at) >= WEATHER_REFETCH_DISTANCE_KM) return;
      latest.current = entry;
      send(entry);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [send]);

  // When the player is known or moved, and every minute while the map is open
  useEffect(() => {
    hereRef.current = here;
    refresh();
  }, [here, refresh]);
  useEffect(() => {
    const timer = setInterval(() => refresh(), CHECK_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useNetworkRecovery(useCallback(() => refresh({ now: true }), [refresh]));
}
