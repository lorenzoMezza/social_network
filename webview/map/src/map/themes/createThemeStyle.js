// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { MapStyle } from 'lm-three-geo-play';
import { createLampMaterial, createMottledGroundMaterial, createWaterMaterial } from './groundShader.js';
import { groundWeather } from '../../scene/environment/groundWeatherShader.js';

// Road widths in metres for the single daytime style.
const ROAD_WIDTHS = {
  motorway: 16,
  trunk: 15,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  minor: 8,
  service: 5,
  pedestrian: 4,
  track: 3,
  path: 2.5,
};
// Width of the edge around every road in metres (half on each side): the same for
// every kind of road, so the network reads as one drawing
const ROAD_OUTLINE_WIDTH = 3.2;
const SANDS = ['sand', 'beach', 'dune'];
const ROCKS = ['rock', 'bare_rock', 'scree'];
const ICE = ['ice', 'glacier'];

// Flat, unlit tile fills: MeshBasicMaterial keeps the colours consistent on mobile
// (the environment tints them all together) and is shared with the GPS fallback ground.
// `surface` sets how the weather treats it (groundWeatherShader.js: SCENE_GLOSS,
// SCENE_SHEEN, SCENE_SNOW).
const flat = (color, surface) => withSurface(new THREE.MeshBasicMaterial({ color }), surface);

function withSurface(material, surface = {}) {
  const defines = {};
  for (const [key, value] of Object.entries(surface)) defines[`SCENE_${key.toUpperCase()}`] = value.toFixed(2);
  material.defines = { ...material.defines, ...defines };
  return material;
}

// Snow never settles on roads and water: they stay readable in winter. Roads
// stay matte, without cloud shadows: patches of sky or shadow gliding over the
// dark streets looked like strange reflections of the clouds
const ROAD_SURFACE = { gloss: 0, snow: 0, shade: 0 };
const ROAD_EDGE_SURFACE = { gloss: 0, snow: 0, shade: 0 };
const WATER_SURFACE = { gloss: 1, sheen: 0.55, sparkle: 0.7, snow: 0 };

export function createThemeStyle(palette) {
  const style = new MapStyle();
  const grass = createMottledGroundMaterial({ ...palette.meadow, scale: 0.022 });
  const park = createMottledGroundMaterial({ ...palette.park, scale: 0.024 });
  const woodland = createMottledGroundMaterial({ ...palette.woodland, scale: 0.02 });
  const scrub = createMottledGroundMaterial({ ...palette.scrub, scale: 0.023 });
  const rock = createMottledGroundMaterial({ ...palette.rock, scale: 0.03 });
  const ice = withSurface(createMottledGroundMaterial({ ...palette.ice, scale: 0.012 }), { sheen: 0.35 });
  // Grass and shrubs poke through the snow: it covers them a little less
  for (const material of [grass, park, woodland, scrub]) withSurface(material, { gloss: 0.3, snow: 0.8 });

  style.backgroundLayer.material = flat(palette.ground);
  // Player shadows are received by a small local plane attached to the avatar,
  // never by the full map or the see-through buildings.
  style.shadowLayer.isVisible = false;

  // Land use: all built-up land (homes, shops, offices, industry, schools,
  // stations, car parks, sports grounds…) is one colour, so the map reads as
  // streets and nature, not as a zoning plan; only hospitals stand out. One shared
  // material also means one draw per tile for all of them.
  const landUse = style.landUseLayer;
  const land = flat(palette.land);
  landUse.setAllMaterials(land);
  landUse.hospital.material = flat(palette.hospital);
  landUse.farmland.material = flat(palette.farmland, { gloss: 0.3 });
  landUse.recreation_ground.material = park;
  landUse.cemetery.material = park;
  landUse.zoo.material = park;

  // Green areas share a small set of materials by biome to keep tile batches
  // compact while distinguishing fields, parks, woodland and scrub. Protected areas
  // show only where nothing else is mapped (they are drawn under all land use):
  // countryside, so meadow rather than the tended green of city parks.
  landUse.nature_reserve.material = grass;
  landUse.protected_area.material = grass;
  landUse.pitch.material = grass;
  landUse.quarry.material = scrub;

  // Land cover: all park, then woods and sand
  const landCover = style.landCoverLayer;
  landCover.setAllMaterials(grass);
  for (const name of ['wood', 'forest', 'mangrove']) {
    landCover[name].material = woodland;
  }
  for (const name of [
    'scrub', 'shrubbery', 'heath', 'fell', 'tundra', 'bog', 'wetland',
    'marsh', 'swamp', 'reedbed', 'saltmarsh', 'tidalflat',
  ]) {
    landCover[name].material = scrub;
  }
  for (const name of [
    'park', 'orchard', 'garden', 'allotments', 'flowerbed', 'plant_nursery',
    'golf_course', 'recreation_ground', 'village_green', 'vineyard',
  ]) landCover[name].material = park;
  const sand = flat(palette.sand, { gloss: 0.3 });
  for (const name of SANDS) landCover[name].material = sand;
  for (const name of ROCKS) landCover[name].material = rock;
  // Glaciers and permanent ice from the map data: icy and glinting in any weather
  for (const name of ICE) landCover[name].material = ice;
  for (const name of ['grass', 'grassland', 'meadow', 'wet_meadow']) {
    landCover[name].material = grass;
  }
  landCover.farmland.material = landUse.farmland.material;

  // Water: stylised, with drifting tones, gliding wave strokes and sparkles
  // (groundShader.js); glossy, it mirrors the sky at grazing angles and glints in
  // the sun. Pools are lighter and clearer.
  const water = withSurface(createWaterMaterial(palette.water, groundWeather.surface), WATER_SURFACE);
  style.waterLayer.setAllMaterials(water);
  style.waterLayer.swimming_pool.material = withSurface(
    createWaterMaterial(palette.swimmingPool, groundWeather.surface),
    WATER_SURFACE,
  );
  style.waterwayLayer.setAllMaterials(water, flat(palette.waterwayOutline, { snow: 0 }));

  // Roads: flat colours; at night the edge is the street lamps' light, in pools, and
  // the road itself a deep blue
  const roads = style.transportationLayer;
  style.transportationLayer.setJointSegmentsAll(8);
  roads.setAllMaterials(
    withSurface(createLampMaterial(palette.road.color, palette.road.lamp), ROAD_SURFACE),
    withSurface(createLampMaterial(palette.roadOutline.color, palette.roadOutline.lamp, { pools: true }), ROAD_EDGE_SURFACE),
  );
  for (const [name, width] of Object.entries(ROAD_WIDTHS)) {
    roads[name].lineWidthMeters = width;
    roads[name].outlineWidthMeters = ROAD_OUTLINE_WIDTH;
  }
  // Country tracks are hidden by the library's default style
  roads.track.isVisible = true;
  // Flat streets, as in Pokémon GO: a bridge's edges never cut into the road it joins
  roads.raisedOutlines = false;

  // Buildings: frosted glass with pearl roofs. Unlit like the rest of the map (the
  // environment tints them): the baked wall shading and ambient occlusion give
  // them their volume, and the roofs keep a clean colour at any hour.
  const buildings = style.buildingLayer;
  buildings.material = new THREE.MeshBasicMaterial({
    color: palette.building,
    vertexColors: true,
    transparent: true,
    opacity: palette.buildingOpacity,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  buildings.material.defines = { SCENE_SEE_THROUGH: '' };
  // Keep the see-through building look. Transparent facades let light pass
  // through and are excluded from shadow casting by the tile batch manager;
  // they also do not receive the avatar's shadow. Opaque map surfaces still
  // receive the avatar's directional shadow.
  buildings.castShadow = false;
  buildings.receiveShadow = false;
  buildings.simpleExtrusion = true; // plain footprint prisms from the ground: fewer triangles
  buildings.mergeBlocks = true; // attached buildings merged: one extruded outline (with courtyards) per block
  buildings.blockHeight = 4; // metres, the same for every block (× height below)
  buildings.roofColor = palette.roof;
  buildings.height = 0.4;
  buildings.wallShading = palette.buildingShading.walls;
  buildings.ambientOcclusion = palette.buildingShading.occlusion;
  buildings.colorVariation = 0.08;

  // Railways in relief: beds of the buildings' glass (the same batch and depth
  // prepass: one draw call with the buildings, blended once where they meet) and two
  // opaque rails on top. Lower than the 1.6 m blocks, so they read as tracks.
  const rails = style.railwayLayer;
  rails.setAllMaterials(buildings.material, flat(palette.rail, { snow: 0 }));
  for (const type of Object.values(rails.types)) {
    type.bedHeightMeters = 0.6;
    type.railWidthMeters = 0.2;
    type.railHeightMeters = 0.12;
    type.wallShading = buildings.wallShading;
    type.ambientOcclusion = buildings.ambientOcclusion;
  }

  return style;
}
