// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Keeps the map fluid where the GPU cannot draw every pixel of the screen in time: when
// frames keep arriving late because the GPU takes too long over them, the canvas
// resolution drops one small step (a small drop is hard to see, a stutter is not).
// The map starts at the screen's full density, up to MAX_PIXEL_RATIO, and stays
// there wherever the phone keeps up.
//
// Measured over windows of a few seconds of steady rendering only: windows with tiles
// loading or being built (main-thread work, not pixels) or with long pauses (page
// hidden, app in background, garbage collection) count nothing. Late frames alone do
// not say the pixels are the cause: the main thread may be busy, or the system may
// cap the frame rate (iOS Low Power Mode, a hot phone: 30 fps). So a few frames of
// each window are timed on the GPU itself: a fence after the frame, looked at from
// later tasks until it is passed (WebKit calls the next frame only once the previous
// one is on screen, so a fence looked at then is always passed and tells nothing).
// Only when the GPU needs more than a frame's time is the resolution lowered, at once
// to the step where it should be in time again (its work grows with the pixels, the
// square of the density), so the map stutters for one window at most; the next
// windows correct it if needed.
// It goes back up one step when the GPU has plenty of room again (the scene got
// lighter, the phone cooled): the GPU's own time says so whatever the frame rate, and
// only when the next density up should still take it well under a frame
// (UP_SHARE of the budget) for UP_WINDOWS windows in a row. Not for a while after a
// step down (UP_COOLDOWN_MS); a density reached going up that had to be left again
// soon after is tried again only later, twice as late each time, so it never keeps
// going up and down.
//
// The frame rate asked for is not always the one the phone can show. In Low Power Mode
// iOS calls the page 30 times a second, whatever it draws; some screens refresh 30 times
// a second, or are set to by a battery saver. Frames then come "late" for ever and the
// GPU, slowed down too, may take longer than a frame of the rate asked for: the
// resolution was lowered for nothing, since no resolution brings back frames the
// display does not show. So everything here is judged against the rate the display
// really gives (`frameInterval`): the one asked for, or the display's when it is slower.
// The display's rate is known in two ways:
//  - the app says so (setDisplayLimit: Low Power Mode on an iPhone, MapWebView);
//  - the page measures it. Every call of the browser's frame loop is told here
//    (displayTick), drawn or not: calls closer together than the rate asked for mean the
//    display is fast enough. When every call is far apart the display may be slow, or
//    the GPU may be: the two look the same from the calls alone. Only then, and only
//    before lowering the resolution, a few frames are not drawn (PROBE_TICKS, about a
//    tenth of a second): with nothing to draw the calls come at the display's own rate.
//    A slow display found this way is believed until calls come faster again, and
//    looked at again now and then (REPROBE_MS) while it is what keeps the resolution up.
const PIXEL_RATIO_STEPS = [2, 1.75, 1.5, 1.25, 1];
// The display is slower than the rate asked for when its calls are this many times the
// asked interval apart, or more (30 fps for 42 asked: 1.4; a 60 Hz screen: 0.7)
const SLOW_DISPLAY = 1.25;
// Calls of the frame loop listened to for the display's own rate: the first still waits
// for the frame drawn before it, the others (three frames left undrawn) are the display's
const PROBE_TICKS = 4;
// A slow display is no longer believed after this many calls in a window closer than
// this share of its interval (a late call is followed by an early one: jitter)
const FAST_TICK_SHARE = 0.75;
const FAST_TICKS = 3;
// A measured slow display that keeps the resolution from going down is measured again
// this often at most
const REPROBE_MS = 60000;
const WINDOW_MS = 3000;
// Late: fewer frames than this share of the frame rate asked for
const MIN_FRAME_DELIVERY_SHARE = 0.85;
// The GPU is the bottleneck when a frame takes it longer than this share of a frame
const GPU_BOUND_SHARE = 0.9;
// A gap longer than this is a pause, not a slow frame
const PAUSE_MS = 250;
// A fence not passed after this long: the page was paused, the sample is dropped
const GPU_SAMPLE_TIMEOUT_MS = 250;
// One frame timed every this long (a dozen per window, plenty for the median): timing
// polls the GPU every millisecond until the frame is done, and in a WebView each poll
// is a synchronous call to the GPU process; timing every frame kept it busy for nothing
const GPU_SAMPLE_EVERY_MS = 250;
// Up again: the next density up should take the GPU under this share of the budget,
// in this many windows in a row, and not sooner than UP_COOLDOWN_MS after a step down.
// A density left within UP_REVERTED_MS of reaching it is tried again after
// RETRY_MS, doubled each time it fails again (up to RETRY_MAX_MS)
const UP_SHARE = 0.6;
const UP_WINDOWS = 2;
const UP_COOLDOWN_MS = 15000;
const UP_REVERTED_MS = 30000;
const RETRY_MS = 30000;
const RETRY_MAX_MS = 240000;

const MIN_PIXEL_RATIO = 1;
// The map is never drawn denser than this, whatever the screen (3× phones included).
// With multisampling (createRenderer.js) its edges stay smooth: 2.25× with it looks
// better than 2.5× without (edges are what showed), for about the same GPU time, and
// past ~400 pixels per inch the eye sees no finer detail at a phone's distance
export const MAX_PIXEL_RATIO = 2.25;

// The density the map starts at: the screen's, within MIN_PIXEL_RATIO–MAX_PIXEL_RATIO
export const startingPixelRatio = () => Math.min(Math.max(window.devicePixelRatio || MIN_PIXEL_RATIO, MIN_PIXEL_RATIO), MAX_PIXEL_RATIO);

// Times frames on the GPU: a fence before the frame's commands and one after them,
// looked at every millisecond or so from later tasks; the time between the moments
// each is seen passed is the GPU's time over the frame (what the browser adds before
// the GPU starts, a few milliseconds, is the same for both). Call begin() before the
// frame's first draw and end() after its last; take() answers the median of the
// frames timed since the last take(), or null
export function createGpuTimer(gl) {
  const samples = [];
  let before = null;
  let pending = false;
  let lastSample = -Infinity;
  const supported = typeof gl.fenceSync === 'function';
  const fence = () => {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return sync;
  };
  return {
    begin() {
      if (!supported || pending || before) return;
      const now = performance.now();
      if (now - lastSample < GPU_SAMPLE_EVERY_MS) return;
      lastSample = now;
      before = fence();
    },
    end() {
      if (!before) return;
      const syncs = [before, fence()];
      before = null;
      if (!syncs[1]) {
        gl.deleteSync(syncs[0]);
        return;
      }
      pending = true;
      const start = performance.now();
      const passed = [null, null];
      const check = () => {
        const now = performance.now();
        for (let i = 0; i < 2; i++) {
          if (passed[i] === null && gl.getSyncParameter(syncs[i], gl.SYNC_STATUS) === gl.SIGNALED) passed[i] = now;
        }
        if (passed[1] === null && now - start < GPU_SAMPLE_TIMEOUT_MS) {
          setTimeout(check, 1);
          return;
        }
        if (passed[1] !== null) samples.push(passed[1] - (passed[0] ?? passed[1]));
        for (const sync of syncs) gl.deleteSync(sync);
        pending = false;
      };
      setTimeout(check, 1);
    },
    take() {
      if (!samples.length) return null;
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      samples.length = 0;
      return median;
    },
  };
}

export function createAdaptiveResolution(renderer, { targetFrameIntervalMs, isBusy, gpuTimer = createGpuTimer(renderer.getContext()) }) {
  const start = startingPixelRatio();
  const steps = [start, ...PIXEL_RATIO_STEPS.filter((ratio) => ratio < start)];
  let step = 0;
  let windowStart = -1;
  let frames = 0;
  let previousFrame = -1;
  let roomyWindows = 0;
  let lastDown = -Infinity;
  let lastUp = -Infinity;
  // The density that failed going up, and when it may be tried again
  let failed = Infinity;
  let retryAt = -Infinity;
  let retry = RETRY_MS / 2;
  // The display's own interval when slower than the one asked for (ms; 0: not known to
  // be): as the app says, and as measured
  let toldLimit = 0;
  let toldLimitFastTicks = 0;
  let measuredLimit = 0;
  let measuredLimitFastTicks = 0;
  // The calls of the frame loop: the last one, and the shortest gap of this window
  let lastTick = -1;
  let shortestTick = Infinity;
  // Frames being left undrawn: { left, shortest, pending: { gpuMs } | null }
  let probe = null;
  let lastProbe = -Infinity;

  // The interval frames can really come at
  const frameInterval = () => Math.max(targetFrameIntervalMs, toldLimit, measuredLimit);

  const apply = () => {
    renderer.setPixelRatio(steps[step]);
    renderer.setSize(innerWidth, innerHeight);
  };

  const resetWindow = (time) => {
    windowStart = time;
    frames = 0;
    shortestTick = Infinity;
    toldLimitFastTicks = 0;
    measuredLimitFastTicks = 0;
    gpuTimer.take();
  };

  // Down to the highest density whose frames should take the GPU less than the budget
  const stepDown = (gpuMs, budget, time) => {
    const ratio = steps[step];
    step++;
    while (step < steps.length - 1 && gpuMs * (steps[step] / ratio) ** 2 > budget) step++;
    apply();
    roomyWindows = 0;
    if (time - lastUp < UP_REVERTED_MS) {
      failed = ratio;
      retry = Math.min(retry * 2, RETRY_MAX_MS);
      retryAt = time + retry;
    }
    lastDown = time;
  };

  const finishProbe = (time) => {
    const { shortest, pending } = probe;
    probe = null;
    lastProbe = time;
    measuredLimit = shortest > targetFrameIntervalMs * SLOW_DISPLAY ? shortest : 0;
    windowStart = -1; // the frames not drawn are not a slow window
    // What was about to be done, against the rate the display really gives
    const budget = frameInterval() * GPU_BOUND_SHARE;
    if (pending && pending.gpuMs >= budget && step < steps.length - 1) stepDown(pending.gpuMs, budget, time);
  };

  return {
    get pixelRatio() {
      return steps[step];
    },

    // The interval frames can come at now (ms): the one asked for, or the display's
    get frameInterval() {
      return frameInterval();
    },

    // True while a few frames are left undrawn to hear the display's own rate: the
    // caller draws nothing (and calls neither frameStarting nor frameRendered)
    get probing() {
      return probe !== null;
    },

    // The app knows the display shows at most `fps` frames a second (Low Power Mode on
    // an iPhone: 30); null or 0: it knows of no limit
    setDisplayLimit(fps) {
      toldLimit = fps > 0 && 1000 / fps > targetFrameIntervalMs ? 1000 / fps : 0;
      toldLimitFastTicks = 0;
    },

    // Call at every call of the browser's frame loop, drawn or not, with its time (ms)
    displayTick(time) {
      const gap = lastTick < 0 ? Infinity : time - lastTick;
      lastTick = time;
      if (gap > PAUSE_MS || gap <= 0) {
        if (probe) probe = null; // paused meanwhile: nothing was heard
        return;
      }
      shortestTick = Math.min(shortestTick, gap);
      // Calls coming faster than a limit believed: it is gone (Low Power Mode off)
      if (measuredLimit && gap < measuredLimit * FAST_TICK_SHARE && ++measuredLimitFastTicks >= FAST_TICKS) measuredLimit = 0;
      if (toldLimit && gap < toldLimit * FAST_TICK_SHARE && ++toldLimitFastTicks >= FAST_TICKS) toldLimit = 0;
      if (!probe) return;
      probe.shortest = Math.min(probe.shortest, gap);
      if (--probe.left <= 0) finishProbe(time);
    },

    // Call before the frame's first draw (the clouds' passes, the scene)
    frameStarting() {
      gpuTimer.begin();
    },

    // Call once per rendered frame, after rendering it, with the frame's time (ms)
    frameRendered(time) {
      gpuTimer.end();
      const gap = previousFrame < 0 ? 0 : time - previousFrame;
      previousFrame = time;
      if (windowStart < 0 || gap > PAUSE_MS || isBusy()) {
        resetWindow(time);
        return;
      }
      frames++;
      const elapsed = time - windowStart;
      if (elapsed < WINDOW_MS) return;
      const interval = frameInterval();
      const share = frames / (elapsed / interval);
      const gpuMs = gpuTimer.take();
      // No call of the frame loop came sooner than a slow display's would (when the
      // calls are told at all: displayTick)
      const displayMaybeSlow = shortestTick !== Infinity && shortestTick > targetFrameIntervalMs * SLOW_DISPLAY;
      resetWindow(time);
      const budget = interval * GPU_BOUND_SHARE;
      if (gpuMs === null) return;
      const ratio = steps[step];
      if (share < MIN_FRAME_DELIVERY_SHARE && gpuMs >= budget && step < steps.length - 1) {
        // The display or the GPU? Heard first, when nothing says the display is slow yet
        if (displayMaybeSlow && interval === targetFrameIntervalMs) {
          probe = { left: PROBE_TICKS, shortest: Infinity, pending: { gpuMs } };
          return;
        }
        stepDown(gpuMs, budget, time);
        return;
      }
      // A slow display, as measured, is all that keeps the resolution: still so?
      if (measuredLimit && !toldLimit && displayMaybeSlow && gpuMs >= targetFrameIntervalMs * GPU_BOUND_SHARE && time - lastProbe > REPROBE_MS) {
        probe = { left: PROBE_TICKS, shortest: Infinity, pending: null };
        return;
      }
      // Room to spare at the next density up?
      const roomy = step > 0 && gpuMs * (steps[step - 1] / ratio) ** 2 < budget * UP_SHARE;
      roomyWindows = roomy ? roomyWindows + 1 : 0;
      if (roomyWindows < UP_WINDOWS || time - lastDown < UP_COOLDOWN_MS) return;
      if (steps[step - 1] >= failed && time < retryAt) return;
      step--;
      apply();
      roomyWindows = 0;
      lastUp = time;
    },
  };
}
