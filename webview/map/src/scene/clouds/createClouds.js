// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { MAP_EDGE_SLOPE } from '../../config.js';
import { coverageLevel, createCloudVolumeTexture, createCloudWeatherTexture } from './cloudNoise.js';
import { fragmentShader, resolveFragmentShader, vertexShader } from './cloudShader.js';

// Fraction of the canvas resolution of the cloud history (per axis): the softness
// of clouds hides it. Each frame marches only a quarter of its pixels (one of each
// 2×2 block, in turn) and reprojects the rest (cloudShader.js).
const RESOLUTION_SCALE = 0.5;
// Order of the pixel marched in each 2×2 block, frame after frame (diagonals
// first, so any two frames in a row cover the block evenly)
const BLOCK_ORDER = [[0, 0], [1, 1], [1, 0], [0, 1]];
// Temporal blend of a freshly marched pixel with its history: seconds of history
// kept (frame-rate independent), within a range of weights. A pixel is marched
// every fourth frame, so the history is longer than with every pixel every frame.
// Long enough to average the jitter of the fine steps (a short history left the 2×2
// pattern of the pixels marched in turn flickering, the far thin clouds sparkling);
// the history stays right while the camera and the clouds move (reprojection, clamp)
const HISTORY_SECONDS = 1.2;
const MIN_HISTORY_WEIGHT = 0.8;
const MAX_HISTORY_WEIGHT = 0.95;
// Camera turn speeds (radians a second) between which the history weighs less
const TURN_SPEED_STILL = 0.15;
const TURN_SPEED_FAST = 1.0;
// Rows of history drawn below the horizon line: bilinear reads of the sky and the
// reprojection never reach undrawn rows
const HORIZON_MARGIN_ROWS = 3;
// Below this cloud cover the sky shows no clouds and nothing is drawn
const MIN_COVER = 0.001;
// With the view still the clouds are drawn again every other frame: between two frames
// they drift a fraction of a pixel (they are kilometres away), so the sky shows the same
// picture and the two passes cost half. Only once the view has been still this long (the
// noise of the last move has settled by then: it settles per pass, not per second), and
// at once every frame again when it turns, zooms or jumps. Still: the view direction
// within STILL_TURN (cosine) and the camera within STILL_MOVE metres of the frame before
// (walking moves it centimetres a frame, against clouds over a kilometre up)
const STILL_SECONDS = 6;
const STILL_TURN = 1 - 1e-8;
const STILL_MOVE = 0.15;

/**
 * Renders the clouds into an offscreen texture before the main pass; the sky
 * composites `texture` where `visible`.
 */
export function createClouds(renderer) {
  const canHalfFloat = renderer.extensions.has('EXT_color_buffer_float')
    || renderer.extensions.has('EXT_color_buffer_half_float');
  const targetOptions = {
    type: canHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  };
  // History (ping-pong) and this frame's marched pixels, a quarter of them
  let targets = [new THREE.WebGLRenderTarget(1, 1, targetOptions), new THREE.WebGLRenderTarget(1, 1, targetOptions)];
  const marchTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions);

  const historySize = new THREE.Vector2(1, 1);
  const blockPixel = new THREE.Vector2();
  const inverseViewProjection = { value: new THREE.Matrix4() };
  const cameraPosition = { value: new THREE.Vector3() };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uInverseViewProjection: inverseViewProjection,
      uCameraPosition: cameraPosition,
      uNoise: { value: createCloudVolumeTexture() },
      uWeatherMap: { value: createCloudWeatherTexture() },
      uHistorySize: { value: historySize },
      uBlockPixel: { value: blockPixel },
      uFrame: { value: 0 },
      uTime: { value: 0 },
      uLightDirection: { value: new THREE.Vector3(0, 1, 0) },
      uLightStrength: { value: 1 },
      uLitColor: { value: new THREE.Color() },
      uShadeColor: { value: new THREE.Color() },
      uHorizonColor: { value: new THREE.Color() },
      uCoverage: { value: 0 },
      uCoverageLevel: { value: 1 },
      uDensity: { value: 1 },
      uOffset: { value: new THREE.Vector2() },
    },
    depthTest: false,
    depthWrite: false,
  });
  const resolveMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: resolveFragmentShader,
    uniforms: {
      uInverseViewProjection: inverseViewProjection,
      uPreviousViewProjection: { value: new THREE.Matrix4() },
      uCloudShift: { value: new THREE.Vector2() },
      uCameraPosition: cameraPosition,
      uMarch: { value: marchTarget.texture },
      uHistory: { value: null },
      uHistorySize: { value: historySize },
      uBlockPixel: { value: blockPixel },
      uHistoryWeight: { value: 0 },
      uTurning: { value: 0 },
      uPreviousMinV: { value: 0 },
      uMarchFirstRow: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  // One triangle covering the screen
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const passScene = new THREE.Scene();
  passScene.add(quad);
  const passCamera = new THREE.OrthographicCamera();

  const size = new THREE.Vector2();
  const viewProjection = new THREE.Matrix4();
  const horizonPoint = new THREE.Vector3();
  let frame = 0;
  let hasHistory = false;
  let visible = false;
  let previousMinV = 0;
  const viewDirection = new THREE.Vector3();
  const previousViewDirection = new THREE.Vector3();
  // The view of the frame before (drawn or not), how long it has been still, the time
  // since the clouds were last drawn, and whether that frame drew them
  const lastDirection = new THREE.Vector3();
  const lastPosition = new THREE.Vector3();
  let lastProjection = 0;
  let stillFor = 0;
  let sinceDrawn = 0;
  let drewLast = false;

  const resize = () => {
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x * RESOLUTION_SCALE));
    const height = Math.max(1, Math.round(size.y * RESOLUTION_SCALE));
    if (targets[0].width === width && targets[0].height === height) return;
    for (const target of targets) target.setSize(width, height);
    marchTarget.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
    historySize.set(width, height);
    hasHistory = false;
  };

  // Lowest row of the screen (0–1 from the bottom) where the sky can show clouds:
  // the camera never rolls, so the horizon is a horizontal line across the screen.
  // The clouds are drawn down to the map's edge, below it (cloudShader.js)
  const horizonRow = (camera) => {
    camera.getWorldDirection(horizonPoint);
    horizonPoint.y = 0;
    if (horizonPoint.lengthSq() < 1e-6) return camera.position.y > 0 ? 0 : 1;
    horizonPoint.normalize();
    horizonPoint.y = -MAP_EDGE_SLOPE;
    horizonPoint.multiplyScalar(1000).add(camera.position).project(camera);
    return horizonPoint.y * 0.5 + 0.5;
  };

  const renderPass = (passMaterial, target, firstRow) => {
    target.scissor.set(0, firstRow, target.width, target.height - firstRow);
    target.scissorTest = true;
    quad.material = passMaterial;
    renderer.setRenderTarget(target);
    renderer.render(passScene, passCamera);
  };

  return {
    // The weather map shaping the clouds (also read for their shadows)
    weatherMap: material.uniforms.uWeatherMap.value,

    // The latest clouds, premultiplied colour + opacity
    get texture() {
      return targets[1].texture;
    },
    // False when no cloud is on screen (clear sky, or no sky in view): the sky
    // then skips reading the texture
    get visible() {
      return visible;
    },

    // Its two passes, for the shader gate (shaderGate.js): each shader made for where it draws
    passes: [material, resolveMaterial].map((passMaterial) => ({
      material: passMaterial,
      compile() {
        resize();
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(targets[0]);
        quad.material = passMaterial;
        renderer.compile(passScene, passCamera);
        renderer.setRenderTarget(previousTarget);
      },
    })),

    render(camera, env, deltaSeconds) {
      resize();
      camera.updateMatrixWorld();
      const minV = horizonRow(camera);
      const firstRow = THREE.MathUtils.clamp(Math.floor(minV * historySize.y) - HORIZON_MARGIN_ROWS, 0, historySize.y);
      visible = env.cloudCover >= MIN_COVER && firstRow < historySize.y;
      if (!visible) {
        // Start afresh when the clouds come back into view
        hasHistory = false;
        return;
      }

      // Still for long enough: every other frame (see STILL_SECONDS)
      camera.getWorldDirection(viewDirection);
      const projection = camera.projectionMatrix.elements[0] + camera.projectionMatrix.elements[5];
      const still = hasHistory && viewDirection.dot(lastDirection) >= STILL_TURN
        && camera.position.distanceToSquared(lastPosition) <= STILL_MOVE * STILL_MOVE && projection === lastProjection;
      lastDirection.copy(viewDirection);
      lastPosition.copy(camera.position);
      lastProjection = projection;
      stillFor = still ? stillFor + deltaSeconds : 0;
      sinceDrawn += deltaSeconds;
      if (stillFor > STILL_SECONDS && drewLast) {
        drewLast = false;
        return;
      }
      drewLast = true;
      // The time since they were drawn, for the history's weight and the camera's turn
      deltaSeconds = sinceDrawn;
      sinceDrawn = 0;

      const u = material.uniforms;
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      inverseViewProjection.value.copy(viewProjection).invert();
      cameraPosition.value.copy(camera.position);
      const block = BLOCK_ORDER[frame % BLOCK_ORDER.length];
      blockPixel.set(block[0], block[1]);
      // Jitter sequence per pixel: it advances once per visit of the pixel
      u.uFrame.value = Math.floor(frame / BLOCK_ORDER.length) % 64;
      frame++;
      u.uTime.value = env.time;

      // Lit by the sun by day and by the moon at night
      const sunUp = env.sunDirection.y > -0.05;
      u.uLightDirection.value.copy(sunUp ? env.sunDirection : env.moonDirection);
      u.uLightDirection.value.y = Math.max(u.uLightDirection.value.y, 0.02);
      u.uLightDirection.value.normalize();
      u.uLightStrength.value = sunUp ? 1 : 0.35 + env.moonIllumination * 0.65;
      u.uLitColor.value.copy(env.cloudLit);
      u.uShadeColor.value.copy(env.cloudShade);
      u.uHorizonColor.value.copy(env.haze);
      u.uCoverage.value = env.cloudCover;
      u.uCoverageLevel.value = coverageLevel(u.uWeatherMap.value, env.cloudCover);
      u.uDensity.value = env.cloudDensity;
      // The weather is read at (point + offset): a cloud moves by minus the offset's
      // change, so the history is found where it was (cloudShader.js uCloudShift)
      resolveMaterial.uniforms.uCloudShift.value.subVectors(env.cloudOffset, u.uOffset.value);
      u.uOffset.value.copy(env.cloudOffset);

      const r = resolveMaterial.uniforms;
      r.uHistory.value = targets[1].texture;
      r.uHistoryWeight.value = hasHistory
        ? THREE.MathUtils.clamp(
          Math.exp((-deltaSeconds * BLOCK_ORDER.length) / HISTORY_SECONDS),
          MIN_HISTORY_WEIGHT,
          MAX_HISTORY_WEIGHT,
        )
        : 0;
      // How fast the camera turns (radians a second)
      camera.getWorldDirection(viewDirection);
      const turnSpeed = hasHistory && deltaSeconds > 0
        ? Math.acos(THREE.MathUtils.clamp(viewDirection.dot(previousViewDirection), -1, 1)) / deltaSeconds
        : 0;
      previousViewDirection.copy(viewDirection);
      r.uTurning.value = THREE.MathUtils.smoothstep(turnSpeed, TURN_SPEED_STILL, TURN_SPEED_FAST);
      r.uPreviousMinV.value = previousMinV;
      r.uMarchFirstRow.value = Math.floor(firstRow / 2);

      const previousTarget = renderer.getRenderTarget();
      renderPass(material, marchTarget, r.uMarchFirstRow.value);
      renderPass(resolveMaterial, targets[0], firstRow);
      renderer.setRenderTarget(previousTarget);

      r.uPreviousViewProjection.value.copy(viewProjection);
      previousMinV = firstRow / historySize.y;
      targets = [targets[1], targets[0]];
      hasHistory = true;
    },

    dispose() {
      for (const target of targets) target.dispose();
      marchTarget.dispose();
      material.dispose();
      resolveMaterial.dispose();
      geometry.dispose();
    },
  };
}
