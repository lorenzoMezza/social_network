// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

const STICK_RADIUS = 40;

/** Development-only virtual-player toggle and analog touch stick. */
export function createDevPlayerControls(onEnabledChange) {
  let enabled = false;
  let pointerId = null;
  let inputX = 0;
  let inputY = 0;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Virtual player';
  button.setAttribute('aria-pressed', 'false');
  button.style.cssText = [
    'position:fixed',
    `top:${(window.SAFE_AREA_TOP ?? 0) + 6}px`,
    'left:6px',
    'z-index:10',
    'padding:8px 10px',
    'border:1px solid rgba(255,255,255,.35)',
    'border-radius:8px',
    'background:rgba(0,0,0,.68)',
    'color:#fff',
    'font:12px system-ui,sans-serif',
    'touch-action:manipulation',
  ].join(';');

  const stick = document.createElement('div');
  stick.setAttribute('role', 'application');
  stick.setAttribute('aria-label', 'Joystick to move the virtual player');
  stick.style.cssText = [
    'position:fixed',
    'left:18px',
    'bottom:max(24px,env(safe-area-inset-bottom))',
    'z-index:10',
    'width:128px',
    'height:128px',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'border:1px solid rgba(255,255,255,.4)',
    'border-radius:50%',
    'background:rgba(18,30,24,.42)',
    'box-shadow:0 2px 12px rgba(0,0,0,.2)',
    'touch-action:none',
    'user-select:none',
  ].join(';');

  const knob = document.createElement('div');
  knob.style.cssText = [
    'width:48px',
    'height:48px',
    'border:1px solid rgba(255,255,255,.7)',
    'border-radius:50%',
    'background:rgba(245,248,238,.78)',
    'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    'pointer-events:none',
    'will-change:transform',
  ].join(';');
  stick.append(knob);
  document.body.append(button, stick);

  const resetStick = () => {
    pointerId = null;
    inputX = 0;
    inputY = 0;
    knob.style.transform = 'translate(0px, 0px)';
  };

  const moveStick = (event) => {
    if (!enabled || event.pointerId !== pointerId) return;
    const rect = stick.getBoundingClientRect();
    let x = (event.clientX - (rect.left + rect.width / 2)) / STICK_RADIUS;
    let y = (event.clientY - (rect.top + rect.height / 2)) / STICK_RADIUS;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    inputX = x;
    inputY = y;
    knob.style.transform = `translate(${x * STICK_RADIUS}px, ${y * STICK_RADIUS}px)`;
  };

  const onPointerDown = (event) => {
    if (!enabled || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    stick.setPointerCapture?.(pointerId);
    moveStick(event);
  };
  const onPointerMove = (event) => {
    if (pointerId !== event.pointerId) return;
    event.preventDefault();
    moveStick(event);
  };
  const onPointerEnd = (event) => {
    if (pointerId === event.pointerId) resetStick();
  };
  const onToggle = () => {
    enabled = !enabled;
    button.textContent = enabled ? 'Use GPS' : 'Virtual player';
    button.setAttribute('aria-pressed', String(enabled));
    stick.style.display = enabled ? 'flex' : 'none';
    if (!enabled) resetStick();
    onEnabledChange(enabled);
  };

  button.addEventListener('click', onToggle);
  stick.addEventListener('pointerdown', onPointerDown);
  stick.addEventListener('pointermove', onPointerMove);
  stick.addEventListener('pointerup', onPointerEnd);
  stick.addEventListener('pointercancel', onPointerEnd);

  return {
    getInput: () => ({ x: inputX, y: inputY }),
    // Switch the virtual player on or off as if the button were pressed
    setEnabled(value) {
      if (value !== enabled) onToggle();
    },
    dispose() {
      resetStick();
      button.removeEventListener('click', onToggle);
      stick.removeEventListener('pointerdown', onPointerDown);
      stick.removeEventListener('pointermove', onPointerMove);
      stick.removeEventListener('pointerup', onPointerEnd);
      stick.removeEventListener('pointercancel', onPointerEnd);
      button.remove();
      stick.remove();
    },
  };
}
