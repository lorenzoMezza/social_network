// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Mapbox Vector Tile 2.1 encoder (github.com/mapbox/vector-tile-spec), for lines and
// polygons: the only geometries the map draws.
//   layers: [{ name, extent, features: [{ type, properties, geometry: [[{ x, y }, …], …] }] }]
// Polygon rings come as @mapbox/vector-tile decodes them: closed (last point = first),
// with their winding (outer rings and holes) unchanged.
import { PbfWriter } from 'pbf';
import { POLYGON } from './rules.mjs';

const command = (id, count) => (id & 7) | (count << 3);
const zigzag = (n) => (n << 1) ^ (n >> 31);

function geometryCommands(type, rings) {
  const out = [];
  let x = 0;
  let y = 0;
  const moveBy = (point) => {
    out.push(zigzag(point.x - x), zigzag(point.y - y));
    x = point.x;
    y = point.y;
  };
  for (const ring of rings) {
    const points = type === POLYGON ? ring.slice(0, -1) : ring; // ClosePath stands for the last point
    out.push(command(1, 1)); // MoveTo
    moveBy(points[0]);
    out.push(command(2, points.length - 1)); // LineTo
    for (let i = 1; i < points.length; i++) moveBy(points[i]);
    if (type === POLYGON) out.push(command(7, 1)); // ClosePath
  }
  return out;
}

function writeValue(value, pbf) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
  else if (Number.isInteger(value)) {
    if (value >= 0) pbf.writeVarintField(5, value);
    else pbf.writeSVarintField(6, value);
  } else pbf.writeDoubleField(3, value);
}

function writeLayer(layer, pbf) {
  const keys = new Map(); // key → index
  const values = new Map(); // type and value → { index, value }: 1 and '1' are two values
  const keyIndex = (key) => {
    if (!keys.has(key)) keys.set(key, keys.size);
    return keys.get(key);
  };
  const valueIndex = (value) => {
    const tagged = `${typeof value}:${value}`;
    if (!values.has(tagged)) values.set(tagged, { index: values.size, value });
    return values.get(tagged).index;
  };
  pbf.writeVarintField(15, 2); // version
  pbf.writeStringField(1, layer.name);
  for (const feature of layer.features) {
    const tags = [];
    for (const [key, value] of Object.entries(feature.properties)) tags.push(keyIndex(key), valueIndex(value));
    pbf.writeMessage(2, (_, out) => {
      out.writePackedVarint(2, tags);
      out.writeVarintField(3, feature.type);
      out.writePackedVarint(4, geometryCommands(feature.type, feature.geometry));
    });
  }
  for (const key of keys.keys()) pbf.writeStringField(3, key);
  for (const { value } of values.values()) pbf.writeMessage(4, writeValue, value);
  pbf.writeVarintField(5, layer.extent);
}

export function encodeTile(layers) {
  const pbf = new PbfWriter();
  for (const layer of layers) if (layer.features.length) pbf.writeMessage(3, writeLayer, layer);
  return pbf.finish();
}
