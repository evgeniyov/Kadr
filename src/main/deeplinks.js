'use strict';
// URL-scheme automation (like Shottr's deep links), off by default:
//   kadr://capture/area | fullscreen | window | activeWindow | repeatArea | scrolling | ocr | colorPicker | delayed
//   kadr://record  ·  kadr://record/stop  ·  kadr://library  ·  kadr://settings
//   kadr://open-clipboard  ·  kadr://pin-clipboard

const { app } = require('electron');
const ctx = require('./context');

const CAPTURE_MODES = new Set(['area', 'fullscreen', 'window', 'activeWindow', 'repeatArea', 'scrolling', 'scrollingUp', 'scrollingManual', 'ocr', 'translate', 'colorPicker', 'delayed']);

function run(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'kadr:') return;
  if (!ctx.settings.get('deepLinks')) {
    console.warn('[deeplinks] ignored (disabled in settings):', url);
    return;
  }
  const parts = [u.host, ...u.pathname.split('/')].filter(Boolean);
  const [cmd, arg] = parts;
  const m = ctx.modules;
  if (cmd === 'capture' && CAPTURE_MODES.has(arg || 'area')) m.capture?.start({ mode: arg || 'area' });
  else if (cmd === 'record') arg === 'stop' ? m.recording?.stop() : m.recording?.openPanel();
  else if (cmd === 'library') m.library?.openWindow();
  else if (cmd === 'settings') m.settingsWindow?.open();
  else if (cmd === 'open-clipboard') m.tray?.openClipboard();
  else if (cmd === 'pin-clipboard') m.tray?.pinClipboard();
  else console.warn('[deeplinks] unknown command:', url);
}

// The OS-level scheme registration only exists while the feature is enabled, and
// never for development builds (it would point LaunchServices at Electron.app).
function syncRegistration() {
  if (!app.isPackaged) return;
  try {
    if (ctx.settings.get('deepLinks')) app.setAsDefaultProtocolClient('kadr');
    else app.removeAsDefaultProtocolClient('kadr');
  } catch (e) {
    console.warn('[deeplinks] cannot (un)register scheme', e.message);
  }
}

function register() {
  syncRegistration();
  ctx.settings.on('change', (s, patch) => 'deepLinks' in patch && syncRegistration());
  const initial = process.argv.find((a) => a.startsWith('kadr://'));
  if (initial) setTimeout(() => run(initial), 800);
}

module.exports = { register, run };
