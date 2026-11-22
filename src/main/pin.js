'use strict';
// Floating always-on-top pinned images.

const fs = require('fs');
const path = require('path');
const { Menu, nativeImage, screen } = require('electron');
const clip = require('./clip');
const ctx = require('./context');
const { toBuffer, saveBytes } = require('./basics');

const pinDir = path.join(ctx.paths.tmp, 'pins');
fs.mkdirSync(pinDir, { recursive: true });

const pins = new Map(); // webContents.id -> { win, file, scale, width, height, opacity, clickThrough }

function create({ data, scale = 1, x, y }) {
  const png = toBuffer(data);
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) throw new Error('empty image');
  const { width: pw, height: ph } = img.getSize();
  const file = path.join(pinDir, `${ctx.newId()}.png`);
  fs.writeFileSync(file, png);

  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(x != null ? { x, y } : cursor);
  let w = pw / scale;
  let h = ph / scale;
  const maxW = d.workArea.width * 0.8;
  const maxH = d.workArea.height * 0.8;
  const k = Math.min(1, maxW / w, maxH / h);
  w = Math.max(40, Math.round(w * k));
  h = Math.max(40, Math.round(h * k));
  const px = x != null ? Math.round(x) : Math.round(d.workArea.x + (d.workArea.width - w) / 2);
  const py = y != null ? Math.round(y) : Math.round(d.workArea.y + (d.workArea.height - h) / 2);

  const opacity = ctx.settings.get('pin.opacity') || 1;
  const win = ctx.createWindow('pin', {
    params: { imageUrl: ctx.dataUrl(file), width: w, height: h, naturalWidth: pw / scale, naturalHeight: ph / scale },
    x: px,
    y: py,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: ctx.settings.get('pin.shadow') !== false,
    alwaysOnTop: true,
    roundedCorners: false,
    show: false,
    enableLargerThanScreen: true,
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setAspectRatio(pw / ph);
  if (ctx.isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setOpacity(opacity);
  const id = win.webContents.id;
  pins.set(id, { win, file, png, scale, natural: { width: pw / scale, height: ph / scale }, opacity, clickThrough: false });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    pins.delete(id);
    fs.promises.unlink(file).catch(() => {});
  });
  return win;
}

function pinOf(e) {
  return pins.get(e.sender.id);
}

function setOpacity(p, v) {
  p.opacity = Math.max(0.1, Math.min(1, v));
  p.win.setOpacity(p.opacity);
}

function setClickThrough(p, on) {
  p.clickThrough = on;
  p.win.setIgnoreMouseEvents(on);
  p.win.webContents.send('pin:click-through', on);
}

function unlockAll() {
  for (const p of pins.values()) if (p.clickThrough) setClickThrough(p, false);
}

function closeAll() {
  for (const p of [...pins.values()]) if (!p.win.isDestroyed()) p.win.close();
}

function count() {
  return pins.size;
}

function zoom(p, factor, anchor) {
  const b = p.win.getBounds();
  const nw = Math.max(40, Math.round(b.width * factor));
  const nh = Math.max(40, Math.round((nw * p.natural.height) / p.natural.width));
  // Keep the point under the cursor fixed.
  const ax = anchor ? anchor.x / b.width : 0.5;
  const ay = anchor ? anchor.y / b.height : 0.5;
  p.win.setBounds({ x: Math.round(b.x + b.width * ax - nw * ax), y: Math.round(b.y + b.height * ay - nh * ay), width: nw, height: nh });
}

function menuFor(p) {
  const t = ctx.t;
  const op = (v) => ({ label: `${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs(p.opacity - v) < 0.01, click: () => setOpacity(p, v) });
  return Menu.buildFromTemplate([
    { label: t('pin.copy'), accelerator: 'CmdOrCtrl+C', click: () => clip.writeImage(p.png) },
    { label: t('pin.save'), accelerator: 'CmdOrCtrl+S', click: () => saveBytes({ data: p.png, ext: 'png', saveAs: true }) },
    { label: t('pin.edit'), click: () => openInEditor(p) },
    { type: 'separator' },
    { label: t('pin.opacity'), submenu: [1, 0.85, 0.7, 0.5, 0.3].map(op) },
    { label: t('pin.clickThrough'), type: 'checkbox', checked: p.clickThrough, click: () => setClickThrough(p, !p.clickThrough) },
    { label: t('pin.shadow'), type: 'checkbox', checked: p.win.hasShadow(), click: () => p.win.setHasShadow(!p.win.hasShadow()) },
    { label: t('pin.resetSize'), click: () => resetSize(p) },
    { type: 'separator' },
    { label: t('pin.close'), accelerator: 'Esc', click: () => p.win.close() },
    { label: t('pin.closeAll'), enabled: pins.size > 1, click: closeAll },
  ]);
}

function resetSize(p) {
  const b = p.win.getBounds();
  p.win.setBounds({ x: b.x, y: b.y, width: Math.round(p.natural.width), height: Math.round(p.natural.height) });
}

function openInEditor(p) {
  const file = path.join(ctx.paths.captures, `${ctx.newId()}.png`);
  fs.writeFileSync(file, p.png);
  ctx.modules.editor?.openEditor({ imagePath: file, scale: p.scale, meta: { source: 'pin' } });
}

function register() {
  ctx.handle('pin:create', (e, opts) => {
    create(opts);
  });
  ctx.handle('pin:menu', (e) => {
    const p = pinOf(e);
    if (p) menuFor(p).popup({ window: p.win });
  });
  ctx.handle('pin:move-by', (e, { dx, dy }) => {
    const p = pinOf(e);
    if (!p) return;
    const [x, y] = p.win.getPosition();
    p.win.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ctx.handle('pin:zoom', (e, { factor, anchor }) => {
    const p = pinOf(e);
    if (p) zoom(p, factor, anchor);
  });
  ctx.handle('pin:opacity-by', (e, delta) => {
    const p = pinOf(e);
    if (p) setOpacity(p, p.opacity + delta);
  });
  ctx.handle('pin:reset-size', (e) => {
    const p = pinOf(e);
    if (p) resetSize(p);
  });
  ctx.handle('pin:copy', (e) => {
    const p = pinOf(e);
    if (p) return clip.writeImage(p.png);
  });
  ctx.handle('pin:save', (e) => {
    const p = pinOf(e);
    if (p) return saveBytes({ data: p.png, ext: 'png', saveAs: true, parent: p.win });
  });
  ctx.handle('pin:edit', (e) => {
    const p = pinOf(e);
    if (p) openInEditor(p);
  });
}

module.exports = { register, create, unlockAll, closeAll, count };
