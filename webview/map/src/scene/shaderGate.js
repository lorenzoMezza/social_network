// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Nothing waits for a shader. On a first launch shaders take seconds to compile (34 of them,
// one after the other, 6 s on a simulator), and drawing something whose shader is not ready
// stops the whole page until it is: positions, tiles and avatars all wait behind it, though they
// need no shader to arrive. So what is not ready is simply not drawn: every frame goes on, and
// each thing appears as soon as it can. The compiler works through a queue, so what gets handed
// to it first comes first: a few at a time, the most useful first (the sky before the birds),
// and what arrives later (the tiles) overtakes what is still waiting.
//
// Works through KHR_parallel_shader_compile, through which three.js says a program is ready
// without waiting for it. Without it (an old device) a program always says it is ready: then
// the first draw waits, as it always did, one small handover at a time.

// Handed to the compiler at once. More would only fill its queue and lose the priorities
const IN_FLIGHT = 2;

const materialsOf = (object) => (Array.isArray(object.material) ? object.material : object.material ? [object.material] : []);

// `priorityOf(object)`: the smaller, the sooner
export function createShaderGate(renderer, scene, camera, { priorityOf = () => 0 } = {}) {
  const inFlight = new Set();
  // Handed over: they get no second turn, whether or not they got a program
  const handed = new WeakSet();
  // Things drawn apart from the scene: { priority, material, compile(), onReady() }
  const passes = [];
  const hidden = [];
  // The most useful thing this frame could not draw, by its priority
  let firstHidden = Infinity;

  const programOf = (material) => renderer.properties.get(material).currentProgram;

  const handOver = (materials, compile) => {
    compile();
    for (const material of materials) {
      handed.add(material);
      const program = programOf(material);
      if (program && !program.isReady()) inFlight.add(program);
    }
  };

  return {
    // A pass of its own: its compile() is called in its turn, onReady() once its shader is ready
    addPass(pass) {
      passes.push(pass);
    },

    // Whether this object's shader is ready: it would be drawn now
    isReady(object) {
      return materialsOf(object).every((material) => programOf(material)?.isReady());
    },

    // Before drawing the scene: hides what is not ready, hands over what is next
    begin() {
      firstHidden = Infinity;
      for (const program of inFlight) if (program.isReady()) inFlight.delete(program);
      const waiting = [];
      // Every frame, for every object of the scene (the bones of the avatars too), for as
      // long as the map is open: nothing is made here for what is ready, which is nearly
      // always everything
      scene.traverseVisible((object) => {
        const material = object.material;
        if (!material) return;
        let ready = true;
        let unhanded = false;
        if (Array.isArray(material)) {
          for (const one of material) {
            if (!one.visible) continue;
            const program = programOf(one);
            if (program ? !program.isReady() : !handed.has(one)) ready = false;
            if (!handed.has(one)) unhanded = true;
          }
        } else if (material.visible) {
          const program = programOf(material);
          if (program ? !program.isReady() : !handed.has(material)) ready = false;
          if (!handed.has(material)) unhanded = true;
        }
        if (ready) return;
        hidden.push(object);
        firstHidden = Math.min(firstHidden, priorityOf(object));
        if (unhanded) waiting.push(object);
      });
      for (const object of hidden) object.visible = false;

      for (let i = passes.length - 1; i >= 0; i--) {
        const pass = passes[i];
        if (handed.has(pass.material) && programOf(pass.material)?.isReady()) {
          passes.splice(i, 1);
          pass.onReady?.();
        }
      }
      if (inFlight.size >= IN_FLIGHT || (!waiting.length && !passes.length)) return;
      const queue = [
        ...waiting.map((object) => ({ priority: priorityOf(object), object })),
        ...passes.filter((pass) => !handed.has(pass.material)).map((pass) => ({ priority: pass.priority, pass })),
      ].sort((a, b) => a.priority - b.priority);
      for (const next of queue) {
        if (inFlight.size >= IN_FLIGHT) break;
        if (next.pass) {
          handOver([next.pass.material], next.pass.compile);
          continue;
        }
        const materials = materialsOf(next.object).filter((material) => !handed.has(material));
        if (materials.length) handOver(materials, () => renderer.compile(next.object, camera, scene));
      }
    },

    // After drawing it: what was hidden is back in the scene
    end() {
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
    },

    // Whether this frame drew everything that matters up to this priority
    drewUpTo(priority) {
      return firstHidden > priority;
    },
  };
}
