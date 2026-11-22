'use strict';
// Shared application context: paths, settings, i18n, window factory and small
// helpers used by every main-process module. Created once in index.js.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, Notification, nativeTheme, screen } = require('electron');
const { Settings } = require('./settings');
const { appUrl, dataUrlFor } = require('./protocol');
const security = require('./security');

const i18n = require('../shared/i18n/index.mjs');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const appRoot = path.join(__dirname, '..', '..');
const userData = app.getPath('userData');

const paths = {
  appRoot,
  userData,
  captures: path.join(userData, 'captures'),
  library: path.join(userData, 'library'),
  tmp: path.join(userData, 'tmp'),
  recordings: path.join(userData, 'recordings-tmp'),
  // Bundled binaries (native helper). In a packaged app they live in resources/.
  resources: app.isPackaged ? process.resourcesPath : path.join(appRoot, 'resources'),
};
for (const k of ['captures', 'library', 'tmp', 'recordings']) fs.mkdirSync(paths[k], { recursive: true });

const settings = new Settings();

function applyLang() {
  i18n.setLang(i18n.resolveLang(settings.get('language'), app.getLocale()));
}

// ---- Window registry -------------------------------------------------------
// Every window gets `params` which its renderer reads via invoke('win:params').
const registry = new Map(); // webContents.id -> { kind, params, win }

const PRELOAD = path.join(appRoot, 'src', 'preload', 'preload.js');

function createWindow(kind, opts = {}) {
  const { params = {}, webPreferences = {}, page, ...bw } = opts;
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    show: false,
    backgroundColor: bw.transparent ? '#00000000' : dark ? '#1e1e20' : '#f5f5f7',
    title: 'Kadr',
    autoHideMenuBar: true,
    ...bw,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      ...webPreferences,
    },
  });
  const id = win.webContents.id;
  registry.set(id, { kind, page: page || kind, params, win });
  win.on('closed', () => { registry.delete(id); pathGrants.delete(id); });
  const allowedUrl = appUrl(`renderer/${page || kind}/index.html`);
  win.webContents.on('will-navigate', (event, url) => { if (url !== allowedUrl) event.preventDefault(); });
  win.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame || event.url !== allowedUrl) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(appUrl(`renderer/${page || kind}/index.html`));
  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      console.log(`[${kind}] ${level}: ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
    });
  }
  return win;
}

function windowsOfKind(kind) {
  return [...registry.values()].filter((r) => r.kind === kind && !r.win.isDestroyed()).map((r) => r.win);
}

function entryFor(webContents) {
  return registry.get(webContents?.id);
}

// ---- IPC helpers -----------------------------------------------------------
function trustedSender(event, channel, mode = 'invoke') {
  const entry = registry.get(event.sender?.id);
  return security.trustedSender(event, entry) && security.channelAllowed(entry.page, channel, mode);
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, channel)) throw new Error('IPC access denied');
    return fn(event, ...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!trustedSender(event, channel, 'send')) return;
    fn(event, ...args);
  });
}
const pathGrants = new Map();
function grantPath(sender, file) {
  const real = security.realPath(file);
  if (!pathGrants.has(sender.id)) pathGrants.set(sender.id, new Set());
  pathGrants.get(sender.id).add(real);
  return file;
}
function assertPath(sender, file, { parent = false } = {}) {
  const real = security.realPath(file);
  const grants = pathGrants.get(sender.id);
  if (!grants?.has(real) && !(parent && [...(grants || [])].some((p) => path.dirname(p) === real))) throw new Error('File access denied');
  return file;
}

// ---- Misc helpers ----------------------------------------------------------
function notify(title, body = '', { onClick } = {}) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (e) {
    console.error('notify failed', e);
  }
}

function pad(n, l = 2) {
  return String(n).padStart(l, '0');
}

// Expand a file name template like 'Kadr {YYYY}-{MM}-{DD} в {HH}.{mm}.{ss}'.
function formatFileName(template, extra = {}) {
  const d = new Date();
  const map = {
    YYYY: d.getFullYear(),
    YY: String(d.getFullYear()).slice(2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    ms: pad(d.getMilliseconds(), 3),
    app: extra.app || '',
    n: extra.n ?? '',
  };
  const name = template.replace(/\{(\w+)\}/g, (m, k) => (k in map ? String(map[k]) : m));
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Kadr';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  let i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++}).${ext}`);
  return p;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

const ctx = {
  isMac,
  isWin,
  paths,
  settings,
  i18n,
  t: (k, v) => i18n.t(k, v),
  applyLang,
  createWindow,
  windowsOfKind,
  entryFor,
  trustedSender,
  grantPath,
  assertPath,
  registry,
  handle,
  on,
  notify,
  formatFileName,
  uniquePath,
  newId,
  displayById,
  dataUrl: (abs) => dataUrlFor(userData, abs),
  appUrl,
  // Filled in by index.js after modules load (to avoid require cycles):
  modules: {},
};

module.exports = ctx;
