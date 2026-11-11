// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Piazza (ART-DIRECTION.md): coral-apricot plaster land, indigo roads whose cream edge
// lights up gold at night, sea-green parks, blue water; a cobalt sky falling to lilac
// over a lavender haze, warm on the side of the sun; rose and peach at sunset; a clean
// blue night with the streets drawn in light. The fields: looks/index.js.
const palette = {
  ground: 0xf2c0a0,

  land: 0xf4bc9c,
  hospital: 0xffcadc,
  farmland: 0xf4d48c,
  sand: 0xf8dbaa,

  meadow: { dark: 0x45b394, light: 0x92dcb6, soil: 0x66c09e },
  park: { dark: 0x1f9c86, light: 0x5ccca8, soil: 0x38ad92 },
  woodland: { dark: 0x157f74, light: 0x3cb295, soil: 0x258f80 },
  scrub: { dark: 0x78b896, light: 0xb4dcbc, soil: 0x90c4a4 },
  rock: { dark: 0xc6a08e, light: 0xeacfc0, soil: 0xb58e7e },
  ice: { dark: 0xd2e8f8, light: 0xf8fbff, soil: 0xbad8f0 },

  // Bushes and little trees (scene/vegetation.js): shaded from leaves (below) to
  // leavesLight (on top); some take `tint`, a warmer green
  plants: { leaves: 0x1b8a70, leavesLight: 0x74d6a0, trunk: 0xa0705a, tint: 0xe6f4b0 },

  water: { deep: 0x2370dc, light: 0x4596ee, crest: 0xc6e4ff },
  swimmingPool: { deep: 0x22a8ee, light: 0x66cefa, crest: 0xe2f6ff, waves: 0 },
  waterwayOutline: 0x1f62c8,

  // At night the road turns a clean deep blue: its edge is what lights up
  road: { color: 0x464ab9, lamp: { color: [0.17, 0.18, 0.5], amount: 0.55 } },
  // The street lamps along the edge of every road: gold pools of light
  roadOutline: { color: 0xfff2e6, lamp: { color: [0.9, 0.64, 0.36], amount: 0.78 } },
  rail: 0x2e3088,

  // Warm plaster glass, lighter than the land, with darker walls: the blocks stand
  // out of the streets
  building: 0xfff0e6,
  roof: 0xffeadc,
  buildingOpacity: 0.58,
  buildingShading: { walls: 0.45, occlusion: 0.4 },
};

const atmosphere = [
  {
    altitude: -18,
    zenith: 0x060a2c, horizon: 0x2e3474, haze: 0x30366e, hazeSun: 0x3a3a76,
    light: 0xb0b8f4, lightIntensity: 1.1,
    ambientSky: 0x929ce0, ambientGround: 0x323a64, ambientIntensity: 1.1,
    tint: [0.24, 0.29, 0.64], saturation: 1.08,
    cloudLit: 0x283276, cloudShade: 0x0c1036, stars: 1,
  },
  {
    altitude: -10,
    zenith: 0x0e1648, horizon: 0x3a4088, haze: 0x3c4282, hazeSun: 0x4a4688,
    light: 0xb8b8f2, lightIntensity: 1.1,
    ambientSky: 0x9aa0e0, ambientGround: 0x3a3e68, ambientIntensity: 1.05,
    tint: [0.32, 0.35, 0.72], saturation: 1.08,
    cloudLit: 0x3a4290, cloudShade: 0x141a4e, stars: 0.85,
  },
  {
    altitude: -4,
    zenith: 0x33289a, horizon: 0xe07a96, haze: 0xd486a8, hazeSun: 0xff9a84,
    light: 0xff9fa6, lightIntensity: 1.1,
    ambientSky: 0xaca2de, ambientGround: 0x52406a, ambientIntensity: 1.0,
    tint: [0.76, 0.64, 0.88], saturation: 1.1,
    cloudLit: 0xff9aa0, cloudShade: 0x4e3a8c, stars: 0.3,
  },
  {
    altitude: 0,
    zenith: 0x4650c0, horizon: 0xff9270, haze: 0xfaa894, hazeSun: 0xffb474,
    light: 0xff985a, lightIntensity: 1.3,
    ambientSky: 0x9a9ade, ambientGround: 0x6e4640, ambientIntensity: 0.85,
    tint: [1.0, 0.82, 0.78], saturation: 1.12,
    cloudLit: 0xffa072, cloudShade: 0x825ea4, stars: 0,
  },
  {
    altitude: 6,
    zenith: 0x4a68dc, horizon: 0xffc0a4, haze: 0xf6bcbc, hazeSun: 0xffd4a2,
    light: 0xffca90, lightIntensity: 1.5,
    ambientSky: 0xb0bae8, ambientGround: 0x8c6458, ambientIntensity: 0.9,
    tint: [1.0, 0.94, 0.89], saturation: 1.08,
    cloudLit: 0xffeadb, cloudShade: 0x9a92c8, stars: 0,
  },
  // Day: cobalt above, lilac and lavender low down, a warm haze towards the sun
  {
    altitude: 15,
    zenith: 0x3a70ea, horizon: 0xdcc8ec, haze: 0xdcc6e4, hazeSun: 0xffe2c4,
    light: 0xffeedc, lightIntensity: 1.8,
    ambientSky: 0xc4caee, ambientGround: 0xa07e70, ambientIntensity: 0.9,
    tint: [1.0, 0.98, 0.95], saturation: 1.05,
    cloudLit: 0xfffaf4, cloudShade: 0xa4a2d8, stars: 0,
  },
  {
    altitude: 30,
    zenith: 0x316cee, horizon: 0xd2d0f2, haze: 0xd6d0ee, hazeSun: 0xffe8cc,
    light: 0xfff4e8, lightIntensity: 2.0,
    ambientSky: 0xccd2f2, ambientGround: 0xa88676, ambientIntensity: 0.9,
    tint: [1, 0.99, 0.97], saturation: 1.05,
    cloudLit: 0xffffff, cloudShade: 0xa4a8dc, stars: 0,
  },
];

// A grey sky turns lilac-blue, never neutral
const overcast = {
  zenith: [0x16123a, 0x5862a8],
  horizon: [0x221a48, 0x9ea0cc],
  haze: [0x2a2050, 0xaaa6d0],
  hazeSun: [0x30245a, 0xc4b6d0],
  cloudLit: [0x2a2052, 0xb4b2d6],
  cloudShade: [0x0f0b26, 0x565490],
};

export const piazza = {
  palette,
  atmosphere,
  overcast,
  // Rain cools and darkens a little, it never greys the city out
  weather: {
    greyShade: 0.1,
    stormShade: 0.24,
    rainShade: 0.1,
    rainTint: [-0.24, -0.13, 0.06],
    wet: [0.8, 0.82, 0.96],
    greyDesaturate: 0,
    rainDesaturate: -0.14,
    snowDesaturate: 0.25,
  },
  aerial: { depth: 0.8, whiten: 0.25, air: 0.55, foreground: 0.2, mist: 0.6 },
  // Cloud shadows: lilac pools gliding over the plaster
  shadow: { strength: 0.24, color: [1.0, 0.88, 0.42] },
  // Plaster: warm ochre here, rose there
  paint: { wash: 0.3, drift: [0.2, 0.1, -0.06], hue: [-0.06, -0.16, 0.06] },
  // A tall soft haze above the map's edge: map and sky melt, no line
  horizon: { haze: 0.032 },
  // The far hills: violet shadows of the haze
  hills: [0.6, 0.56, 0.86],
  night: { glow: 0xffa070, glowAmount: 0.05 },
};
