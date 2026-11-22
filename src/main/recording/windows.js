'use strict';
// Recorder UI windows: panel, hidden worker, countdown, floating controls,
// region frame and result. Every visible one is content-protected so it never
// ends up in the recording.

const { app, screen } = require('electron');
const ctx = require('../context');

const KIND = 'recorder';
const PANEL_SIZE = { width: 640, height: 576 };
// Control bar window: the pill (PILL_H incl. shadow margin) sits at the bottom; the
// transparent space above it is click-through and only hosts tooltips.
const BAR_SIZE = { width: 340, height: 104 };
const PILL_H = 60;
const FRAME_PAD = 5; // frame border sits this many DIP outside the recorded area
const COUNTDOWN_SIZE = 260;

const round = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });

function protect(win, { overlay = false } = {}) {
  win.setContentProtection(true);
  if (overlay && ctx.isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function showFocused(win) {
  if (win.isDestroyed()) return;
  if (ctx.isMac) app.focus({ steal: true });
  win.show();
  win.focus();
}

function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// Frameless floating panel windows, transparent so the page can draw rounded corners.
const floating = {
  frame: false,
  transparent: true,
  resizable: false,
  maximizable: false,
  minimizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  hasShadow: false,
  alwaysOnTop: true,
  show: false,
};

function createPanel(params) {
  const wa = cursorDisplay().workArea;
  const { width, height } = PANEL_SIZE;
  // Opaque frameless window: the OS gives it rounded corners and a shadow
  // (macOS: plus the popover material under the translucent page background).
  const win = ctx.createWindow(KIND, {
    page: 'recorder/panel',
    params,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + Math.max(0, (wa.height - height) * 0.4)),
    width,
    height,
    title: ctx.t('recorder.panel.title'),
    ...(ctx.isMac ? { vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000' } : {}),
  });
  win.setAlwaysOnTop(true, 'floating');
  protect(win);
  win.once('ready-to-show', () => showFocused(win));
  return win;
}

function createWorker(params) {
  return ctx.createWindow(KIND, {
    page: 'recorder/worker',
    params,
    show: false,
    width: 240,
    height: 160,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
}

function createCountdown({ seconds, center }) {
  const s = COUNTDOWN_SIZE;
  const win = ctx.createWindow(KIND, {
    page: 'recorder/countdown',
    params: { seconds },
    ...floating,
    focusable: false,
    movable: false,
    x: Math.round(center.x - s / 2),
    y: Math.round(center.y - s / 2),
    width: s,
    height: s,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  protect(win, { overlay: true });
  return win;
}

// Pill at the bottom-centre of the display, or right below / above a recorded region.
function controlsBounds({ display, region }) {
  const wa = display.workArea;
  const { width: W, height: H } = BAR_SIZE;
  const clampX = (x) => Math.max(wa.x + 4, Math.min(x, wa.x + wa.width - W - 4));
  const at = (x, pillY) => round({ x, y: pillY - (H - PILL_H), width: W, height: H });
  if (region) {
    const x = clampX(region.x + region.width / 2 - W / 2);
    const below = region.y + region.height + FRAME_PAD;
    if (below + PILL_H <= wa.y + wa.height) return at(x, below);
    const above = region.y - FRAME_PAD - PILL_H;
    if (above - (H - PILL_H) >= wa.y) return at(x, above);
  }
  return at(clampX(wa.x + (wa.width - W) / 2), wa.y + wa.height - PILL_H - 16);
}

function createControls(params, bounds) {
  const win = ctx.createWindow(KIND, {
    page: 'recorder/controls',
    params,
    ...floating,
    focusable: false, // never steal focus from the app being recorded
    ...bounds,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // the page re-enables it over the pill
  protect(win, { overlay: true });
  win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive());
  return win;
}

function createFrame(globalRect, params) {
  const b = round({
    x: globalRect.x - FRAME_PAD,
    y: globalRect.y - FRAME_PAD,
    width: globalRect.width + FRAME_PAD * 2,
    height: globalRect.height + FRAME_PAD * 2,
  });
  const win = ctx.createWindow(KIND, {
    page: 'recorder/frame',
    params,
    ...floating,
    focusable: false,
    movable: false,
    enableLargerThanScreen: true,
    ...b,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  protect(win, { overlay: true });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.setBounds(b); // macOS may have constrained the initial frame to the screen
    win.showInactive();
  });
  return win;
}

function createEditor(params) {
  const wa = cursorDisplay().workArea;
  const width = Math.min(wa.width - 40, 1040);
  const height = Math.min(wa.height - 40, 720);
  const win = ctx.createWindow(KIND, {
    page: 'recorder/editor',
    params,
    width,
    height,
    minWidth: 860,
    minHeight: 580,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    title: params.name || ctx.t('recorder.editor.title'),
    ...(ctx.isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    fullscreenable: false,
    // video.audioTracks: preview a single source of multi-track Kadr recordings.
    webPreferences: { enableBlinkFeatures: 'AudioVideoTracks' },
  });
  // No content protection: it's a normal document window the user may want to screenshot.
  win.once('ready-to-show', () => showFocused(win));
  return win;
}

// STUB region selector: a minimal drag-to-select overlay on the display under the
// cursor. Only used when the core capture module (ctx.modules.capture.selectRegion)
// is not available, e.g. while modules are being developed in parallel.
function createRegionStub(display) {
  const win = ctx.createWindow(KIND, {
    page: 'recorder/region-stub',
    params: { bounds: display.bounds },
    ...floating,
    movable: false,
    enableLargerThanScreen: true,
    ...display.bounds,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  protect(win, { overlay: true });
  win.once('ready-to-show', () => showFocused(win));
  return win;
}

function closeWindow(win) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* already gone */
  }
}

module.exports = {
  createPanel,
  createWorker,
  createCountdown,
  createControls,
  controlsBounds,
  createFrame,
  createEditor,
  createRegionStub,
  closeWindow,
  showFocused,
  cursorDisplay,
  FRAME_PAD,
};
