// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { CLEAR_WEATHER, WEATHER_PRESETS } from '../scene/environment/weather.js';

/** Development-only panel to test the scene: time of day, time-lapse and weather. */
const PRESET_LABELS = {
  clear: 'Clear',
  fewClouds: 'Few clouds',
  cloudy: 'Cloudy',
  overcast: 'Overcast',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  storm: 'Storm',
  snow: 'Snow',
  snowyDay: 'Snow on the ground',
};
const SLIDERS = [
  ['cloudCover', 'Clouds'],
  ['overcast', 'Grey sky'],
  ['rain', 'Rain'],
  ['snow', 'Snow'],
  ['fog', 'Fog'],
  ['storm', 'Storm'],
];
const formatHours = (hours) => {
  const minutes = Math.round(hours * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function createScenePanel(environment) {
  const top = (window.SAFE_AREA_TOP ?? 0) + 48;
  const toggle = element('button', { type: 'button', className: 'dev-button', textContent: 'Scene' });
  toggle.style.top = `${top}px`;

  // Time
  const realTime = element('input', { type: 'checkbox', checked: true });
  const timeSlider = element('input', { type: 'range', min: 0, max: 24, step: 0.25, value: 12 });
  const timeLabel = element('span', { className: 'scene-value' });
  const timeLapse = element('input', { type: 'checkbox' });

  // Weather
  const preset = element('select', {}, [
    element('option', { value: 'live', textContent: 'Live weather' }),
    ...Object.entries(PRESET_LABELS).map(([value, label]) => element('option', { value, textContent: label })),
    element('option', { value: 'custom', textContent: 'Custom' }),
  ]);
  const custom = { ...CLEAR_WEATHER };
  const sliders = new Map();
  // Each slider with its value in %, so what the panel says is what the sky shows
  const percents = new Map();
  const showPercent = (key) => {
    percents.get(key).textContent = `${Math.round(Number(sliders.get(key).value) * 100)}%`;
  };
  const sliderRows = SLIDERS.map(([key, label]) => {
    const input = element('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0 });
    const percent = element('span', { className: 'scene-value' });
    input.addEventListener('input', () => {
      custom[key] = Number(input.value);
      preset.value = 'custom';
      environment.setWeatherOverride(custom);
      showPercent(key);
    });
    sliders.set(key, input);
    percents.set(key, percent);
    return element('label', { className: 'scene-row' }, [element('span', { textContent: label }), input, percent]);
  });
  const wind = element('input', { type: 'range', min: 0, max: 15, step: 0.5, value: 3 });
  wind.addEventListener('input', () => {
    custom.windSpeed = Number(wind.value);
    preset.value = 'custom';
    environment.setWeatherOverride(custom);
  });
  // The ground follows the weather over minutes: these set it right away
  const groundSlider = (key) => {
    const input = element('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0 });
    input.addEventListener('input', () => environment.setGround({ [key]: Number(input.value) }));
    return input;
  };
  const wetGround = groundSlider('wetness');
  const snowGround = groundSlider('snowCover');
  const status = element('div', { className: 'scene-status' });

  const panel = element('div', { className: 'scene-panel', hidden: true }, [
    element('div', { className: 'scene-title', textContent: 'Scene' }),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Real time' }), realTime]),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Time' }), timeSlider, timeLabel]),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Time-lapse' }), timeLapse]),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Weather' }), preset]),
    ...sliderRows,
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Wind' }), wind]),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Wet ground' }), wetGround]),
    element('label', { className: 'scene-row' }, [element('span', { textContent: 'Snow ground' }), snowGround]),
    status,
  ]);
  panel.style.top = `${top + 40}px`;

  const showWeather = (weather) => {
    Object.assign(custom, weather);
    for (const [key, input] of sliders) {
      input.value = weather[key];
      showPercent(key);
    }
    wind.value = weather.windSpeed;
  };

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  realTime.addEventListener('change', () => {
    if (realTime.checked) {
      timeLapse.checked = false;
      environment.setTimeLapse(false);
      environment.setTimeOverride(null);
    } else {
      environment.setTimeOverride(Number(timeSlider.value));
    }
  });
  timeSlider.addEventListener('input', () => {
    realTime.checked = false;
    environment.setTimeOverride(Number(timeSlider.value));
  });
  timeLapse.addEventListener('change', () => {
    if (timeLapse.checked) realTime.checked = false;
    environment.setTimeLapse(timeLapse.checked);
  });
  preset.addEventListener('change', () => {
    if (preset.value === 'live') {
      environment.setWeatherOverride(null);
      showWeather(environment.getStatus().liveWeather);
    } else if (preset.value !== 'custom') {
      showWeather(WEATHER_PRESETS[preset.value]);
      environment.setWeatherOverride(custom);
    }
  });

  // Keep the labels in sync with the scene (twice a second is plenty)
  const refresh = () => {
    if (panel.hidden) return;
    const state = environment.getStatus();
    const hours = state.timeHours ?? (new Date().getHours() + new Date().getMinutes() / 60);
    timeLabel.textContent = formatHours(hours);
    if (state.timeLapse || state.timeHours === null) timeSlider.value = hours;
    if (document.activeElement !== wetGround) wetGround.value = state.wetness;
    if (document.activeElement !== snowGround) snowGround.value = state.snowCover;
    const live = state.liveWeather;
    // On live weather the sliders follow it: it arrives (or changes) after the panel
    // was made, and stale sliders would claim a sky other than the one shown
    if (preset.value === 'live' && ![...sliders.values(), wind].includes(document.activeElement)) showWeather(live);
    const age = state.liveWeatherAgeMinutes;
    status.textContent = age === null
      ? `Live weather not loaded yet · sun ${state.sunAltitude.toFixed(0)}°`
      : `Live: WMO ${state.liveWeatherCode} · clouds ${Math.round(live.cloudCover * 100)}% (model ${Math.round((live.reportedCloudCover ?? live.cloudCover) * 100)}%) · rain ${live.rain.toFixed(1)} · `
        + `snow ${live.snow.toFixed(1)} · ${(live.snowDepthCm ?? 0).toFixed(0)} cm on the ground · `
        + `${Number.isFinite(live.temperature) ? `${live.temperature.toFixed(0)} °C · ` : ''}`
        + `wind ${live.windSpeed.toFixed(0)} m/s · ${age.toFixed(0)} min ago · sun ${state.sunAltitude.toFixed(0)}°`;
  };
  const interval = setInterval(refresh, 500);
  showWeather(environment.getStatus().liveWeather);
  toggle.addEventListener('click', refresh);

  document.body.append(toggle, panel);
  return {
    dispose() {
      clearInterval(interval);
      toggle.remove();
      panel.remove();
    },
  };
}
