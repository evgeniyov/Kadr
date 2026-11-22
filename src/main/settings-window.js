'use strict';
// Settings window + side effects of settings that live outside the renderer.

const { app, screen } = require('electron');
const ctx = require('./context');

function open(tab) {
  const existing = ctx.windowsOfKind('settings')[0];
  if (existing) {
    if (tab) existing.webContents.send('settings:tab', tab);
    existing.show();
    if (ctx.isMac) app.focus({ steal: true });
    existing.focus();
    return existing;
  }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = 780;
  const h = 600;
  const win = ctx.createWindow('settings', {
    params: { tab: tab || 'general' },
    width: w,
    height: h,
    x: Math.round(d.workArea.x + (d.workArea.width - w) / 2),
    y: Math.round(d.workArea.y + (d.workArea.height - h) / 3),
    minWidth: 700,
    minHeight: 480,
    title: ctx.t('settings.title'),
    titleBarStyle: ctx.isMac ? 'hiddenInset' : 'default',
    maximizable: false,
    fullscreenable: false,
  });
  win.once('ready-to-show', () => {
    win.show();
    if (ctx.isMac) app.focus({ steal: true });
  });
  return win;
}

function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!ctx.settings.get('launchAtLogin'), openAsHidden: true });
  } catch (e) {
    console.warn('[settings] login item failed', e.message);
  }
}

// Windows the user works in (not overlays, pins, toolbars): while any is open, Kadr shows
// up in the Dock and ⌘Tab like a normal app, and the Dock menu lists them.
const DOCUMENT_PAGES = new Set(['editor', 'library', 'settings', 'recorder/editor']);

function hasDocumentWindows() {
  for (const r of ctx.registry.values()) {
    if (DOCUMENT_PAGES.has(r.page) && !r.win.isDestroyed() && r.win.isVisible()) return true;
  }
  return false;
}

let dockVisible = null;
let lastShown = null; // switching the activation policy can drop focus: give it back
let dockRetry = null;
function applyDock() {
  if (!ctx.isMac || !app.dock) return;
  const want = !!ctx.settings.get('alwaysShowDockIcon') || hasDocumentWindows();
  if (want === dockVisible) return;
  dockVisible = want;
  setDock(want, 0);
}

// macOS ignores a hide that comes right after a show (the switch to a regular app is still in
// progress) and the icon would stay in the Dock and ⌘Tab for good: check, repeat until it takes.
function setDock(show, attempt) {
  clearTimeout(dockRetry);
  if (show) {
    const w = lastShown;
    Promise.resolve(app.dock.show()).then(() => {
      if (!w || w.isDestroyed() || !w.isVisible()) return;
      app.focus({ steal: true });
      w.focus();
    });
  } else app.dock.hide();
  dockRetry = setTimeout(() => {
    if (dockVisible === show && app.dock.isVisible() !== show && attempt < 10) setDock(show, attempt + 1);
  }, 400);
}

let dockTimer = null;
function scheduleDock(win) {
  if (win && !win.isDestroyed?.()) lastShown = win;
  clearTimeout(dockTimer);
  dockTimer = setTimeout(applyDock, 60);
}

function register() {
  ctx.settings.on('change', (s, patch) => {
    if ('launchAtLogin' in patch) applyLoginItem();
    if ('alwaysShowDockIcon' in patch) applyDock();
  });
  if (ctx.isMac) {
    applyDock();
    app.on('browser-window-created', (e, win) => {
      win.on('show', () => scheduleDock(win));
      win.on('hide', () => scheduleDock());
      win.on('closed', () => scheduleDock());
    });
  }
  // Keep the OS login item in sync with the stored preference on first run.
  if (ctx.settings.get('launchAtLogin') !== app.getLoginItemSettings().openAtLogin) applyLoginItem();
}

module.exports = { register, open };
