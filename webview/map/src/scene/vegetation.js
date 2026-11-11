// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { look } from '../looks/index.js';
import { addSceneUniforms } from './horizontalFog.js';
import { groundWeather } from './environment/groundWeatherShader.js';

// Plants on the map: small low-poly bushes, and now and then a little tree, only where
// the map data says plants grow (woods, scrub, parks and gardens: the tiles have no
// single trees). Never on lawns, pitches, water, buildings, roads or paths. Sizes are
// in metres, close to the blocks (1.6 m): the bushes about as tall, the trees a little
// taller. Two instanced meshes for every plant of the map, flat colours with baked
// shading like the rest of the map (the environment grades them), swaying a little.
//
// Placement: a grid over each tile, one candidate per cell at a random spot in it (the
// same for a tile every time it loads: the hash of the tile and the cell), kept with
// the chance of the area it falls in.
const CELL = 7; // metres
// Per area of the land cover: chance of a plant in a cell, and the share of trees.
// Sparse on purpose: a third of a first, denser try, which crowded the streets
const AREAS = [
  { match: (p) => p.class === 'wood', chance: 0.17, trees: 0.35 },
  { match: (p) => p.class === 'scrub' || p.subclass === 'scrub', chance: 0.11, trees: 0 },
  { match: (p) => p.subclass === 'garden', chance: 0.035, trees: 0.2 },
  { match: (p) => p.subclass === 'park', chance: 0.027, trees: 0.3 },
];
// Room kept around roads and paths beyond their half width (their edge, and the
// plant's own size), metres; unknown kinds of road take DEFAULT_ROAD_WIDTH
const ROAD_CLEARANCE = 3;
const ROAD_WIDTHS = {
  motorway: 16, trunk: 15, primary: 14, secondary: 12, tertiary: 10, minor: 8,
  service: 5, pedestrian: 4, track: 3, path: 2.5, rail: 4, transit: 4,
};
const DEFAULT_ROAD_WIDTH = 6;
// Green spots (for the fireflies, wildlife.js): points on any green of the land cover,
// lawns included, clear of roads, water and blocks; this share of the cells
const GREEN_CLASSES = new Set(['grass', 'wood', 'scrub', 'wetland']);
const SPOT_CHANCE = 0.25;
const WATERWAY_CLEARANCE = 4;
// Kept away from the blocks by this much (metres)
const BUILDING_CLEARANCE = 2;
// Size (metres, × the shape's own) and how it sways
const BUSH_SCALE = [0.8, 1.2];
const TREE_SCALE = [0.72, 0.86];
const SWAY = 0.035;
// Segments of roads indexed in cells of this size (metres)
const ROAD_GRID = 24;

const hash = (a, b, c) => {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Flat-shaded parts with colours baked by how much each face looks up (the light of
// the sky) and towards the sun side of the map
const shade = (geometry, dark, light) => {
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  const normals = flat.attributes.normal;
  const colors = new Float32Array(normals.count * 3);
  const low = new THREE.Color(dark);
  const high = new THREE.Color(light);
  const color = new THREE.Color();
  for (let i = 0; i < normals.count; i++) {
    const up = normals.getY(i) * 0.5 + 0.5;
    const side = normals.getX(i) * 0.12 - normals.getZ(i) * 0.08;
    color.lerpColors(low, high, THREE.MathUtils.clamp(up * 0.85 + side, 0, 1));
    color.toArray(colors, i * 3);
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  flat.deleteAttribute('uv');
  return flat;
};
const merge = (parts) => {
  const position = [];
  const color = [];
  for (const part of parts) {
    position.push(...part.attributes.position.array);
    color.push(...part.attributes.color.array);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.computeVertexNormals();
  return geometry;
};

function bushGeometry({ leaves, leavesLight }) {
  const main = new THREE.IcosahedronGeometry(0.9, 0).scale(1, 0.72, 1).translate(0, 0.5, 0);
  const side = new THREE.IcosahedronGeometry(0.58, 0).scale(1, 0.8, 1).translate(0.62, 0.36, 0.28);
  return merge([shade(main, leaves, leavesLight), shade(side, leaves, leavesLight)]);
}

function treeGeometry({ leaves, leavesLight, trunk }) {
  const stem = new THREE.CylinderGeometry(0.12, 0.17, 1.3, 5).translate(0, 0.65, 0);
  const crown = new THREE.IcosahedronGeometry(0.95, 0).scale(1, 1.05, 1).translate(0, 1.85, 0);
  return merge([shade(stem, new THREE.Color(trunk).multiplyScalar(0.7), trunk), shade(crown, leaves, leavesLight)]);
}

function plantMaterial() {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    addSceneUniforms(shader);
    shader.uniforms.uPlantClock = { value: groundWeather.surface };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uPlantClock;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // The higher, the more it sways; each plant on its own beat
        float plantPhase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
        float plantSway = position.y * ${SWAY.toFixed(3)} * sin(uPlantClock.w * 1.6 + plantPhase);
        transformed.xz += vec2(plantSway, plantSway * 0.6);`);
  };
  return material;
}

export function createVegetation({ scene, map }) {
  const colors = look.palette.plants;
  const kinds = [bushGeometry(colors), treeGeometry(colors)].map((geometry) => {
    const mesh = new THREE.InstancedMesh(geometry, plantMaterial(), 1);
    mesh.count = 0;
    // Spread over the whole map: the bounds would always be in view
    mesh.frustumCulled = false;
    mesh.name = 'vegetation';
    scene.add(mesh);
    return mesh;
  });

  // Tile (its description, map.getTiles) → its plants in its own frame: Float32Array [x, z, scale, turn, tone, kind]…
  const placed = new WeakMap();
  // Where the plants were last laid out: the tiles and their places on the map
  let layout = [];

  const plantsOf = (tile) => {
    const cached = placed.get(tile);
    if (cached) return cached;
    const size = tile.size;
    const unit = tile.unitsPerMeter;
    if (!size || !unit) return null;
    const features = tile.getFeatures();
    const seed = Math.floor(hash(tile.x, tile.y, tile.zoom) * 2 ** 30);

    const areas = [];
    const greens = [];
    const holes = []; // water, pitches and buildings: polygons no plant stands in
    const roadCells = new Map();
    const box = (rings) => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 2) {
          b[0] = Math.min(b[0], ring[i]); b[1] = Math.min(b[1], ring[i + 1]);
          b[2] = Math.max(b[2], ring[i]); b[3] = Math.max(b[3], ring[i + 1]);
        }
      }
      return b;
    };
    const gridSize = ROAD_GRID * unit;
    const addSegment = (ax, az, bx, bz, clear) => {
      const x0 = Math.floor((Math.min(ax, bx) - clear) / gridSize);
      const x1 = Math.floor((Math.max(ax, bx) + clear) / gridSize);
      const z0 = Math.floor((Math.min(az, bz) - clear) / gridSize);
      const z1 = Math.floor((Math.max(az, bz) + clear) / gridSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const key = gx * 4096 + gz;
          let list = roadCells.get(key);
          if (!list) roadCells.set(key, (list = []));
          list.push(ax, az, bx, bz, clear);
        }
      }
    };
    for (const feature of features) {
      const p = feature.properties ?? {};
      if (feature.type === 'polygon') {
        if (feature.sourceLayer === 'landcover') {
          const area = AREAS.find((a) => a.match(p));
          const shape = { area, rings: feature.geometry, box: box(feature.geometry) };
          if (area) areas.push(shape);
          if (area || GREEN_CLASSES.has(p.class)) greens.push(shape);
        } else if (feature.sourceLayer === 'water' || (feature.sourceLayer === 'landuse' && p.class === 'pitch')) {
          holes.push({ rings: feature.geometry, box: box(feature.geometry) });
        } else if (feature.sourceLayer === 'building') {
          holes.push({ rings: feature.geometry, box: box(feature.geometry) });
          // Kept away from its walls too
          const clear = BUILDING_CLEARANCE * unit;
          for (const ring of feature.geometry) {
            for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) addSegment(ring[j], ring[j + 1], ring[i], ring[i + 1], clear);
          }
        }
      } else if (feature.type === 'line' && (feature.sourceLayer === 'transportation' || feature.sourceLayer === 'waterway')) {
        const width = feature.sourceLayer === 'waterway'
          ? WATERWAY_CLEARANCE * 2
          : ROAD_WIDTHS[p.subclass] ?? ROAD_WIDTHS[p.class] ?? DEFAULT_ROAD_WIDTH;
        const clear = (width / 2 + ROAD_CLEARANCE) * unit;
        for (const line of feature.geometry) {
          for (let i = 0; i + 3 < line.length; i += 2) addSegment(line[i], line[i + 1], line[i + 2], line[i + 3], clear);
        }
      }
    }

    const inside = (rings, x, z) => {
      let result = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) result = !result;
        }
      }
      return result;
    };
    const within = ({ box: b, rings }, x, z) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inside(rings, x, z);
    // Near a road, a path, a river or the walls of a block
    const nearRoad = (x, z) => {
      const list = roadCells.get(Math.floor(x / gridSize) * 4096 + Math.floor(z / gridSize));
      if (!list) return false;
      for (let i = 0; i < list.length; i += 5) {
        const ax = list[i], az = list[i + 1], dx = list[i + 2] - ax, dz = list[i + 3] - az;
        const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        if (Math.hypot(x - ax - dx * t, z - az - dz * t) < list[i + 4]) return true;
      }
      return false;
    };

    const plants = [];
    const spots = [];
    if (greens.length > 0) {
      const step = CELL * unit;
      const cells = Math.ceil(size / step);
      for (let cx = 0; cx < cells; cx++) {
        for (let cz = 0; cz < cells; cz++) {
          const x = (cx + hash(seed, cx, cz)) * step;
          const z = (cz + hash(seed + 1, cx, cz)) * step;
          if (x > size || z > size) continue;
          const plant = hash(seed + 2, cx, cz);
          const spot = hash(seed + 7, cx, cz) < SPOT_CHANCE;
          const found = plant < 0.2 ? areas.find((a) => within(a, x, z) && plant < a.area.chance) : null;
          if (!found && !(spot && greens.some((g) => within(g, x, z)))) continue;
          if (holes.some((h) => within(h, x, z)) || nearRoad(x, z)) continue;
          if (spot) spots.push(x, z);
          if (!found) continue;
          const tree = hash(seed + 3, cx, cz) < found.area.trees ? 1 : 0;
          const [low, high] = tree ? TREE_SCALE : BUSH_SCALE;
          plants.push(x, z, (low + (high - low) * hash(seed + 4, cx, cz)) * unit, hash(seed + 5, cx, cz) * Math.PI * 2, hash(seed + 6, cx, cz), tree);
        }
      }
    }
    const result = { plants: new Float32Array(plants), spots: new Float32Array(spots) };
    placed.set(tile, result);
    return result;
  };

  const matrix = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const tone = new THREE.Color();
  const tones = [new THREE.Color(1, 1, 1), new THREE.Color(colors.tint)];

  const layOut = (tiles) => {
    const lists = tiles.map((tile) => [tile, plantsOf(tile)?.plants]).filter(([, list]) => list);
    const totals = [0, 0];
    for (const [, list] of lists) for (let i = 5; i < list.length; i += 6) totals[list[i]]++;
    kinds.forEach((mesh, kind) => {
      if (mesh.instanceMatrix.count < totals[kind]) {
        const capacity = Math.ceil(totals[kind] * 1.25);
        mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      }
      mesh.count = 0;
    });
    for (const [tile, list] of lists) {
      tile.object3D.updateWorldMatrix(true, false);
      for (let i = 0; i < list.length; i += 6) {
        const mesh = kinds[list[i + 5]];
        turn.setFromAxisAngle(up, list[i + 3]);
        local.compose(at.set(list[i], 0, list[i + 1]), turn, scale.setScalar(list[i + 2]));
        matrix.multiplyMatrices(tile.object3D.matrixWorld, local);
        mesh.setMatrixAt(mesh.count, matrix);
        // A little lighter or darker, some a warmer green
        const t = list[i + 4];
        tone.lerpColors(tones[0], tones[1], t > 0.7 ? 1 : 0).multiplyScalar(0.9 + t * 0.18);
        mesh.setColorAt(mesh.count, tone);
        mesh.count++;
      }
    }
    for (const mesh of kinds) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  // Laid out again when the tiles change or move (a new origin)
  const update = () => {
    const tiles = map.getTiles().filter((tile) => tile.size);
    const changed = tiles.length !== layout.length || tiles.some((tile, i) => {
      const was = layout[i];
      const e = tile.object3D.matrixWorld.elements;
      return !was || was.tile !== tile || was.x !== e[12] || was.z !== e[14] || was.s !== e[0] || !placed.has(tile);
    });
    if (!changed) return;
    layOut(tiles);
    layout = tiles.map((tile) => {
      const e = tile.object3D.matrixWorld.elements;
      return { tile, x: e[12], z: e[14], s: e[0] };
    });
  };

  const stats = () => ({ bushes: kinds[0].count, trees: kinds[1].count });

  // Up to `max` plants (world positions, on the ground) within `radius` of `center`
  const plantsNear = (center, radius, max) => {
    const found = [];
    for (const mesh of kinds) {
      const m = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count && found.length < max; i++) {
        const x = m[i * 16 + 12];
        const z = m[i * 16 + 14];
        if (Math.hypot(x - center.x, z - center.z) < radius) found.push(new THREE.Vector3(x, 0, z));
      }
    }
    return found;
  };

  // Up to `max` green spots (world positions) within `radius` of `center`
  const spot = new THREE.Vector3();
  const spotsNear = (center, radius, max) => {
    const found = [];
    for (const { tile } of layout) {
      const spots = placed.get(tile)?.spots;
      if (!spots) continue;
      for (let i = 0; i < spots.length && found.length < max; i += 2) {
        spot.set(spots[i], 0, spots[i + 1]).applyMatrix4(tile.object3D.matrixWorld);
        if (Math.hypot(spot.x - center.x, spot.z - center.z) < radius) found.push(new THREE.Vector3(spot.x, 0, spot.z));
      }
    }
    return found;
  };

  return { update, stats, plantsNear, spotsNear, meshes: kinds };
}
