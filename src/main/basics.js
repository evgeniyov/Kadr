'use strict';
// Generic IPC: window control, settings, app utilities, clipboard, saving images.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage, shell, dialog, systemPreferences } = require('electron');
const clip = require('./clip');
const { writeFileAtomic } = require('./atomic-file');
const { safeBase, safeExtension, assertSettingsPatch } = require('./security');
const ctx = require('./context');

const EXT_FILTERS = {
  png: { name: 'PNG', extensions: ['png'] },
  jpg: { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  webp: { name: 'WebP', extensions: ['webp'] },
  gif: { name: 'GIF', extensions: ['gif'] },
  mp4: { name: 'MP4', extensions: ['mp4'] },
  webm: { name: 'WebM', extensions: ['webm'] },
};

// Choosing an unused name and committing its bytes are one operation. Multiple
// editor/capture windows can otherwise select the same name before either write
// finishes, and the second atomic rename silently replaces the first screenshot.
const autoSaveChains = new Map();
function autoSave(dir, base, ext, data) {
  const key = fs.realpathSync(dir);
  const previous = autoSaveChains.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const file = ctx.uniquePath(dir, base, ext);
    await writeFileAtomic(file, data);
    return file;
  });
  autoSaveChains.set(key, job);
  job.finally(() => {
    if (autoSaveChains.get(key) === job) autoSaveChains.delete(key);
  }).catch(() => {});
  return job;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error('expected binary data');
}

function writeImageToClipboard(buf) {
  return clip.writeImage(toBuffer(buf));
}

// Save bytes to the screenshots folder (or via a Save dialog).
// opts: { data, ext='png', name?, saveAs?, folder?, window? }
async function saveBytes({ data, ext = 'png', name, saveAs = false, folder, parent }) {
  ext = safeExtension(ext);
  const s = ctx.settings.get();
  const dir = folder || s.saveFolder;
  const base = safeBase(name || ctx.formatFileName(s.fileNameTemplate));
  let file;
  if (saveAs) {
    fs.mkdirSync(dir, { recursive: true });
    const res = await dialog.showSaveDialog(parent || null, {
      defaultPath: path.join(dir, `${base}.${ext}`),
      filters: [EXT_FILTERS[ext] || { name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return null;
    file = res.filePath;
  } else {
    fs.mkdirSync(dir, { recursive: true });
    return autoSave(dir, base, ext, toBuffer(data));
  }
  await writeFileAtomic(file, toBuffer(data));
  return file;
}

function register() {
  const { handle, on, settings } = ctx;
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  // ---- window --------------------------------------------------------------
  handle('win:params', (e) => ctx.entryFor(e.sender)?.params || {});
  handle('win:close', (e) => winOf(e)?.close());
  handle('win:hide', (e) => winOf(e)?.hide());
  handle('win:show', (e, { focus = true } = {}) => {
    const w = winOf(e);
    if (!w) return;
    focus ? w.show() : w.showInactive();
  });
  handle('win:focus', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (ctx.isMac) app.focus({ steal: true });
    w.focus();
  });
  handle('win:minimize', (e) => winOf(e)?.minimize());
  handle('win:toggle-maximize', (e) => {
    const w = winOf(e);
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  handle('win:get-bounds', (e) => winOf(e)?.getBounds());
  handle('win:set-bounds', (e, b, animate = false) => winOf(e)?.setBounds(b, animate));
  handle('win:set-size', (e, { width, height, center = false }) => {
    const w = winOf(e);
    if (!w) return;
    w.setSize(Math.round(width), Math.round(height));
    if (center) w.center();
  });
  handle('win:set-min-size', (e, { width, height }) => winOf(e)?.setMinimumSize(Math.round(width), Math.round(height)));
  handle('win:center', (e) => winOf(e)?.center());
  handle('win:set-title', (e, title) => winOf(e)?.setTitle(String(title)));
  handle('win:set-ignore-mouse', (e, ignore, forward = true) => winOf(e)?.setIgnoreMouseEvents(!!ignore, { forward }));
  handle('win:set-opacity', (e, v) => winOf(e)?.setOpacity(Math.max(0.05, Math.min(1, v))));
  handle('win:set-always-on-top', (e, v, level = 'floating') => winOf(e)?.setAlwaysOnTop(!!v, level));
  handle('win:set-resizable', (e, v) => winOf(e)?.setResizable(!!v));
  handle('win:display', (e) => {
    const w = winOf(e);
    const { screen } = require('electron');
    const d = w ? screen.getDisplayMatching(w.getBounds()) : screen.getPrimaryDisplay();
    return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
  });

  // ---- settings ------------------------------------------------------------
  handle('settings:get', () => settings.get());
  handle('settings:set', (e, patch) => {
    assertSettingsPatch(ctx.entryFor(e.sender)?.page, patch);
    return settings.set(patch);
  });
  handle('settings:reset', () => settings.reset());
  handle('settings:defaults', () => settings.defaults);

  // ---- app -------------------------------------------------------------------
  handle('app:locale', () => app.getLocale());
  handle('app:version', () => app.getVersion());
  handle('app:open-external', (e, url) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
  handle('app:reveal', (e, p) => shell.showItemInFolder(ctx.assertPath(e.sender, p)));
  handle('app:open-path', (e, p) => {
    if (ctx.entryFor(e.sender)?.page === 'settings') {
      if (![settings.get('saveFolder'), settings.get('recording.saveFolder')].includes(p) || !fs.statSync(p).isDirectory()) throw new Error('Folder access denied');
    } else ctx.assertPath(e.sender, p);
    return shell.openPath(p);
  });
  // Sent by pathForFile after webUtils verified a genuine OS File, never exposed as a generic bridge channel.
  on('app:grant-file', (e, p) => ctx.grantPath(e.sender, p));
  handle('app:open-settings', (e, tab) => ctx.modules.settingsWindow?.open(tab));
  handle('app:open-library', () => ctx.modules.library?.openWindow());
  handle('app:quit', () => (ctx.modules.permissions ? ctx.modules.permissions.quitApp() : app.quit()));
  handle('app:notify', (e, { title, body }) => ctx.notify(title, body));
  handle('app:choose-folder', async (e, { defaultPath } = {}) => {
    const res = await dialog.showOpenDialog(winOf(e), {
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : ctx.grantPath(e.sender, res.filePaths[0]);
  });
  handle('app:choose-file', async (e, { filters, defaultPath } = {}) => {
    const res = await dialog.showOpenDialog(winOf(e), { defaultPath, filters, properties: ['openFile'] });
    return res.canceled ? null : ctx.grantPath(e.sender, res.filePaths[0]);
  });
  handle('app:confirm', async (e, { message, detail, ok, cancel, danger }) => {
    const res = await dialog.showMessageBox(winOf(e), {
      type: danger ? 'warning' : 'question',
      message,
      detail,
      buttons: [ok || ctx.t('common.ok'), cancel || ctx.t('common.cancel')],
      defaultId: 0,
      cancelId: 1,
    });
    return res.response === 0;
  });
  handle('app:permissions', async () => {
    const out = { screen: 'granted', accessibility: true, microphone: 'granted' };
    if (ctx.isMac) {
      out.screen = systemPreferences.getMediaAccessStatus('screen');
      out.microphone = systemPreferences.getMediaAccessStatus('microphone');
      out.accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    } else if (ctx.isWin) {
      out.microphone = systemPreferences.getMediaAccessStatus('microphone');
    }
    return out;
  });
  handle('app:request-permission', (e, kind) => ctx.modules.permissions?.request(kind));

  // ---- clipboard -------------------------------------------------------------
  handle('clipboard:write-image', (e, data) => writeImageToClipboard(data));
  handle('clipboard:write-text', (e, text) => clip.writeText(text));
  handle('clipboard:read-text', () => clip.readText());
  handle('clipboard:read-image', () => clip.readImage());

  // ---- images ----------------------------------------------------------------
  // { data: Uint8Array, ext, name?, saveAs? } → absolute path | null
  handle('image:save', async (e, opts) => {
    if (opts.folder) ctx.assertPath(e.sender, opts.folder, { parent: true });
    const file = await saveBytes({ ...opts, parent: winOf(e) });
    if (file) ctx.grantPath(e.sender, file);
    if (file && !opts.silent) ctx.notify(ctx.t('notify.saved', { name: path.basename(file) }), '', { onClick: () => shell.showItemInFolder(file) });
    return file;
  });
  // Write bytes to a temp file (e.g. for drag-out / external apps) → path
  handle('image:temp-file', async (e, { data, ext = 'png', name }) => {
    const file = path.join(ctx.paths.tmp, `${safeBase(name || ctx.formatFileName(ctx.settings.get('fileNameTemplate')))}.${safeExtension(ext)}`);
    await writeFileAtomic(file, toBuffer(data));
    return file;
  });
  // Drag a file out of the app. Must be sent during a dragstart handler.
  // payload: { path } or { data, ext, name }
  on('image:start-drag', (e, payload) => {
    try {
      let file = payload.path;
      if (file) ctx.assertPath(e.sender, file);
      if (!file) {
        const base = safeBase(payload.name || ctx.formatFileName(ctx.settings.get('fileNameTemplate')));
        file = path.join(ctx.paths.tmp, `${base}.${safeExtension(payload.ext || 'png')}`);
        fs.writeFileSync(file, toBuffer(payload.data));
      }
      let icon = nativeImage.createFromPath(file);
      if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(ctx.paths.appRoot, 'build', 'drag.png'));
      else icon = icon.resize({ width: 96 });
      e.sender.startDrag({ file, icon });
    } catch (err) {
      console.error('start-drag failed', err);
    }
  });
  handle('image:open-with-default', async (e, { data, ext = 'png' }) => {
    const file = path.join(ctx.paths.tmp, `${safeBase(ctx.formatFileName(ctx.settings.get('fileNameTemplate')))}.${safeExtension(ext)}`);
    await writeFileAtomic(file, toBuffer(data));
    return shell.openPath(file);
  });
}

module.exports = { register, saveBytes, writeImageToClipboard, toBuffer };
