// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { look } from '../../looks/index.js';
import { createThemeStyle } from './createThemeStyle.js';
import { FOG_NEAR, MAP_CONFIG, fogFarAt } from '../../config.js';

// Apply the map palette. Sky, fog colour and fog distance are set every frame by
// the environment (time of day and weather), see scene/environment/.
export function applyTheme(geo, scene) {
  const style = createThemeStyle(look.palette);
  geo.setMapStyle(style);
  const fallbackGround = scene.getObjectByName('gps-fallback-ground');
  if (fallbackGround) {
    fallbackGround.material = style.backgroundLayer.material;
    fallbackGround.position.y = style.backgroundLayer.Y;
    fallbackGround.renderOrder = style.backgroundLayer.renderingOrder;
    fallbackGround.receiveShadow = style.backgroundLayer.receiveShadow;
    fallbackGround.castShadow = style.backgroundLayer.castShadow;
  }
  // The fog is complete where the loaded map always reaches (config.js fogFarAt; the
  // environment keeps it so at the player's latitude)
  scene.fog = new THREE.Fog(0xffffff, FOG_NEAR, fogFarAt(MAP_CONFIG.originLatLon.lat));
}
