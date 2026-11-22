'use strict';
// Screen recording: source picker panel → hidden MediaRecorder worker →
// countdown → floating controls → ffmpeg post-processing → result window.
//
// Session phases: preparing → countdown → recording ⇄ paused → stopping → (gone).
// Public status (events 'state'): idle | countdown | recording | paused | processing.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app, screen, shell, systemPreferences, powerSaveBlocker, globalShortcut, desktopCapturer } = require('electron');
const ctx = require('./context');
const { toBuffer } = require('./basics');
const sources = require('./recording/sources');
const ui = require('./recording/windows');
const post = require('./recording/post');
const { ChunkSink } = require('./recording/sink');
const fakes = require('./recording/dev-fakes');
const editor = require('./recording/editor');
const enc = require('../renderer/recorder/shared/encoding.mjs');

const events = new EventEmitter();
const isDev = process.argv.includes('--dev');
// Dev/test switches (ignored in production): fake source lists and mic devices for UI
// checks, and a synthetic canvas + oscillator source instead of desktop capture.
const devOptions = { fakeSources: false, fakeDevices: false, testSource: false, permissions: null, forceAudioVia: null, testFail: null };

let panel = null;
let rec = null; // active session
let pendingStart = null; // source/permission lookup before a session owns resources
let status = 'idle';
let stub = null; // built-in region selector session (fallback)

const t = (k, v) => ctx.t(k, v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const unlinkQuiet = (f) => f && fs.promises.unlink(f).catch(() => {});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function elapsedMs(s = rec) {
  if (!s || !s.startedAt) return 0;
  return s.activeMs + (s.phase === 'recording' ? Date.now() - s.activeSince : 0);
}

function snapshot() {
  return {
    status,
    startedAt: rec?.startedAt || null,
    elapsedMs: elapsedMs(),
    micMuted: !!rec?.micMuted,
    hasMic: !!rec?.hasMic,
    mode: rec?.target?.mode || null,
  };
}

function emitState() {
  const s = snapshot();
  events.emit('state', s);
  for (const w of [rec?.controls, rec?.frame]) {
    if (w && !w.isDestroyed()) w.webContents.send('recorder:state', s);
  }
}

function setStatus(next) {
  status = next;
  emitState();
}

function isRecording() {
  return status === 'countdown' || status === 'recording' || status === 'paused';
}

// ---------------------------------------------------------------------------
// Capabilities, permissions, regions
// ---------------------------------------------------------------------------

function systemAudioSupport() {
  if (isDev && devOptions.forceAudioVia) return { supported: true, via: devOptions.forceAudioVia };
  if (ctx.isWin) return { supported: true, via: 'loopback' };
  if (ctx.isMac) {
    const native = ctx.modules.native;
    let ok = false;
    try {
      ok = !!native?.capabilities?.()?.systemAudio && typeof native.systemAudio?.start === 'function';
    } catch {
      ok = false;
    }
    return ok ? { supported: true, via: 'native' } : { supported: false, reason: 'recorder.audio.systemUnsupportedMac' };
  }
  return { supported: false, reason: 'recorder.audio.systemUnsupported' };
}

function permissions() {
  const out = { screen: 'granted', microphone: 'granted' };
  try {
    if (ctx.isMac) out.screen = systemPreferences.getMediaAccessStatus('screen');
    if (ctx.isMac || ctx.isWin) out.microphone = systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    /* keep defaults */
  }
  return out;
}

async function checkPermissions(opts) {
  if (opts.test) return null;
  if (ctx.isMac) {
    const scr = systemPreferences.getMediaAccessStatus('screen');
    if (scr === 'denied' || scr === 'restricted') return { error: 'screen-permission' };
  }
  if (opts.mic && (ctx.isMac || ctx.isWin)) {
    let mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic === 'not-determined' && ctx.isMac) mic = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    if (mic === 'denied' || mic === 'restricted') return { error: 'mic-permission' };
  }
  return null;
}

// Normalise a stored/selected region ({ displayId, x, y, width, height }, DIP relative
// to the display) against the current display layout; null when it no longer fits.
function validRegion(r) {
  if (!r || !(r.width >= 16 && r.height >= 16)) return null;
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(r.displayId));
  if (!d) return null;
  const x = clamp(Math.round(r.x), 0, d.bounds.width - 16);
  const y = clamp(Math.round(r.y), 0, d.bounds.height - 16);
  return {
    displayId: d.id,
    x,
    y,
    width: Math.min(Math.round(r.width), d.bounds.width - x),
    height: Math.min(Math.round(r.height), d.bounds.height - y),
  };
}

function regionInfo(r) {
  if (!r) return null;
  const displays = screen.getAllDisplays();
  const i = displays.findIndex((x) => String(x.id) === String(r.displayId));
  if (i < 0) return null;
  const d = displays[i];
  return { ...r, displayName: sources.displayName(d, i), displayWidth: d.bounds.width, displayHeight: d.bounds.height, scaleFactor: d.scaleFactor };
}

async function selectRegion() {
  const capture = ctx.modules.capture;
  if (typeof capture?.selectRegion === 'function') return capture.selectRegion({ purpose: 'record' });
  return stubSelectRegion();
}

// STUB region selection — only used when the core capture module is missing.
function stubSelectRegion() {
  if (stub) return Promise.resolve(null);
  const display = ui.cursorDisplay();
  return new Promise((resolve) => {
    const win = ui.createRegionStub(display);
    stub = { win, display, resolve };
    win.on('closed', () => finishStub(null));
  });
}

function finishStub(rect) {
  if (!stub) return;
  const { win, display, resolve } = stub;
  stub = null;
  ui.closeWindow(win);
  if (!rect || !(rect.width >= 16 && rect.height >= 16)) return resolve(null);
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  resolve({
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    displayBounds: display.bounds,
    rect: r,
    global: { x: display.bounds.x + r.x, y: display.bounds.y + r.y, width: r.width, height: r.height },
  });
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function openPanel(opts = {}) {
  if (status !== 'idle') {
    if (rec?.controls && !rec.controls.isDestroyed()) rec.controls.showInactive();
    return null;
  }
  if (panel && !panel.isDestroyed()) {
    ui.showFocused(panel);
    if (opts.mode) panel.webContents.send('recorder:panel-mode', opts.mode);
    return panel;
  }
  panel = ui.createPanel({ mode: opts.mode || null, dev: isDev ? { fakeDevices: devOptions.fakeDevices } : null });
  const win = panel;
  win.on('closed', () => {
    if (panel === win) panel = null;
    if (pendingStart || (rec && rec.phase === 'preparing')) cancel();
  });
  return panel;
}

function closePanel() {
  const win = panel;
  panel = null;
  ui.closeWindow(win);
}

function toggle() {
  if (status === 'recording' || status === 'paused') return stop();
  if (status === 'countdown') return cancel();
  if (status === 'processing') return null;
  if (panel && !panel.isDestroyed() && panel.isVisible()) return closePanel();
  return openPanel();
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

function readOptions(input) {
  const s = ctx.settings.get('recording') || {};
  const pick = (k) => (input[k] !== undefined ? input[k] : s[k]);
  const fps = Number(pick('fps'));
  return {
    mode: ['screen', 'window', 'region'].includes(input.mode) ? input.mode : 'screen',
    fps: [24, 30, 60].includes(fps) ? fps : 30,
    format: pick('format') === 'webm' ? 'webm' : 'mp4',
    quality: ['low', 'medium', 'high', 'max'].includes(pick('quality')) ? pick('quality') : 'high',
    countdown: clamp(Math.round(Number(pick('countdown')) || 0), 0, 10),
    mic: !!pick('mic'),
    micDeviceId: pick('micDeviceId') || 'default',
    micVolume: clamp(Number(s.micVolume ?? 1), 0, 2),
    systemAudio: !!pick('systemAudio'),
    systemVolume: clamp(Number(s.systemVolume ?? 1), 0, 2),
    // Fake source lists imply the synthetic source: tests must never capture the real screen.
    test: isDev && (devOptions.testSource || devOptions.fakeSources || !!input.testSource),
    testFail: isDev ? input.testFail || devOptions.testFail || null : null,
    testDisplay: isDev ? input.testDisplay || null : null,
    testEndAfterMs: isDev ? input.testEndAfterMs || 0 : 0,
  };
}

async function windowDisplay(sourceId) {
  const m = /^window:(\d+):/.exec(sourceId || '');
  const native = ctx.modules.native;
  if (!m || typeof native?.listWindows !== 'function') return null;
  try {
    const w = (await native.listWindows())?.find((x) => String(x.id) === m[1]);
    return w?.bounds ? screen.getDisplayMatching(w.bounds) : null;
  } catch {
    return null;
  }
}

async function resolveTarget(opts, input) {
  const primary = screen.getPrimaryDisplay();
  if (opts.mode === 'region') {
    const region = validRegion(input.region || ctx.settings.get('recording.lastRegion'));
    if (!region) return { error: 'no-region' };
    const display = ctx.displayById(region.displayId);
    const sourceId = opts.test ? 'test' : await sources.screenSourceId(display.id);
    if (!sourceId) return { error: 'display-gone' };
    const global = { x: display.bounds.x + region.x, y: display.bounds.y + region.y, width: region.width, height: region.height };
    return { mode: 'region', display, region, global, sourceId };
  }
  if (opts.mode === 'window') {
    if (!input.sourceId && !opts.test) return { error: 'no-source' };
    if (!opts.test && !(await sources.windowSourceExists(input.sourceId))) return { error: 'window-gone' };
    const display = (await windowDisplay(input.sourceId)) || ui.cursorDisplay();
    return { mode: 'window', display, sourceId: opts.test ? 'test' : input.sourceId, windowName: input.windowName || '' };
  }
  let display = screen.getAllDisplays().find((d) => String(d.id) === String(input.displayId ?? primary.id));
  if (!display && opts.test) display = primary;
  if (!display) return { error: 'display-gone' };
  const sourceId = opts.test ? 'test' : await sources.screenSourceId(display.id);
  if (!sourceId) return { error: 'display-gone' };
  return { mode: 'screen', display, sourceId };
}

function workerParams(s) {
  const { opts, target } = s;
  const d = opts.testDisplay || { width: target.display.bounds.width, height: target.display.bounds.height, scaleFactor: target.display.scaleFactor };
  const sf = d.scaleFactor || 1;
  let pw = d.width * sf;
  let ph = d.height * sf;
  let k;
  if (target.mode === 'region') {
    k = enc.fitScale(target.region.width * sf, target.region.height * sf, opts.fps);
  } else if (target.mode === 'window' && !opts.test) {
    // Window size is unknown up front: allow up to the largest display.
    for (const x of screen.getAllDisplays()) {
      pw = Math.max(pw, x.bounds.width * x.scaleFactor);
      ph = Math.max(ph, x.bounds.height * x.scaleFactor);
    }
    k = enc.fitScale(pw, ph, opts.fps);
  } else {
    k = enc.fitScale(pw, ph, opts.fps);
  }
  return {
    sessionId: s.id,
    mode: target.mode,
    sourceId: target.sourceId,
    test: opts.test,
    testEndAfterMs: opts.testEndAfterMs,
    testFail: opts.test ? opts.testFail : null,
    display: { width: d.width, height: d.height, scaleFactor: sf },
    crop: target.mode === 'region' ? { x: target.region.x, y: target.region.y, width: target.region.width, height: target.region.height } : null,
    capture: { maxWidth: Math.round(pw * k), maxHeight: Math.round(ph * k) },
    fps: opts.fps,
    format: opts.format,
    quality: opts.quality,
    mic: { enabled: opts.mic, deviceId: opts.micDeviceId, volume: opts.micVolume },
    loopback: opts.systemAudio && s.audioVia === 'loopback',
    systemVolume: opts.systemVolume,
  };
}

async function startSession(input = {}) {
  if (rec || pendingStart || status !== 'idle') return { error: 'busy' };
  const opts = readOptions(input);
  const request = {};
  pendingStart = request;
  let target;
  try {
    target = await resolveTarget(opts, input);
    if (pendingStart !== request) return { error: 'cancelled' };
    if (target.error) return target;
    const denied = await checkPermissions(opts);
    if (pendingStart !== request) return { error: 'cancelled' };
    if (denied) return denied;
  } finally {
    if (pendingStart === request) pendingStart = null;
  }

  const audio = systemAudioSupport();
  if (opts.systemAudio && !audio.supported) opts.systemAudio = false;
  const s = {
    id: ctx.newId(),
    opts,
    target,
    phase: 'preparing',
    audioVia: opts.systemAudio ? audio.via : null,
    startedAt: 0,
    activeSince: 0,
    activeMs: 0,
    micMuted: false,
    hasMic: false,
    waiters: new Map(),
  };
  // The synthetic test source never touches the real ScreenCaptureKit helper.
  if (opts.test && s.audioVia === 'native') s.fakeAudio = fakes.fakeSystemAudio();
  rec = s;
  setStatus('countdown');
  try {
    // Teardown joins this work: cancelling while open() is pending must not leave
    // a file handle created after cleanup has already finished.
    s.preparation = prepareSession(s);
    await s.preparation;
  } catch (err) {
    if (rec === s) await teardown(s, { deleteFiles: true });
    return { error: err.code || 'capture', message: String(err.message || err) };
  }
  if (rec !== s || s.tornDown) return { error: 'cancelled' };
  s.phase = 'countdown';
  closePanel();
  if (s.ready.warnings?.includes('mic-fallback')) ctx.notify(t('recorder.notify.micFallback'));
  if (target.mode === 'window' || target.mode === 'screen') {
    ctx.settings.set({ recording: { lastMode: target.mode, ...(target.mode === 'screen' ? { lastDisplayId: target.display.id } : { lastWindowName: target.windowName || '' }) } });
  } else {
    ctx.settings.set({ recording: { lastMode: 'region', lastRegion: target.region } });
  }
  launch(s);
  return { ok: true };
}

async function prepareSession(s) {
  s.worker = ui.createWorker(workerParams(s));
  watchWorker(s);
  const ready = await waitWorker(s, 'ready', 20000);
  if (s.tornDown) return;
  s.ready = ready;
  s.hasMic = !!ready.hasMic;
  s.rawPath = path.join(ctx.paths.recordings, `raw-${s.id}.${ready.ext}`);
  s.sink = new ChunkSink(s.rawPath);
  await s.sink.open();
  if (s.tornDown) return;
  // Separate audio sources allow the final video to retain only mic or system audio.
  s.stems = {};
  for (const name of ready.stems || []) {
    s.stems[name] = new ChunkSink(path.join(ctx.paths.recordings, `stem-${name}-${s.id}.webm`));
    await s.stems[name].open();
    if (s.tornDown) return;
  }
  if (s.audioVia === 'native') s.sysPath = path.join(ctx.paths.recordings, `sys-${s.id}.m4a`);
}

async function launch(s) {
  try {
    if (!(await runCountdown(s))) return;
    await beginRecording(s);
  } catch (err) {
    console.error('[recorder] failed to start', err);
    if (rec === s) {
      await teardown(s, { deleteFiles: true });
      ctx.notify(t('recorder.notify.failed'), String(err.message || err));
    }
  }
}

async function runCountdown(s) {
  const seconds = s.opts.countdown;
  if (!seconds) return rec === s;
  const g = s.target.global;
  const b = s.target.display.bounds;
  const center = g && g.width >= 280 && g.height >= 280 ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const win = ui.createCountdown({ seconds, center });
  s.countdown = win;
  // A click-through, non-focusable window can't get key events: listen for Esc globally.
  let esc = false;
  try {
    if (!globalShortcut.isRegistered('Escape')) esc = globalShortcut.register('Escape', () => cancel());
  } catch {
    esc = false;
  }
  try {
    await new Promise((resolve) => {
      let begun = false;
      const begin = () => {
        if (begun) return;
        begun = true;
        if (!win.isDestroyed()) {
          win.showInactive();
          win.webContents.send('recorder:countdown-go');
        }
        s.countdownTimer = setTimeout(resolve, seconds * 1000);
      };
      s.countdownAbort = () => {
        clearTimeout(s.countdownTimer);
        resolve();
      };
      win.once('ready-to-show', begin);
      setTimeout(begin, 1500);
    });
  } finally {
    if (esc) globalShortcut.unregister('Escape');
    ui.closeWindow(win);
    s.countdown = null;
    s.countdownAbort = null;
  }
  await new Promise((r) => setTimeout(r, 80));
  return rec === s && s.phase === 'countdown';
}

async function beginRecording(s) {
  if (rec !== s || s.phase !== 'countdown') return;
  if (s.audioVia === 'native') {
    try {
      s.audioStart = (async () => {
        await audioApi(s).start(s.sysPath);
        s.sysStarted = true;
      })();
      await s.audioStart;
    } catch (err) {
      if (!s.tornDown) {
        console.warn('[recorder] system audio failed to start', err);
        ctx.notify(t('recorder.notify.systemAudioLost'), String(err.message || err));
      }
    }
  }
  if (rec !== s || s.phase !== 'countdown') return;
  const starting = waitWorker(s, 'started', 8000);
  try {
    sendWorker(s, 'start');
  } catch (err) {
    settleWaiter(s, 'started', 'reject', err);
  }
  const started = await starting;
  if (rec !== s || s.phase !== 'countdown') return;
  s.videoStartedAt = started.at || Date.now();
  s.startedAt = Date.now();
  s.activeSince = s.startedAt;
  s.phase = 'recording';
  try {
    s.powerId = powerSaveBlocker.start('prevent-display-sleep');
  } catch {
    s.powerId = null;
  }
  showRecordingUi(s);
  s.tick = setInterval(emitState, 1000);
  setStatus('recording');
}

// macOS 15+ ScreenCaptureKit ignores window sharing protection, so anything shown on the
// recorded display ends up in the video.
const sckCapturesEverything = ctx.isMac && Number(require('os').release().split('.')[0]) >= 24;

function showRecordingUi(s) {
  const { target } = s;
  if (!ctx.settings.get('recording.hideControlsWhileRecording')) {
    let bounds = ui.controlsBounds({ display: target.display, region: target.global });
    if (target.mode === 'screen' && sckCapturesEverything) {
      const other = screen.getAllDisplays().find((d) => String(d.id) !== String(target.display.id));
      bounds = other ? ui.controlsBounds({ display: other }) : null;
      if (!bounds) ctx.notify(ctx.t('recorder.notify.controlsHidden'), ctx.t('recorder.notify.controlsHiddenBody'));
    }
    if (bounds) s.controls = ui.createControls({ hasMic: s.hasMic, mode: target.mode }, bounds);
  }
  const b = target.display.bounds;
  const g = target.global;
  const coversDisplay = g && g.width >= b.width - 2 && g.height >= b.height - 2;
  if (target.mode === 'region' && !coversDisplay) s.frame = ui.createFrame(g, {});
}

function hideRecordingUi(s, { keepControls = false } = {}) {
  clearInterval(s.tick);
  s.tick = null;
  if (s.powerId != null) {
    try {
      powerSaveBlocker.stop(s.powerId);
    } catch {
      /* ignore */
    }
    s.powerId = null;
  }
  ui.closeWindow(s.frame);
  s.frame = null;
  if (!keepControls) {
    ui.closeWindow(s.controls);
    s.controls = null;
  }
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------

function watchWorker(s) {
  const wc = s.worker.webContents;
  s.workerId = wc.id;
  wc.on('render-process-gone', (e, details) => onWorkerLost(s, details?.reason || 'crashed'));
  s.worker.on('closed', () => {
    if (!s.workerClosing) onWorkerLost(s, 'closed');
  });
}

function sendWorker(s, cmd, args = {}) {
  const w = s.worker;
  if (w && !w.isDestroyed()) w.webContents.send('recorder:cmd', { cmd, ...args });
}

function waitWorker(s, type, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.waiters.delete(type);
      reject(Object.assign(new Error(`worker did not report "${type}"`), { code: 'timeout' }));
    }, ms);
    s.waiters.set(type, { resolve, reject, timer });
  });
}

function settleWaiter(s, type, fn, value) {
  const w = s.waiters.get(type);
  if (!w) return false;
  s.waiters.delete(type);
  clearTimeout(w.timer);
  w[fn](value);
  return true;
}

function rejectWaiters(s, err) {
  for (const type of [...s.waiters.keys()]) settleWaiter(s, type, 'reject', err);
}

function closeWorker(s) {
  s.workerClosing = true;
  ui.closeWindow(s.worker);
  s.worker = null;
}

function onWorkerEvent(s, evt) {
  switch (evt.type) {
    case 'level':
      if (s.controls && !s.controls.isDestroyed()) s.controls.webContents.send('recorder:level', evt.level);
      return;
    case 'ended':
      return onSourceEnded(s, evt.reason);
    case 'error': {
      const err = Object.assign(new Error(evt.message || 'recording error'), { code: evt.code || 'capture' });
      if (s.phase === 'preparing') return void settleWaiter(s, 'ready', 'reject', err);
      if (s.phase === 'countdown' && settleWaiter(s, 'started', 'reject', err)) return;
      return onRuntimeError(s, err);
    }
    default:
      settleWaiter(s, evt.type, 'resolve', evt);
  }
}

function onSourceEnded(s, reason) {
  if (rec !== s) return;
  console.warn('[recorder] source ended:', reason);
  if (s.phase === 'preparing') {
    settleWaiter(s, 'ready', 'reject', Object.assign(new Error(reason || 'source ended'), { code: 'capture' }));
  } else if (s.phase === 'countdown') {
    cancel();
    ctx.notify(t('recorder.notify.failed'), t('recorder.notify.sourceEnded'));
  } else if (s.phase === 'recording' || s.phase === 'paused') {
    s.endNote = 'recorder.notify.sourceEnded';
    stop();
  }
}

function onRuntimeError(s, err) {
  if (rec !== s) return;
  console.error('[recorder] runtime error', err);
  if (s.phase === 'recording' || s.phase === 'paused') {
    s.endNote = 'recorder.notify.interrupted';
    stop(); // keep whatever was recorded so far
  } else if (s.phase === 'countdown') {
    cancel();
    ctx.notify(t('recorder.notify.failed'), String(err.message || err));
  }
}

function onWorkerLost(s, reason) {
  if (rec !== s || s.workerLost) return;
  s.workerLost = true;
  console.error('[recorder] worker lost:', reason);
  const err = Object.assign(new Error(`recorder process ${reason}`), { code: 'capture' });
  if (s.phase === 'preparing' || s.phase === 'stopping') return rejectWaiters(s, err);
  onRuntimeError(s, err);
}

// ---------------------------------------------------------------------------
// Pause / mute / stop / cancel
// ---------------------------------------------------------------------------

// macOS system audio lives in the native helper (or a dev fake for tests).
const audioApi = (s) => s.fakeAudio || ctx.modules.native?.systemAudio;

function callAudio(s, fn, ...args) {
  return Promise.resolve()
    .then(() => audioApi(s)[fn](...args))
    .catch((e) => {
      console.warn(`[recorder] systemAudio.${fn} failed`, e);
      return null;
    });
}

function pause() {
  const s = rec;
  if (!s || s.phase !== 'recording') return;
  sendWorker(s, 'pause');
  if (s.sysStarted) callAudio(s, 'pause');
  s.activeMs += Date.now() - s.activeSince;
  s.phase = 'paused';
  setStatus('paused');
}

function resume() {
  const s = rec;
  if (!s || s.phase !== 'paused') return;
  sendWorker(s, 'resume');
  if (s.sysStarted) callAudio(s, 'resume');
  s.activeSince = Date.now();
  s.phase = 'recording';
  setStatus('recording');
}

function setMicMuted(muted) {
  const s = rec;
  if (!s || !s.hasMic) return;
  s.micMuted = !!muted;
  sendWorker(s, 'mute', { muted: s.micMuted });
  emitState();
}

function stop() {
  const s = rec;
  if (!s) return Promise.resolve(null);
  if (s.phase === 'preparing' || s.phase === 'countdown') return cancel().then(() => null);
  if (s.stopping) return s.stopping;
  s.stopping = finishSession(s)
    .catch((err) => {
      console.error('[recorder] finishing failed', err);
      ctx.notify(t('recorder.notify.failed'), err.code === 'EMPTY' ? t('recorder.notify.empty') : String(err.message || err));
      return null;
    })
    .finally(async () => {
      // Failed exports may still contain useful video/audio. Only remove
      // intermediates after a complete delivery, including its audio sources.
      if (s.delivered && !s.keepRecoveryFiles) {
        await Promise.all([s.finalTmp, s.sysPath].map(unlinkQuiet));
      }
      if (rec === s) await teardown(s);
    });
  return s.stopping;
}

async function cancel() {
  pendingStart = null;
  const s = rec;
  if (!s) {
    closePanel();
    return;
  }
  if (s.stopping) return; // already saving — too late to discard
  s.cancelled = true;
  s.countdownAbort?.();
  await teardown(s, { deleteFiles: true });
}

// Release everything the session holds and go back to idle. Safe to call twice.
function teardown(s, options = {}) {
  if (!s.teardownPromise) s.teardownPromise = releaseSession(s, options);
  return s.teardownPromise;
}

async function releaseSession(s, { deleteFiles = false } = {}) {
  s.tornDown = true;
  s.phase = 'done';
  rejectWaiters(s, Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  s.countdownAbort?.();
  hideRecordingUi(s);
  ui.closeWindow(s.countdown);
  closeWorker(s);
  await s.preparation?.catch(() => {});
  // Native start may still be in flight when Escape is pressed. Wait for its
  // result before stopping it, and keep the session busy until it is released.
  await s.audioStart?.catch(() => {});
  let sysResult = null;
  if (s.sysStarted) {
    s.sysStarted = false;
    sysResult = await callAudio(s, 'stop');
  }
  await s.sink?.close().catch(() => {});
  await closeStems(s);
  if (deleteFiles) {
    for (const f of [s.rawPath, s.sysPath, sysResult?.path, s.finalTmp, ...stemFiles(s)]) unlinkQuiet(f);
  }
  if (rec === s) {
    rec = null;
    setStatus('idle');
  }
}

function stemFiles(s) {
  return Object.values(s.stems || {}).map((k) => k.file);
}

async function closeStems(s) {
  await Promise.all(Object.values(s.stems || {}).map((k) => k.close().catch(() => {})));
}

async function stopWorker(s) {
  if (!s.worker || s.worker.isDestroyed() || s.workerLost) return null;
  const done = waitWorker(s, 'stopped', 20000).catch((err) => {
    console.warn('[recorder] worker stop:', err.message);
    return null;
  });
  sendWorker(s, 'stop');
  return done;
}

async function stopNativeAudio(s) {
  if (!s.sysStarted) return null;
  s.sysStarted = false;
  const r = await callAudio(s, 'stop');
  const file = r?.path || s.sysPath;
  try {
    if (file && (await fs.promises.stat(file)).size > 0) return { ...r, path: file };
  } catch {
    /* no audio file */
  }
  return null;
}

async function finishSession(s) {
  if (s.phase === 'recording') s.activeMs += Date.now() - s.activeSince;
  s.phase = 'stopping';
  hideRecordingUi(s, { keepControls: true }); // the bar shows "Saving…" until we're done
  setStatus('processing');
  const [, sys] = await Promise.all([stopWorker(s), stopNativeAudio(s)]);
  closeWorker(s);
  await s.sink.close();
  await closeStems(s);
  if (s.sink.error) console.error('[recorder] write error during recording', s.sink.error);
  try {
    return await deliver(s, sys);
  } finally {
    if (s.delivered && !s.keepRecoveryFiles) {
      await Promise.all([sys?.path, ...stemFiles(s)].map(unlinkQuiet));
    }
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function saveTarget(ext, suffix = '') {
  const rs = ctx.settings.get('recording') || {};
  const folder = rs.saveFolder || ctx.settings.defaults.recording.saveFolder;
  fs.mkdirSync(folder, { recursive: true });
  const base = ctx.formatFileName(rs.fileNameTemplate || ctx.settings.defaults.recording.fileNameTemplate);
  return ctx.uniquePath(folder, suffix ? `${base} ${suffix}` : base, ext);
}

async function deliver(s, sys) {
  if (!s.sink.bytes) {
    // bytes counts complete chunks. A failed first write may already have
    // written part of its bytes, so neither the counter nor an I/O error proves
    // that the file is empty.
    if (s.sink.error) throw s.sink.error;
    const st = await fs.promises.stat(s.rawPath).catch(() => null);
    if (st?.size === 0) await unlinkQuiet(s.rawPath);
    throw Object.assign(new Error('the recording is empty'), { code: 'EMPTY' });
  }
  const ext = s.opts.format;
  s.finalTmp = path.join(ctx.paths.recordings, `final-${s.id}.${ext}`);
  const system = sys
    ? { path: sys.path, offsetMs: (Number(sys.startedAt) || s.videoStartedAt) - s.videoStartedAt, volume: s.opts.systemVolume }
    : null;
  const st = s.stems || {};
  const stems = st.mic?.bytes && st.system?.bytes && !st.mic.error && !st.system.error ? { mic: st.mic.file, system: st.system.file } : null;
  let file;
  let raw = false;
  try {
    try {
      await post.finalize({ input: s.rawPath, output: s.finalTmp, system, stems });
    } catch (err) {
      if ((!system && !stems) || err.code === 'EMPTY') throw err;
      s.keepRecoveryFiles = true;
      console.warn('[recorder] system audio mix failed, saving without it', err);
      ctx.notify(t('recorder.notify.systemAudioLost'));
      await post.finalize({ input: s.rawPath, output: s.finalTmp });
    }
    file = await post.moveFile(s.finalTmp, saveTarget(ext));
  } catch (err) {
    if (err.code === 'EMPTY') throw err;
    console.error('[recorder] post-processing failed, keeping the raw file', err);
    s.keepRecoveryFiles = true;
    raw = true;
    file = await post.moveFile(s.rawPath, saveTarget(s.ready.ext));
  }
  s.delivered = true;
  await unlinkQuiet(s.rawPath);
  return announce(file, { raw, note: s.endNote });
}

async function announce(file, { raw = false, recovered = false, note = null } = {}) {
  const name = path.basename(file);
  const info = await post.probe(file).catch(() => ({}));
  const size = (await fs.promises.stat(file).catch(() => null))?.size || 0;
  const title = raw ? t('recorder.notify.rawSaved') : recovered ? t('recorder.notify.recovered') : t(note || 'recorder.notify.saved');
  ctx.notify(title, raw ? t('recorder.notify.rawSavedBody', { name }) : name, { onClick: () => shell.showItemInFolder(file) });
  const after = ctx.settings.get('recording.afterRecording');
  if (after === 'reveal') shell.showItemInFolder(file);
  else if (after !== 'none') editor.openVideoEditor(file, { raw });
  return { path: file, raw, size, ...info };
}

// Leftovers from a crash: remux readable raw recordings into the save folder.
// Unrecognised/failed material and separate audio stay available for recovery.
async function recoverLeftovers() {
  const dir = ctx.paths.recordings;
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const f = path.join(dir, n);
    if (rec && [rec.rawPath, rec.sysPath, rec.finalTmp, ...stemFiles(rec)].includes(f)) continue;
    const m = /^raw-\w+\.(mp4|webm)$/.exec(n);
    if (!m) continue;
    // A failed probe is not proof of an empty recording (ffmpeg can be missing,
    // temporarily unavailable or unable to read a damaged but recoverable file).
    const info = await post.probe(f).catch((err) => {
      console.warn('[recorder] cannot inspect leftover, preserving it', n, err.message);
      return null;
    });
    if (!info?.video) continue;
    const suffix = t('recorder.file.recovered');
    const tmp = path.join(dir, `final-recovered-${ctx.newId()}.${m[1]}`);
    try {
      await post.finalize({ input: f, output: tmp });
      const file = await post.moveFile(tmp, saveTarget(m[1], suffix));
      await unlinkQuiet(f);
      ctx.notify(t('recorder.notify.recovered'), path.basename(file), { onClick: () => shell.showItemInFolder(file) });
    } catch (err) {
      console.warn('[recorder] could not remux a leftover recording, keeping it raw', err.message);
      const file = await post.moveFile(f, saveTarget(m[1], suffix)).catch(() => null);
      if (file) ctx.notify(t('recorder.notify.recovered'), path.basename(file), { onClick: () => shell.showItemInFolder(file) });
    }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function register() {
  const { handle } = ctx;

  // Panel
  handle('recorder:panel-init', () => {
    const hk = ctx.settings.get('hotkeys') || {};
    return {
      platform: process.platform,
      systemAudio: systemAudioSupport(),
      cursorControl: false, // Chromium desktop capture always composites the cursor
      permissions: (isDev && devOptions.permissions) || permissions(),
      lastRegion: regionInfo(validRegion(ctx.settings.get('recording.lastRegion'))),
      hotkeys: { record: hk.record || '', recordStop: hk.recordStop || '' },
    };
  });
  handle('recorder:sources', async (e, kind) => {
    if (isDev && devOptions.fakeSources) return kind === 'window' ? sources.fakeWindows() : sources.fakeScreens();
    // Never touch the capture API without permission: on macOS that pops a system prompt.
    if (ctx.isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return { error: 'screen-permission' };
    try {
      return kind === 'window' ? await sources.listWindows() : await sources.listScreens();
    } catch (err) {
      console.error('[recorder] listing sources failed', err);
      return { error: 'capture', message: String(err.message || err) };
    }
  });
  handle('recorder:region-info', (e, r) => regionInfo(validRegion(r)));
  handle('recorder:select-region', async () => {
    const win = panel;
    if (win && !win.isDestroyed()) win.hide();
    try {
      const r = await selectRegion();
      if (!r?.rect) return null;
      const region = validRegion({ displayId: r.displayId, ...r.rect });
      if (region) ctx.settings.set({ recording: { lastRegion: region, lastMode: 'region' } });
      return regionInfo(region);
    } catch (err) {
      console.error('[recorder] region selection failed', err);
      return null;
    } finally {
      if (win && !win.isDestroyed() && panel === win) ui.showFocused(win);
    }
  });
  handle('recorder:request-screen-access', async () => {
    // Touching the capture API makes macOS show its prompt and list Kadr in System Settings.
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch {
      /* the prompt is what we wanted */
    }
    return permissions();
  });
  handle('recorder:open-privacy', (e, kind) => {
    if (ctx.isWin) return shell.openExternal(kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy');
    return false;
  });
  handle('recorder:start', async (e, opts) => {
    try {
      return await startSession(opts || {});
    } catch (err) {
      console.error('[recorder] start failed', err);
      return { error: 'capture', message: String(err.message || err) };
    }
  });

  // Worker
  handle('recorder:worker-event', (e, evt) => {
    const s = rec;
    if (!s || e.sender.id !== s.workerId || evt?.sessionId !== s.id) return;
    onWorkerEvent(s, evt);
  });
  handle('recorder:stem-chunk', async (e, { name, data } = {}) => {
    const s = rec;
    const sink = s && e.sender.id === s.workerId ? s.stems?.[name] : null;
    if (!sink) return false;
    try {
      await sink.write(toBuffer(data));
      return true;
    } catch (err) {
      console.warn('[recorder] stem write failed', name, err.message); // the main file is still fine
      return false;
    }
  });
  handle('recorder:chunk', async (e, data) => {
    const s = rec;
    if (!s || e.sender.id !== s.workerId || !s.sink) return false;
    try {
      await s.sink.write(toBuffer(data));
      return true;
    } catch (err) {
      onRuntimeError(s, err);
      return false;
    }
  });

  // Controls / countdown / frame
  handle('recorder:get-state', () => snapshot());
  handle('recorder:control', (e, action) => {
    if (action === 'pause') pause();
    else if (action === 'resume') resume();
    else if (action === 'stop') stop();
    else if (action === 'discard') cancel();
    else if (action === 'mute') setMicMuted(true);
    else if (action === 'unmute') setMicMuted(false);
    return snapshot();
  });

  // Result window = video editor (also for any video file)
  editor.register();

  // Built-in region selector (fallback)
  handle('recorder:stub-done', (e, rect) => finishStub(rect));

  // Quitting mid-recording: save the video first.
  app.on('before-quit', (e) => {
    if (!rec || rec.phase === 'done') return;
    if (rec.phase === 'recording' || rec.phase === 'paused' || rec.phase === 'stopping') {
      e.preventDefault();
      stop().finally(() => app.quit());
    } else {
      cancel();
    }
  });

  // The ScreenCaptureKit helper crashed mid-recording: carry on without system audio.
  ctx.modules.native?.events?.on?.('audio-interrupted', () => {
    if (!rec?.sysStarted || rec.fakeAudio) return;
    rec.sysStarted = false;
    ctx.notify(t('recorder.notify.systemAudioLost'));
  });

  setTimeout(() => recoverLeftovers().catch((err) => console.warn('[recorder] recovery failed', err)), 4000);
}

module.exports = {
  register,
  openPanel,
  toggle,
  stop,
  cancel,
  isRecording,
  events,
  // Video editor for any file (tray "Open video…", drag & drop).
  openVideoEditor: (file) => editor.openVideoEditor(file),
  // Extras (not required by the contract) for the tray / hotkeys if wanted:
  pause,
  resume,
  setMicMuted,
  // Test hooks for `--dev` scripts only.
  _dev: {
    options: devOptions,
    panel: () => panel,
    session: () => rec,
    start: (opts) => startSession({ testSource: true, ...opts }),
    finalize: post.finalize,
    probe: post.probe,
    plan: require('../renderer/recorder/shared/export-plan.mjs'),
  },
};
