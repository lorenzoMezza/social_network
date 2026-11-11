// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

export function handleResize(camera, renderer) {
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}
