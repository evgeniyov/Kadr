'use strict';
// Menu-bar (macOS) / system tray (Windows) icon and menu.

const path = require('path');
const fs = require('fs');
const { Tray, Menu, nativeImage, app, dialog } = require('electron');
const clip = require('./clip');
const ctx = require('./context');

let tray = null;
let recState = { status: 'idle' };

function icon(name) {
  const file = path.join(ctx.paths.appRoot, 'build', 'tray', name);
  const img = nativeImage.createFromPath(file);
  if (ctx.isMac && name.includes('Template')) img.setTemplateImage(true);
  return img;
}

function trayIcon() {
  const rec = recState.status === 'recording' || recState.status === 'paused';
  if (ctx.isMac) return rec ? icon('recTemplate.png') : icon('trayTemplate.png');
  return rec ? icon('rec.png') : icon('tray.png');
}

function accel(key) {
  const a = ctx.settings.get(`hotkeys.${key}`);
  return a || undefined;
}

function capture(mode) {
  return () => ctx.modules.capture?.start({ mode });
}

function formatElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif'];
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];

// One "Open…" for everything Kadr can edit: images → image editor, videos → video editor.
async function openFile() {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: ctx.t('tray.filterAll'), extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] },
      { name: ctx.t('tray.filterImages'), extensions: IMAGE_EXTS },
      { name: ctx.t('tray.filterVideos'), extensions: VIDEO_EXTS },
    ],
  });
  if (!res.canceled) res.filePaths.forEach(openAnyFile);
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i;

async function openVideo() {
  const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'gif'] }] });
  if (res.canceled || !res.filePaths[0]) return;
  ctx.modules.recording?.openVideoEditor?.(res.filePaths[0]);
}

// Open any dropped / double-clicked file: videos → video editor, images → image editor.
function openAnyFile(file) {
  if (VIDEO_EXT.test(file) && !/\.gif$/i.test(file) && ctx.modules.recording?.openVideoEditor) return ctx.modules.recording.openVideoEditor(file);
  return openImageFile(file);
}

function openImageFile(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return ctx.notify(ctx.t('common.error'), path.basename(file));
  const dst = path.join(ctx.paths.captures, `${ctx.newId()}.png`);
  fs.writeFileSync(dst, img.toPNG());
  ctx.modules.editor?.openEditor({ imagePath: dst, scale: 1, meta: { source: 'file', fileName: path.basename(file), filePath: file } });
}

async function openClipboard() {
  const png = await clip.readImage().catch(() => null);
  if (!png) return ctx.notify(ctx.t('notify.noImageInClipboard'));
  const dst = path.join(ctx.paths.captures, `${ctx.newId()}.png`);
  fs.writeFileSync(dst, png);
  ctx.modules.editor?.openEditor({ imagePath: dst, scale: 1, meta: { source: 'clipboard' } });
}

async function pinClipboard() {
  const png = await clip.readImage().catch(() => null);
  if (!png) return ctx.notify(ctx.t('notify.noImageInClipboard'));
  ctx.modules.pin?.create({ data: png, scale: 1 });
}

function buildMenu() {
  const t = ctx.t;
  const rec = ctx.modules.recording;
  const recording = ['recording', 'paused', 'countdown', 'processing'].includes(recState.status);
  const pins = ctx.modules.pin?.count?.() || 0;

  const template = [
    { label: t('action.area'), accelerator: accel('area'), click: capture('area') },
    { label: t('action.fullscreen'), accelerator: accel('fullscreen'), click: capture('fullscreen') },
    { label: t('action.window'), accelerator: accel('window'), click: capture('window') },
    { label: t('action.activeWindow'), accelerator: accel('activeWindow'), click: capture('activeWindow') },
    { label: t('action.repeatArea'), accelerator: accel('repeatArea'), click: capture('repeatArea'), enabled: !!ctx.modules.capture?.lastArea },
    { type: 'separator' },
    { label: t('action.scrolling'), accelerator: accel('scrolling'), click: capture('scrolling') },
    { label: t('action.scrollingUp'), click: capture('scrollingUp') },
    { label: t('action.scrollingManual'), click: capture('scrollingManual') },
    { type: 'separator' },
    ...(recording
      ? [
          { label: `${t('action.recordStop')}  ${formatElapsed(recState.elapsedMs)}`, accelerator: accel('recordStop') || accel('record'), click: () => rec?.stop() },
          ...(recState.status === 'recording' || recState.status === 'paused'
            ? [
                recState.status === 'paused' ? { label: t('action.recordResume'), click: () => rec?.resume?.() } : { label: t('action.recordPause'), click: () => rec?.pause?.() },
                ...(recState.hasMic ? [{ label: t('action.recordMuteMic'), type: 'checkbox', checked: !!recState.micMuted, click: () => rec?.setMicMuted?.(!recState.micMuted) }] : []),
              ]
            : []),
        ]
      : [{ label: t('action.record'), accelerator: accel('record'), click: () => rec?.openPanel(), enabled: !!rec }]),
    { type: 'separator' },
    { label: t('action.ocr'), accelerator: accel('ocr'), click: capture('ocr') },
    { label: t('action.translate'), accelerator: accel('translate'), click: capture('translate') },
    { label: t('action.colorPicker'), accelerator: accel('colorPicker'), click: capture('colorPicker') },
    { label: t('action.delayed'), accelerator: accel('delayed'), click: capture('delayed') },
    { type: 'separator' },
    { label: t('action.openClipboard'), accelerator: accel('openClipboard'), click: openClipboard },
    { label: t('action.pinClipboard'), accelerator: accel('pinClipboard'), click: pinClipboard },
    { label: t('action.openFile'), click: openFile },
    ...(pins ? [{ label: t('pin.closeAll'), click: () => ctx.modules.pin.closeAll() }] : []),
    { type: 'separator' },
    { label: t('action.library'), accelerator: accel('library'), click: () => ctx.modules.library?.openWindow() },
    { label: t('action.settings'), accelerator: ctx.isMac ? 'Command+,' : undefined, click: () => ctx.modules.settingsWindow?.open() },
    { type: 'separator' },
    { label: t('action.quit'), accelerator: ctx.isMac ? 'Command+Q' : undefined, click: () => (ctx.modules.permissions ? ctx.modules.permissions.quitApp() : app.quit()) },
  ];
  // Accelerators in a tray menu are display-only; global shortcuts do the work.
  for (const item of template) if (item.accelerator) item.registerAccelerator = false;
  return Menu.buildFromTemplate(template);
}

function refresh() {
  if (!tray) return;
  tray.setImage(trayIcon());
  const rec = recState.status === 'recording' || recState.status === 'paused';
  if (ctx.isMac) tray.setTitle(rec ? ` ${formatElapsed(recState.elapsedMs)}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(rec ? ctx.t('tray.recording', { time: formatElapsed(recState.elapsedMs) }) : 'Kadr');
  tray.setContextMenu(buildMenu());
}

function isRecordingActive() {
  return ['countdown', 'recording', 'paused', 'processing'].includes(recState.status);
}

// The icon can be hidden in settings. While a recording runs it is shown anyway, because
// it is the way to stop a full-screen recording when the control bar is hidden.
function syncVisibility() {
  const want = ctx.settings.get('showTrayIcon') !== false || isRecordingActive();
  if (want && !tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Kadr');
    if (ctx.isWin) {
      // Windows shows the context menu only on right click by default; open it on left click too.
      tray.on('click', () => tray.popUpContextMenu());
    }
    // Files dropped on the macOS menu-bar icon open in the editor.
    tray.on('drop-files', (e, files) => files.forEach(openAnyFile));
    refresh();
  } else if (!want && tray) {
    tray.destroy();
    tray = null;
  }
}

function register() {
  syncVisibility();
  ctx.settings.on('change', (s, patch) => {
    if ('showTrayIcon' in patch) syncVisibility();
    if ('language' in patch || 'hotkeys' in patch) refresh();
  });
  const rec = ctx.modules.recording;
  rec?.events?.on('state', (s) => {
    const changed = s.status !== recState.status || s.micMuted !== recState.micMuted;
    recState = s;
    if (changed) {
      syncVisibility();
      refresh();
    } else if (tray) {
      if (ctx.isMac) tray.setTitle(s.status === 'recording' || s.status === 'paused' ? ` ${formatElapsed(s.elapsedMs)}` : '', { fontType: 'monospacedDigit' });
    }
  });
  // Pins count changes the menu; rebuild when windows come and go.
  app.on('browser-window-created', (e, w) => w.once('closed', () => setTimeout(refresh, 50)));
  app.on('browser-window-created', () => setTimeout(refresh, 50));

}

module.exports = { register, refresh, openClipboard, pinClipboard, openFile, openImageFile, openVideo, openAnyFile };
