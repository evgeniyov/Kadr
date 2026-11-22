'use strict';
// One synthetic sample per image size, with an isolated profile and hidden windows.
// Measures editor work only, NOT desktop capture latency or a stable performance baseline.
// Run: electron test/integration/editor-benchmark.cjs [output-directory]
const { app, BrowserWindow, session, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'kadr-audit-visuals'));
fs.mkdirSync(output, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-editor-benchmark-'));
app.setPath('userData', path.join(tmp, 'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
process.argv.push('--dev');
const protocol = require('../../src/main/protocol');
protocol.registerSchemeAsPrivileged();
app.on('window-all-closed', () => {}); // keep running between isolated fixture/editor windows
let ctx;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 10) / 10;
const results = { electron: process.versions.electron, platform: process.platform, arch: process.arch,
  methodology: 'One sequential sample per size; hidden editor, synthetic PNG, no desktop/audio capture. Main + all current Electron child processes working-set RSS; includes app/runtime overhead. Concurrent system load is uncontrolled.', samples: [] };

async function memory(win) {
  const metrics = app.getAppMetrics();
  const pid = win.webContents.getOSProcessId();
  return { editorRssMiB: round((metrics.find((p) => p.pid === pid)?.memory?.workingSetSize || 0) / 1024),
    totalRssMiB: round(metrics.reduce((sum, p) => sum + (p.memory?.workingSetSize || 0), 0) / 1024),
    mainHeapMiB: round(process.memoryUsage().heapUsed / 1024 ** 2) };
}

async function createFixture(width, height) {
  const maker = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await maker.loadURL('data:text/html,<html><body></body></html>');
    const png = await maker.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas'); c.width = ${width}; c.height = ${height};
      const g = c.getContext('2d'), k = c.width / 1920; g.scale(k, k);
      g.fillStyle = '#e9edf4'; g.fillRect(0, 0, 1920, 1080);
      g.fillStyle = '#172033'; g.fillRect(0, 0, 1920, 96);
      g.fillStyle = '#ffffff'; g.font = 'bold 28px system-ui'; g.fillText('SYNTHETIC EDITOR FIXTURE', 52, 60);
      g.fillStyle = '#62708a'; g.font = '20px system-ui'; g.fillText('No personal data · deterministic test canvas · ${width} × ${height}', 52, 145);
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        const x = 52 + col * 610, y = 186 + row * 280;
        g.fillStyle = '#fff'; g.beginPath(); g.roundRect(x, y, 584, 252, 14); g.fill();
        g.fillStyle = '#28364c'; g.font = 'bold 22px system-ui'; g.fillText('Sample card ' + (row * 3 + col + 1), x + 24, y + 42);
        g.fillStyle = '#a0adc2'; g.font = '16px system-ui'; g.fillText('Annotation, scale and export verification', x + 24, y + 72);
        g.fillStyle = ['#4a77d4', '#1b9687', '#9a63c2'][col];
        for (let b = 0; b < 12; b++) { const h = 24 + ((b * 23 + row * 31 + col * 17) % 110); g.fillRect(x + 24 + b * 44, y + 226 - h, 28, h); }
      }
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    const file = path.join(output, `fixture-${width}x${height}.png`);
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    return file;
  } finally { maker.destroy(); }
}

async function sample(width, height) {
  const file = await createFixture(width, height);
  const began = performance.now();
  const win = ctx.modules.editor.openEditor({ imagePath: file });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
  try {
    for (let i = 0; i < 300; i++) {
      if (await win.webContents.executeJavaScript('!!window.__editor')) break;
      await wait(20);
    }
    assert(await win.webContents.executeJavaScript('!!window.__editor'), 'editor must bootstrap');
    const openMs = round(performance.now() - began);
    const interaction = await win.webContents.executeJavaScript(`(async () => {
      const { app } = window.__editor, k = app.doc.width / 1920, begin = performance.now();
      const rect = app.newObject('rect', 60 * k, 195 * k, { color: '#F34242', size: 4 });
      Object.assign(rect, { w: 565 * k, h: 242 * k }); app.doc.add(rect);
      const arrow = app.newObject('arrow', 930 * k, 470 * k, { color: '#EF3A48', size: 4 });
      Object.assign(arrow, { x2: 470 * k, y2: 365 * k, mx: 700 * k, my: 417.5 * k }); app.doc.add(arrow);
      const text = app.newObject('text', 780 * k, 405 * k, { fontSize: 28 * k, textStyle: 'box', color: '#18243A', shadow: false });
      text.text = 'Проверка аннотаций / Synthetic check'; app.doc.add(text);
      app.commit(); app.setTool('select'); app.select(rect.id); app.frame();
      const annotationMs = performance.now() - begin;
      const zoomStart = performance.now(); app.view.setZoom(1); app.frame();
      const zoom100Ms = performance.now() - zoomStart;
      app.view.fit(false); app.frame();
      await new Promise(requestAnimationFrame);
      const overlap = document.querySelector('#tools').getBoundingClientRect().right > document.querySelector('#actions').getBoundingClientRect().left;
      return { annotationMs, zoom100Ms, objects: app.doc.objects.length, overlap,
        document: [app.doc.width, app.doc.height], viewport: [app.view.w, app.view.h], zoom: app.view.zoom };
    })()`);
    assert.equal(interaction.objects, 3);
    assert.deepEqual(interaction.document, [width, height]);
    assert.equal(interaction.overlap, false, 'toolbar must not overlap output actions');
    const beforeExportMemory = await memory(win);
    const exportStart = performance.now();
    const saved = await win.webContents.executeJavaScript('window.__editor.output.save({ format: "png" })');
    const exportMs = round(performance.now() - exportStart);
    assert(saved, 'PNG export must succeed');
    assert.deepEqual(nativeImage.createFromPath(saved).getSize(), { width, height });
    const exported = path.join(output, `annotated-${width}x${height}.png`);
    fs.copyFileSync(saved, exported);
    const exportMiB = round(fs.statSync(saved).size / 1024 ** 2);
    await wait(100);
    const screenshot = await win.webContents.capturePage();
    assert(!screenshot.isEmpty(), 'hidden window screenshot must contain the rendered UI');
    const screenshotFile = path.join(output, `editor-${width}x${height}-fit.png`);
    fs.writeFileSync(screenshotFile, screenshot.toPNG());
    const afterExportMemory = await memory(win);
    assert.equal(errors.length, 0, errors.join('\n'));
    const result = { width, height, openMs, exportMs, exportMiB,
      annotationMs: round(interaction.annotationMs), zoom100Ms: round(interaction.zoom100Ms),
      viewport: interaction.viewport, zoom: interaction.zoom, beforeExportMemory, afterExportMemory,
      screenshot: screenshotFile, exported, consoleErrors: errors };
    results.samples.push(result); console.log(JSON.stringify(result));
  } finally { win.destroy(); }
}

const deadline = setTimeout(() => { console.error('Editor benchmark timed out'); finish(1); }, 120000);
app.whenReady().then(async () => {
  app.dock?.hide(); app.focus = () => {};
  ctx = require('../../src/main/context');
  ctx.applyLang(); ctx.notify = () => {};
  const create = ctx.createWindow;
  ctx.createWindow = (kind, options) => {
    const win = create(kind, { ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    win.show = win.showInactive = win.focus = () => {};
    return win;
  };
  ctx.settings.set({ language: 'ru', saveFolder: path.join(tmp, 'exports'), library: { enabled: false }, editor: { backdrop: { enabled: false } } });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  protocol.handle({ appRoot: root, userData: ctx.paths.userData });
  ctx.modules = { basics: require('../../src/main/basics'), editor: require('../../src/main/editor'),
    library: require('../../src/main/library'), ocr: require('../../src/main/ocr') };
  for (const module of Object.values(ctx.modules)) module.register();
  for (const [width, height] of [[1920, 1080], [3840, 2160]]) await sample(width, height);
  fs.writeFileSync(path.join(output, 'editor-benchmark.json'), JSON.stringify(results, null, 2) + '\n');
  await ctx.modules.library.flush();
}).then(() => finish(0), (error) => { console.error(error); finish(1); });

function finish(code) {
  clearTimeout(deadline);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
