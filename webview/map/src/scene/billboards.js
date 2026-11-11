// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// Flat things in the scene that always face the camera at a fixed size on screen: the
// names over the people and their speech bubbles. Each one is drawn once with the
// canvas 2D API into a slot of an atlas texture (sharp text, any font), and all of
// them are one instanced quad: a single draw call (one more per ~200 past the first
// page), whatever their number. They sit in the 3D scene: placed at a world point,
// hidden by what stands in front of it.
//
//   const tags = createBillboards({ scene, slotWidth, slotHeight, columns, rows })
//   const slot = tags.acquire(); tags.draw(slot, (ctx) => ({ width, height }))
//   every frame: tags.begin(); tags.push(slot, worldPoint, { y, scale, alpha }); tags.end()
//
// Sizes are CSS pixels; the atlas is drawn at PIXEL_RATIO for sharp text.
const PIXEL_RATIO = 2;

const vertexShader = /* glsl */ `
  attribute vec3 iCenter;
  attribute vec2 iSize;
  attribute vec4 iUv;
  // x, y: shift on screen (CSS px), z: scale
  attribute vec3 iShift;
  attribute float iAlpha;
  uniform vec2 uViewport;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 clip = projectionMatrix * viewMatrix * vec4(iCenter, 1.0);
    // The quad's bottom centre at the world point, grown on screen
    vec2 pixels = vec2(position.x * iSize.x, position.y * iSize.y) * iShift.z + iShift.xy;
    clip.xy += pixels * 2.0 / uViewport * clip.w;
    gl_Position = clip;
    vUv = mix(iUv.xy, iUv.zw, vec2(position.x + 0.5, position.y));
    vAlpha = iAlpha;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 color = texture2D(uAtlas, vUv);
    float alpha = color.a * vAlpha;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color.rgb, alpha);
  }
`;

// Rows of one atlas page at most (its height in device pixels stays within what
// every phone's GPU takes); past that a new page, one more draw call
const MAX_PAGE_HEIGHT = 4096;

export function createBillboards({ scene, slotWidth, slotHeight, columns, rows, renderOrder = 1100 }) {
  const maxRows = Math.max(rows, Math.floor(MAX_PAGE_HEIGHT / (slotHeight * PIXEL_RATIO)));
  const pageCapacity = columns * maxRows;
  const pages = [];

  // A page: its atlas (rows grow, doubling, as slots are taken) and its instanced quad
  const createPage = () => {
    const canvas = document.createElement('canvas');
    canvas.width = slotWidth * columns * PIXEL_RATIO;
    canvas.height = slotHeight * rows * PIXEL_RATIO;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    // The canvas is already in display colours: sampled and written as they are
    texture.colorSpace = THREE.NoColorSpace;

    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    const attribute = (size) => new THREE.InstancedBufferAttribute(new Float32Array(pageCapacity * size), size).setUsage(THREE.DynamicDrawUsage);
    const attributes = { center: attribute(3), size: attribute(2), uv: attribute(4), shift: attribute(3), alpha: attribute(1) };
    geometry.setAttribute('iCenter', attributes.center);
    geometry.setAttribute('iSize', attributes.size);
    geometry.setAttribute('iUv', attributes.uv);
    geometry.setAttribute('iShift', attributes.shift);
    geometry.setAttribute('iAlpha', attributes.alpha);
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uAtlas: { value: texture }, uViewport: { value: new THREE.Vector2(1, 1) } },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'billboards';
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    scene.add(mesh);
    const page = {
      canvas,
      context: canvas.getContext('2d'),
      texture,
      quad,
      geometry,
      attributes,
      material,
      mesh,
      rows,
      count: 0,
      free: Array.from({ length: columns * rows }, (_, index) => columns * rows - 1 - index),
    };
    pages.push(page);
    return page;
  };

  // More rows for a full page: the atlas is copied into a taller one
  const grow = (page) => {
    if (page.rows >= maxRows) return false;
    const next = Math.min(page.rows * 2, maxRows);
    const canvas = document.createElement('canvas');
    canvas.width = page.canvas.width;
    canvas.height = slotHeight * next * PIXEL_RATIO;
    const context = canvas.getContext('2d');
    context.drawImage(page.canvas, 0, 0);
    for (let slot = columns * next - 1; slot >= columns * page.rows; slot--) page.free.unshift(slot);
    page.canvas = canvas;
    page.context = context;
    page.rows = next;
    // A texture of another size: a new one on the GPU
    page.texture.dispose();
    page.texture.image = canvas;
    page.texture.needsUpdate = true;
    return true;
  };

  createPage();
  // Slots are numbered across pages: page × pageCapacity + slot in the page
  const pageOf = (slot) => pages[Math.floor(slot / pageCapacity)];
  const local = (slot) => slot % pageCapacity;
  // slot → { width, height } drawn (CSS px)
  const drawn = new Map();
  // slot → screen rectangle of the last frame, for taps
  const rects = new Map();
  const projected = new THREE.Vector3();
  let viewportWidth = 1;
  let viewportHeight = 1;

  const origin = (slot) => ({
    x: (local(slot) % columns) * slotWidth,
    y: Math.floor(local(slot) / columns) * slotHeight,
  });

  return {
    acquire() {
      for (const [index, page] of pages.entries()) {
        if (!page.free.length) grow(page);
        if (page.free.length) return index * pageCapacity + page.free.pop();
      }
      const page = createPage();
      return (pages.length - 1) * pageCapacity + page.free.pop();
    },
    release(slot) {
      if (slot === null || slot === undefined) return;
      drawn.delete(slot);
      rects.delete(slot);
      pageOf(slot)?.free.push(local(slot));
    },
    // paint(ctx, maxWidth, maxHeight) draws from (0, 0) in CSS px and answers the size used
    draw(slot, paint) {
      if (slot === null || slot === undefined) return;
      const page = pageOf(slot);
      const { context } = page;
      const { x, y } = origin(slot);
      context.save();
      context.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, x * PIXEL_RATIO, y * PIXEL_RATIO);
      context.clearRect(0, 0, slotWidth, slotHeight);
      context.beginPath();
      context.rect(0, 0, slotWidth, slotHeight);
      context.clip();
      const used = paint(context, slotWidth, slotHeight);
      context.restore();
      drawn.set(slot, { width: Math.min(used.width, slotWidth), height: Math.min(used.height, slotHeight) });
      page.texture.needsUpdate = true;
    },
    sizeOf(slot) {
      return drawn.get(slot) ?? null;
    },
    begin(width, height) {
      for (const page of pages) page.count = 0;
      rects.clear();
      viewportWidth = width;
      viewportHeight = height;
    },
    // Shown this frame at `point` (its bottom centre), shifted by `y` CSS px upwards
    push(slot, point, { y = 0, scale = 1, opacity = 1 } = {}, camera = null, viewport = null) {
      const box = drawn.get(slot);
      const page = pageOf(slot);
      if (!box || !page || opacity <= 0.01) return;
      const { center, size, uv, shift, alpha } = page.attributes;
      const { x: sx, y: sy } = origin(slot);
      const width = slotWidth * columns;
      const height = slotHeight * page.rows;
      const n = page.count++;
      center.setXYZ(n, point.x, point.y, point.z);
      size.setXY(n, box.width, box.height);
      uv.setXYZW(n, sx / width, 1 - (sy + box.height) / height, (sx + box.width) / width, 1 - sy / height);
      shift.setXYZ(n, 0, y, scale);
      alpha.setX(n, opacity);
      if (camera && viewport) {
        projected.copy(point).project(camera);
        if (projected.z < 1) {
          const cx = ((projected.x + 1) / 2) * viewport.width;
          const bottom = ((1 - projected.y) / 2) * viewport.height - y;
          rects.set(slot, {
            left: cx - (box.width * scale) / 2,
            right: cx + (box.width * scale) / 2,
            top: bottom - box.height * scale,
            bottom,
            depth: projected.z,
          });
        }
      }
    },
    end() {
      for (const page of pages) {
        page.geometry.instanceCount = page.count;
        page.mesh.visible = page.count > 0;
        page.material.uniforms.uViewport.value.set(viewportWidth, viewportHeight);
        // Only what is drawn goes to the GPU (nothing when the page is empty)
        if (!page.count) continue;
        for (const item of Object.values(page.attributes)) {
          item.clearUpdateRanges();
          item.addUpdateRange(0, page.count * item.itemSize);
          item.needsUpdate = true;
        }
      }
    },
    // The slot under a point of the screen (CSS px, from the canvas' corner), the nearest first
    hit(x, y) {
      let best = null;
      let bestDepth = Infinity;
      for (const [slot, rect] of rects) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom && rect.depth < bestDepth) {
          best = slot;
          bestDepth = rect.depth;
        }
      }
      return best;
    },
    dispose() {
      for (const page of pages) {
        scene.remove(page.mesh);
        page.geometry.dispose();
        page.quad.dispose();
        page.material.dispose();
        page.texture.dispose();
      }
      pages.length = 0;
    },
  };
}

// A rounded rectangle path
export function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, height / 2, width / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
