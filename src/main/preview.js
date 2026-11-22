'use strict';
// Small floating thumbnail shown after a capture (like macOS / Shottr "preview").

const fs = require('fs');
const path = require('path');
const { screen, nativeImage } = require('electron');
const clip = require('./clip');
const ctx = require('./context');
const { saveBytes } = require('./basics');

const W = 260;
const MARGIN = 18;
let current = null; // { win, imagePath, scale, meta, options }

function show({ imagePath, scale = 1, meta = {}, options = {} }) {
  hideAll();
  const img = nativeImage.createFromPath(imagePath);
  const size = img.getSize();
  const ratio = size.height / Math.max(1, size.width);
  const imgH = Math.max(60, Math.min(220, Math.round((W - 16) * ratio)));
  const H = imgH + 16;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  const win = ctx.createWindow('preview', {
    params: { imageUrl: ctx.dataUrl(imagePath), timeout: ctx.settings.get('previewTimeout'), width: size.width, height: size.height },
    x: Math.round(wa.x + wa.width - W - MARGIN),
    y: Math.round(wa.y + wa.height - H - MARGIN),
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: true,
    show: false,
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setContentProtection(true);
  if (ctx.isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.once('ready-to-show', () => win.showInactive());
  current = { win, imagePath, scale, meta, options };
  win.on('closed', () => {
    if (current?.win === win) current = null;
  });
  return win;
}

function hideAll() {
  for (const w of ctx.windowsOfKind('preview')) w.destroy();
  current = null;
}

function withCurrent(e, fn) {
  const c = current && current.win.webContents.id === e.sender.id ? current : null;
  if (c) return fn(c);
}

function register() {
  ctx.handle('preview:edit', (e) =>
    withCurrent(e, (c) => {
      c.win.destroy();
      ctx.modules.editor?.openEditor({ imagePath: c.imagePath, scale: c.scale, meta: c.meta, options: c.options });
    })
  );
  ctx.handle('preview:copy', (e) => withCurrent(e, (c) => clip.writeImage(c.imagePath)));
  ctx.handle('preview:save', (e) =>
    withCurrent(e, async (c) => {
      const s = ctx.settings.get();
      const img = nativeImage.createFromPath(c.imagePath);
      const jpg = s.imageFormat === 'jpg';
      const file = await saveBytes({ data: jpg ? img.toJPEG(s.jpgQuality) : fs.readFileSync(c.imagePath), ext: jpg ? 'jpg' : 'png', name: ctx.formatFileName(s.fileNameTemplate, { app: c.meta.appName }) });
      if (file) ctx.notify(ctx.t('notify.saved', { name: path.basename(file) }), '', { onClick: () => require('electron').shell.showItemInFolder(file) });
      return file;
    })
  );
  ctx.handle('preview:pin', (e) =>
    withCurrent(e, (c) => {
      c.win.destroy();
      ctx.modules.pin?.create({ data: fs.readFileSync(c.imagePath), scale: c.scale });
    })
  );
  ctx.on('preview:start-drag', (e) =>
    withCurrent(e, (c) => {
      const file = path.join(ctx.paths.tmp, `${ctx.formatFileName(ctx.settings.get('fileNameTemplate'), { app: c.meta.appName })}.png`);
      fs.copyFileSync(c.imagePath, file);
      e.sender.startDrag({ file, icon: nativeImage.createFromPath(c.imagePath).resize({ width: 96 }) });
    })
  );
}

module.exports = { register, show, hideAll };
