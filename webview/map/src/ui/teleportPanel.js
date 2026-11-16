// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * Development-only panel: moves the player to a few places in Rome. Coordinates
 * from OpenStreetMap (Nominatim); Via Filippo Ermini has no house numbers mapped,
 * so number 68 is the middle of the street (about 200 m long).
 */
const TELEPORT_PLACES = Object.freeze([
  { label: 'Via Filippo Ermini 68', latitude: 41.89939, longitude: 12.43713 },
  { label: 'Colosseo', latitude: 41.89021, longitude: 12.49223 },
  { label: 'EUR · Piazza Marconi', latitude: 41.83361, longitude: 12.47088 },
  { label: 'Ostia · Piazza Anco Marzio', latitude: 41.72987, longitude: 12.27789 },
  { label: 'New York · City Hall', latitude: 40.71280, longitude: -74.00600 },
]);

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function createTeleportPanel(onTeleport) {
  const top = (window.SAFE_AREA_TOP ?? 0) + 48;
  const toggle = element('button', { type: 'button', className: 'dev-button', textContent: 'Teleport' });
  toggle.style.top = `${top}px`;
  toggle.style.left = '70px';

  const buttons = TELEPORT_PLACES.map((place) => {
    const button = element('button', { type: 'button', className: 'teleport-place', textContent: place.label });
    button.addEventListener('click', () => {
      panel.hidden = true;
      onTeleport(place);
    });
    return button;
  });
  const panel = element('div', { className: 'scene-panel', hidden: true }, [
    element('div', { className: 'scene-title', textContent: 'Teleport' }),
    ...buttons,
  ]);
  panel.style.top = `${top + 40}px`;

  const onToggle = () => {
    panel.hidden = !panel.hidden;
  };
  toggle.addEventListener('click', onToggle);
  document.body.append(toggle, panel);

  return {
    dispose() {
      toggle.removeEventListener('click', onToggle);
      toggle.remove();
      panel.remove();
    },
  };
}
