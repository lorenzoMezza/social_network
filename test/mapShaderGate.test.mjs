// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What draws while shaders compile (webview/map/src/scene/shaderGate.js)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createShaderGate } = await import('../webview/map/src/scene/shaderGate.js');

// A renderer whose programs get ready when the test says so
function world(names) {
  const properties = new Map();
  const compiled = [];
  const renderer = {
    properties: { get: (material) => { if (!properties.has(material)) properties.set(material, {}); return properties.get(material); } },
    compile(object) {
      compiled.push(object.name);
      const material = object.material;
      properties.set(material, { currentProgram: { ready: false, isReady() { return this.ready; } } });
    },
  };
  const objects = names.map((name) => ({ name, visible: true, material: { visible: true, name } }));
  const scene = { traverseVisible: (visit) => objects.filter((object) => object.visible).forEach(visit) };
  const finish = (name) => { renderer.properties.get(objects.find((object) => object.name === name).material).currentProgram.ready = true; };
  return { renderer, scene, objects, compiled, finish };
}

describe('the shader gate', () => {
  it('hides what is not ready, then shows it, and leaves objects visible after the frame', () => {
    const { renderer, scene, objects, finish } = world(['sky']);
    const gate = createShaderGate(renderer, scene, {});
    gate.begin();
    assert.equal(objects[0].visible, false, 'drawn while compiling');
    gate.end();
    assert.equal(objects[0].visible, true);
    finish('sky');
    gate.begin();
    assert.equal(objects[0].visible, true, 'hidden though ready');
    assert.ok(gate.isReady(objects[0]));
    gate.end();
  });

  it('hands over a few at a time, the most useful first, and later arrivals overtake', () => {
    const { renderer, scene, objects, compiled, finish } = world(['birds', 'clouds', 'sky', 'ground']);
    const order = { sky: 0, ground: 1, clouds: 5, birds: 9, roads: 2 };
    const gate = createShaderGate(renderer, scene, {}, { priorityOf: (object) => order[object.name] });
    gate.begin();
    gate.end();
    assert.deepEqual(compiled, ['sky', 'ground']);
    finish('sky');
    finish('ground');
    objects.push({ name: 'roads', visible: true, material: { visible: true } });
    gate.begin();
    gate.end();
    assert.deepEqual(compiled, ['sky', 'ground', 'roads', 'clouds']);
  });

  it('says whether a frame drew everything up to a priority', () => {
    const { renderer, scene, finish } = world(['sky', 'birds']);
    const order = { sky: 0, birds: 9 };
    const gate = createShaderGate(renderer, scene, {}, { priorityOf: (object) => order[object.name] });
    gate.begin(); gate.end();
    assert.equal(gate.drewUpTo(5), false, 'the sky was not drawn');
    finish('sky');
    gate.begin(); gate.end();
    assert.equal(gate.drewUpTo(5), true, 'only the birds are left');
    assert.equal(gate.drewUpTo(9), false);
    finish('birds');
    gate.begin(); gate.end();
    assert.equal(gate.drewUpTo(9), true);
  });

  it('hands every material over only once', () => {
    const { renderer, scene, compiled } = world(['sky']);
    const gate = createShaderGate(renderer, scene, {});
    for (let i = 0; i < 5; i++) { gate.begin(); gate.end(); }
    assert.deepEqual(compiled, ['sky']);
  });

  it('runs a pass of its own once its shader is ready, in its turn', () => {
    const { renderer, scene, finish } = world(['sky']);
    const gate = createShaderGate(renderer, scene, {}, { priorityOf: () => 0 });
    const material = {};
    let compiled = 0;
    let ran = 0;
    gate.addPass({ priority: 5, material, compile() { compiled++; renderer.properties.get(material).currentProgram = { isReady: () => compiled > 0 && ran >= 0 }; }, onReady() { ran++; } });
    gate.begin(); gate.end();
    finish('sky');
    for (let i = 0; i < 4; i++) { gate.begin(); gate.end(); }
    assert.equal(compiled, 1);
    assert.equal(ran, 1);
  });

  it('never hides what got no program at all: it would stay hidden for good', () => {
    const { scene, objects } = world(['odd']);
    const renderer = { properties: { get: () => ({}) }, compile() {} };
    const gate = createShaderGate(renderer, scene, {});
    gate.begin(); gate.end();
    gate.begin();
    assert.equal(objects[0].visible, true);
    gate.end();
  });
});
