'use strict';
// Global keyboard shortcuts (configurable in settings.hotkeys).

const { globalShortcut } = require('electron');
const ctx = require('./context');

const capture = (mode) => () => ctx.modules.capture?.start({ mode });

const ACTIONS = {
  area: capture('area'),
  fullscreen: capture('fullscreen'),
  window: capture('window'),
  activeWindow: capture('activeWindow'),
  repeatArea: capture('repeatArea'),
  scrolling: capture('scrolling'),
  ocr: capture('ocr'),
  translate: capture('translate'),
  colorPicker: capture('colorPicker'),
  delayed: capture('delayed'),
  record: () => ctx.modules.recording?.toggle(),
  recordStop: () => ctx.modules.recording?.stop(),
  openClipboard: () => ctx.modules.tray?.openClipboard(),
  pinClipboard: () => ctx.modules.tray?.pinClipboard(),
  library: () => ctx.modules.library?.openWindow(),
  settings: () => ctx.modules.settingsWindow?.open(),
};

let devSuspended = false;
const suspensions = new Map(); // webContents -> cleanup; a crashed settings page cannot disable Kadr
let lastFailed = '';
const status = {}; // key -> 'ok' | 'failed'
const registered = new Set(); // only our accelerators (other modules may register their own)

function registerAll() {
  for (const acc of registered) globalShortcut.unregister(acc);
  registered.clear();
  for (const key of Object.keys(status)) delete status[key];
  if (devSuspended || suspensions.size) return;
  const hotkeys = ctx.settings.get('hotkeys') || {};
  const failed = [];
  for (const [key, acc] of Object.entries(hotkeys)) {
    if (!acc || !ACTIONS[key]) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => {
        try {
          Promise.resolve(ACTIONS[key]()).catch((e) => console.error(`[hotkeys] ${key} failed`, e));
        } catch (e) {
          console.error(`[hotkeys] ${key} failed`, e);
        }
      });
    } catch (e) {
      ok = false;
    }
    status[key] = ok ? 'ok' : 'failed';
    if (ok) registered.add(acc);
    else failed.push(acc);
  }
  const sig = failed.join(',');
  if (failed.length && sig !== lastFailed) ctx.notify(ctx.t('notify.hotkeyFailed', { key: failed.join(', ') }));
  lastFailed = sig;
}

function register() {
  // Test runs must not steal the shortcuts of an installed Kadr that is running.
  if (process.argv.some((a) => a.startsWith('--dev-script='))) devSuspended = true;
  registerAll();
  ctx.settings.on('change', (s, patch) => {
    if ('hotkeys' in patch) registerAll();
  });
  // The settings window suspends global shortcuts while recording a new one.
  ctx.handle('app:suspend-hotkeys', (e, on) => {
    const sender = e.sender;
    if (on && !suspensions.has(sender) && !sender.isDestroyed()) {
      const release = () => {
        sender.removeListener('destroyed', release);
        sender.removeListener('render-process-gone', release);
        suspensions.delete(sender);
        registerAll();
      };
      suspensions.set(sender, release);
      sender.once('destroyed', release);
      sender.once('render-process-gone', release);
    } else if (!on && suspensions.has(sender)) {
      suspensions.get(sender)();
      return;
    }
    registerAll();
  });
  ctx.handle('app:hotkey-status', () => ({ ...status }));
}

module.exports = { register, registerAll, ACTIONS };
