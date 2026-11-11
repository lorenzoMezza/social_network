// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The areas `make tiles AREA=…` knows by name: an OpenStreetMap extract of Geofabrik
// (download.geofabrik.de, updated every day) and, for a city, the rectangle to keep
// of it ([west, south, east, north]). Any other Geofabrik id works too (AREA=italy,
// AREA=us/california, …), and BOUNDS=west,south,east,north crops any area.
const AREAS = {
  roma: { extract: 'centro', bounds: [12.23, 41.65, 12.86, 42.15] }, // Roma Capitale
  'new-york': { extract: 'us/new-york', bounds: [-74.26, 40.47, -73.7, 40.92] }, // the five boroughs
  shanghai: { extract: 'shanghai' },
  norvegia: { extract: 'norway' },
  svezia: { extract: 'sweden' },
  danimarca: { extract: 'denmark' },
  // The land nearest the pole: Svalbard reaches 80.8° N. The pole itself is sea ice,
  // with nothing to map, and web maps stop at 85° N.
  'polo-nord': { extract: 'svalbard-janmayen' },
  mondo: { planet: true },
};

export function resolveArea(name, bounds) {
  const area = AREAS[name] ?? { extract: name };
  if (bounds) {
    const numbers = bounds.split(',').map(Number);
    if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) throw new Error(`BOUNDS must be west,south,east,north: ${bounds}`);
    return { ...area, bounds: numbers };
  }
  return area;
}
