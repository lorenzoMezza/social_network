// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * Development-only panel: puts test things in the scene, on this page only (the app
 * and the server never hear of them): events, people (one of them a connection),
 * a crowd, words and a gesture, a lightning strike, a flock of birds.
 * `actions`: the functions the buttons call (main.js).
 */

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const SECTIONS = [
  ['Events', [
    ['Event in front', 'event'],
    ['Live event in front', 'liveEvent'],
    ['10 events around', 'events'],
    ['Remove test events', 'clearEvents'],
  ]],
  ['People', [
    ['Person nearby', 'person'],
    ['Connection nearby', 'friend'],
    ['Crowd of 20', 'crowd'],
    ['They wave and say hi', 'hello'],
    ['Remove test people', 'clearPeople'],
  ]],
  ['Scene', [
    ['Storm with lightning', 'storm'],
    ['Lightning strike now', 'strike'],
    ['Flock of birds now', 'flock'],
  ]],
];

export function createTestPanel(actions) {
  const top = (window.SAFE_AREA_TOP ?? 0) + 48;
  const toggle = element('button', { type: 'button', className: 'dev-button', textContent: 'Test' });
  toggle.style.top = `${top}px`;
  toggle.style.left = '156px';

  const status = element('div', { className: 'scene-status' });
  const children = [element('div', { className: 'scene-title', textContent: 'Test' })];
  for (const [title, buttons] of SECTIONS) {
    children.push(element('div', { className: 'test-section', textContent: title }));
    for (const [label, action] of buttons) {
      const button = element('button', { type: 'button', className: 'teleport-place', textContent: label });
      button.addEventListener('click', () => {
        actions[action]?.();
        status.textContent = actions.status?.() ?? '';
      });
      children.push(button);
    }
  }
  children.push(status);
  const panel = element('div', { className: 'scene-panel test-panel', hidden: true }, children);
  panel.style.top = `${top + 40}px`;

  const onToggle = () => {
    panel.hidden = !panel.hidden;
    status.textContent = actions.status?.() ?? '';
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
