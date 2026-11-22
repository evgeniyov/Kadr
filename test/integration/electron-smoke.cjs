'use strict';
// Hidden real renderers, isolated userData, synthetic files and fake media devices only.
// Run explicitly on a machine with a graphical session: npm run test:electron.
const { app, session, nativeImage, dialog, globalShortcut } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { once } = require('events');
const { ffmpegPath } = require('../../src/main/ffmpeg');
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-electron-smoke-'));
app.setPath('userData', path.join(tmp, 'profile'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
process.argv.push('--dev');
const protocol = require('../../src/main/protocol');
protocol.registerSchemeAsPrivileged();
let ctx;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(win, expression) {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await wait(100);
  }
  throw new Error(`Renderer timed out: ${expression}`);
}

async function editorRegressions(png, prepared) {
  const library = ctx.modules.library.openWindow();
  await until(library, '!!window.kadr');
  const item = await ctx.modules.library.add(png);
  async function openItem() {
    await library.webContents.executeJavaScript(`kadr.invoke('library:open', ${JSON.stringify(item.id)})`);
    const win = ctx.windowsOfKind('editor').at(-1);
    await until(win, '!!window.__editor');
    return win;
  }
  const first = await openItem();
  const stale = await openItem();
  const notifications = [];
  const notify = ctx.notify;
  ctx.notify = (...args) => notifications.push(args);
  let restoredPixel, separateCopy, copies, conflictNotice;
  try {
    assert(await first.webContents.executeJavaScript(`(() => {
      const { app, output } = window.__editor;
      const mark = app.newObject('rect', 0, 0, { rectFill: 'solid', color: '#000000' });
      app.doc.add(Object.assign(mark, { w: 1, h: 1 }));
      return output.save();
    })()`));
    const pixel = (file) => Array.from(nativeImage.createFromPath(file).toBitmap().subarray(0, 4));
    assert.deepEqual(pixel(item.path), [0, 0, 0, 255]);
    assert(await stale.webContents.executeJavaScript('window.__editor.output.save()'));
    restoredPixel = pixel(item.path);
    const list = () => library.webContents.executeJavaScript("kadr.invoke('library:list')");
    const copy = (await list()).find(({ id }) => id !== item.id);
    separateCopy = copy && pixel(copy.path);
    assert(await stale.webContents.executeJavaScript('window.__editor.output.save()'));
    copies = (await list()).length;
    conflictNotice = notifications.some(([title]) => title === ctx.t('editor.libraryConflict.title'));
  } finally {
    ctx.notify = notify;
  }

  const edit = "window.__editor.app.setBackdrop({ enabled: true, padding: 8 }); window.__editor.app.dirty";
  const prompts = [];
  const showMessageBox = dialog.showMessageBox;
  const clip = require('../../src/main/clip');
  const writeImage = clip.writeImage;
  let clipboardImage;
  let libraryStayedOpen, captureStayedOpen;
  let onPrompt;
  function closeOrCancel(win) {
    return new Promise((resolve) => {
      const onClosed = () => resolve(false);
      win.once('closed', onClosed);
      onPrompt = () => {
        win.removeListener('closed', onClosed);
        resolve(true);
      };
      win.close();
    });
  }
  dialog.showMessageBox = async (win) => {
    prompts.push(win);
    onPrompt();
    return { response: 2 };
  };
  clip.writeImage = async (data) => { clipboardImage = nativeImage.createFromBuffer(data).getSize(); };
  try {
    assert(await stale.webContents.executeJavaScript(edit));
    libraryStayedOpen = await closeOrCancel(stale);
    assert(await prepared.webContents.executeJavaScript(edit));
    captureStayedOpen = await closeOrCancel(prepared);
    if (captureStayedOpen) {
      const closed = once(prepared, 'closed');
      await prepared.webContents.executeJavaScript("window.__editor.actions.escape()");
      await closed;
    }
  } finally {
    clip.writeImage = writeImage;
    dialog.showMessageBox = showMessageBox;
  }
  console.log('Library close kept edits:', libraryStayedOpen, 'Capture close kept edits:', captureStayedOpen);
  console.log('Original pixel after stale save:', restoredPixel, 'New copy pixel:', separateCopy);
  assert.deepEqual(restoredPixel, [0, 0, 0, 255]);
  assert.deepEqual(separateCopy, [0, 0, 255, 255]);
  assert.equal(copies, 2);
  assert.equal(conflictNotice, true);
  assert.deepEqual(prompts, [stale, prepared]);
  assert.equal(libraryStayedOpen, true);
  assert.equal(captureStayedOpen, true);
  assert.deepEqual(clipboardImage, { width: 18, height: 18 });
  console.log('PASS stale library save forks once, dirty capture/library close asks, Esc copies and closes');
}

async function resetHotkeys() {
  const registered = new Set();
  const { register, unregister } = globalShortcut;
  globalShortcut.register = (key) => { registered.add(key); return true; };
  globalShortcut.unregister = (key) => registered.delete(key);
  try {
    require('../../src/main/hotkeys').register();
    const defaultArea = ctx.settings.defaults.hotkeys.area;
    const customArea = 'Alt+F12';
    ctx.settings.set({ hotkeys: { area: customArea } });
    assert(registered.has(customArea) && !registered.has(defaultArea));
    const settings = ctx.createWindow('settings', { show: false });
    await until(settings, '!!window.kadr');
    await settings.webContents.executeJavaScript("kadr.invoke('settings:reset')");
    assert.equal(ctx.settings.get('hotkeys.area'), defaultArea);
    console.log('Default shortcut registered after reset:', registered.has(defaultArea));
    assert(registered.has(defaultArea) && !registered.has(customArea));
    console.log('PASS settings reset re-registers global shortcuts');
  } finally {
    Object.assign(globalShortcut, { register, unregister });
  }
}
const deadline = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  app.dock?.hide();
  app.focus = () => {};
  ctx = require('../../src/main/context');
  ctx.applyLang();
  ctx.notify = () => {};
  const create = ctx.createWindow;
  ctx.createWindow = (...args) => {
    const win = create(...args);
    win.show = win.showInactive = win.focus = () => {};
    return win;
  };
  ctx.settings.set({ saveFolder: path.join(tmp, 'output'), library: { enabled: false }, editor: { backdrop: { enabled: false } } });
  const security = require('../../src/main/security');
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    security.permissionAllowed(wc, ctx.entryFor(wc), permission, { ...details, requestingOrigin }));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) =>
    cb(security.permissionAllowed(wc, ctx.entryFor(wc), permission, details)));
  protocol.handle({ appRoot: root, userData: ctx.paths.userData });
  ctx.modules = { basics: require('../../src/main/basics'), editor: require('../../src/main/editor'),
    library: require('../../src/main/library'), ocr: require('../../src/main/ocr') };
  for (const module of Object.values(ctx.modules)) module.register();
  ctx.handle('recorder:chunk', () => true);
  assert.equal(ctx.entryFor(null), undefined);
  const png = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255]), { width: 2, height: 2 }).toPNG();
  const input = path.join(tmp, 'fixture.png'); fs.writeFileSync(input, png);
  const win = ctx.modules.editor.openEditor({ imagePath: input });
  await until(win, '!!window.__editor');
  const saved = await win.webContents.executeJavaScript('window.__editor.output.save({ format: "png" })');
  assert(saved && saved.startsWith(path.join(tmp, 'output')));
  assert.deepEqual(nativeImage.createFromPath(saved).getSize(), { width: 2, height: 2 });
  assert(await win.webContents.executeJavaScript(`window.kadr.invoke('native:capabilities').then(c => c.ocr)`));
  assert(await win.webContents.executeJavaScript(`window.kadr.invoke('recorder:chunk', []).then(() => false, () => true)`));
  assert(await win.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return false; }, () => true)`));
  console.log('PASS real editor bootstrap, PNG export, IPC denial, camera denial');

  const dirtyStates = await win.webContents.executeJavaScript(`(() => {
    const { app, output } = window.__editor;
    app.dirty = false;
    app.setBackdrop({ enabled: true, padding: 8 });
    const backdropDirty = app.dirty;
    app.setBackdrop({ enabled: false });
    const text = app.newObject('text', 0, 0);
    app.doc.add(text);
    app.textEditor.begin(text, { isNew: true });
    app.dirty = false;
    app.textEditor.ta.value = 'Synthetic unsaved text';
    app.textEditor.ta.dispatchEvent(new Event('input'));
    const typingDirty = app.dirty;
    const stillEditing = app.textEditor.active;
    app.textEditor.commit();
    app.undo();
    return { backdropDirty, typingDirty, stillEditing, remainingObjects: app.doc.objects.length };
  })()`);
  assert.deepEqual(dirtyStates, { backdropDirty: true, typingDirty: true, stillEditing: true, remainingObjects: 0 });
  console.log('PASS backdrop-only and live text edits are marked unsaved; text undo restores the image');

  const gif = path.join(tmp, 'concealed.gif');
  const showSaveDialog = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: gif });
  try {
    await win.webContents.executeJavaScript(`(async () => {
      const { app, output } = window.__editor;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 32, 16);
      ctx.fillStyle = 'red';
      ctx.fillRect(4, 4, 8, 8);
      app.doc.setBase(canvas);
      const cover = app.newObject('conceal', 4, 4, { concealType: 'erase' });
      app.doc.add(Object.assign(cover, { w: 8, h: 8 }));
      const mark = app.newObject('rect', 20, 4, { rectFill: 'solid', color: '#0000FF' });
      app.doc.add(Object.assign(mark, { w: 8, h: 8 }));
      await output.exportGif();
    })()`);
  } finally {
    dialog.showSaveDialog = showSaveDialog;
  }
  const decoded = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', gif,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 20000 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(decoded.stdout.length, 2 * 32 * 16 * 3);
  const pixel = (frame, x, y) => {
    const offset = ((frame * 16 + y) * 32 + x) * 3;
    return Array.from(decoded.stdout.subarray(offset, offset + 3));
  };
  assert.deepEqual(pixel(0, 8, 8), [255, 255, 255]);
  assert.deepEqual(pixel(1, 8, 8), [255, 255, 255]);
  assert.deepEqual(pixel(0, 24, 8), [255, 255, 255]);
  assert.deepEqual(pixel(1, 24, 8), [0, 0, 255]);
  console.log('PASS real GIF keeps concealment in both decoded frames');

  const scroller = ctx.createWindow('scroller', { params: { role: 'worker' }, webPreferences: { backgroundThrottling: false } });
  await until(scroller, '!!window.kadr');
  assert(await scroller.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(s => { const ok = s.getVideoTracks().length === 1; s.getTracks().forEach(t => t.stop()); return ok; })`));
  assert(await scroller.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(s => { s.getTracks().forEach(t => t.stop()); return false; }, () => true)`));
  console.log('PASS scroll worker synthetic video permission, microphone denied');

  ctx.modules.editor.prepareEditor();
  const prepared = ctx.modules.editor.openEditor({ imagePath: path.join(ctx.paths.captures, 'not-written.png'),
    usePrepared: true, pixels: { width: 2, height: 2, data: nativeImage.createFromBuffer(png).toBitmap() } });
  await until(prepared, '!!window.__editor');
  const rawSaved = await prepared.webContents.executeJavaScript('window.__editor.output.save({ format: "png" })');
  assert.deepEqual(nativeImage.createFromPath(rawSaved).toBitmap(), nativeImage.createFromBuffer(png).toBitmap());
  assert.equal(ctx.entryFor(prepared.webContents).params.pixels, undefined);
  console.log('PASS prepared editor receives raw pixels before PNG exists and releases the buffer');

  const clip = path.join(tmp, 'fixture.mp4');
  const encode = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip], { timeout: 20000 });
  assert.equal(encode.status, 0, encode.stderr?.toString());
  const video = require('../../src/main/recording/editor'); video.register();
  const videoWin = await video.openVideoEditor(clip);
  assert(videoWin);
  await until(videoWin, '!!document.querySelector("video") && document.querySelector("video").readyState >= 2');
  const range = await videoWin.webContents.executeJavaScript(`(async () => { const v = document.querySelector('video'); const r = await fetch(v.src, { headers: { Range: 'bytes=10-29' } }); return [r.status, (await r.arrayBuffer()).byteLength, r.headers.get('Content-Range')]; })()`);
  assert.equal(range[0], 206); assert.equal(range[1], 20); assert(range[2].startsWith('bytes 10-29/'));
  console.log('PASS video editor playback and byte-range seek response');
  const probeErrors = [];
  for (const probe of [() => editorRegressions(png, prepared), resetHotkeys]) {
    try { await probe(); } catch (e) { probeErrors.push(e); }
  }
  if (probeErrors.length) throw new AggregateError(probeErrors, 'Electron regression probes failed');
  await ctx.modules.library.flush();
}).then(() => finish(0), (error) => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(deadline);
  for (const entry of ctx?.registry.values() || []) if (!entry.win.isDestroyed()) entry.win.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
