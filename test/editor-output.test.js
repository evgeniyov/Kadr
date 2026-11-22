'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const withoutImports = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
function outputHarness({ encode, invoke = async () => '/tmp/synthetic.png', meta = {}, makeCanvas = (width, height) => ({ width, height }) } = {}) {
  const app = { doc: { version: 0 }, backdropVersion: 0, backdrop: {}, dirty: true, params: { meta }, textEditor: { commit() {} }, renderer: { bgImage: null, layout: () => ({ width: 10, height: 10 }), render: (canvas) => { canvas.revision = app.doc.version; } } };
  const Output = vm.runInNewContext(withoutImports('src/renderer/editor/output.js') + '\nOutput;', { console, Buffer, Uint8Array, kadr: { invoke }, t: (x) => x, toast: () => {}, getSettings: () => ({ imageFormat: 'jpg' }), makeCanvas, canvasToBytes: encode || (async (c, fmt) => Buffer.from(`${fmt}:${c.revision}`)) });
  return { app, output: new Output(app) };
}
test('failed image load shows an error and never creates an editable blank document', async () => {
  let bootstraps = 0, canvases = 0, errorUi;
  const kadrCalls = [];
  const run = vm.runInNewContext(`(async () => { ${withoutImports('src/renderer/editor/index.js')} })`, {
    console: { error() {} }, initPage: async () => ({ params: { imageUrl: 'synthetic-broken', meta: { filePath: '/tmp/original.png' } }, settings: {} }),
    $: (selector) => selector === '#app' ? { replaceChildren: (...nodes) => { errorUi = nodes; } } : {},
    el: (...args) => args, t: (x) => x, kadr: { invoke: async (channel) => { kadrCalls.push(channel); } },
    loadBitmap: async () => { throw new Error('synthetic decode error'); },
    makeCanvas: () => { canvases++; throw new Error('a blank replacement must not be created'); },
    App: class { constructor() { bootstraps++; } },
  });
  await run(); assert.equal(bootstraps, 0); assert.equal(canvases, 0); assert(errorUi); assert.deepEqual(kadrCalls, ['editor:ready']);
});
test('text editing is committed before an encoded-image cache lookup', async () => {
  const h = outputHarness(); await h.output.bytes();
  let pending = true;
  h.app.textEditor.commit = () => { if (pending) { pending = false; h.app.doc.version++; } };
  assert.equal((await h.output.bytes()).toString(), 'png:1');
});
test('simultaneous requests share one encoding and completion does not interrupt new text editing', async () => {
  let encodes = 0, resolve, commits = 0;
  const h = outputHarness({ encode: () => { encodes++; return new Promise((r) => { resolve = r; }); } });
  const a = h.output.bytes(), b = h.output.bytes(); assert.equal(encodes, 1);
  h.app.textEditor.commit = () => { commits++; };
  resolve(Buffer.from('synthetic')); await Promise.all([a, b]); assert.equal(commits, 0);
});
test('saving while newer edits arrive keeps the document dirty and uses one canvas for file and library', async () => {
  const sent = []; let h;
  h = outputHarness({ meta: { libraryId: 'fixture' }, invoke: async (channel, data) => {
    sent.push([channel, data]);
    if (channel === 'image:save') { h.app.doc.version++; return '/tmp/synthetic.jpg'; }
  } });
  assert.equal(await h.output.save(), '/tmp/synthetic.jpg'); assert.equal(h.app.dirty, true);
  const stored = sent.find(([channel]) => channel === 'library:update-image')[1].data;
  assert.equal(stored.toString(), 'png:0');
  assert.equal(sent.find(([channel]) => channel === 'image:save')[1].data.toString(), 'jpg:0');
});
test('copying a snapshot does not close or mark newer edits as saved', async () => {
  let h; h = outputHarness({ invoke: async (channel) => { if (channel === 'clipboard:write-image') h.app.doc.version++; } });
  assert.equal(await h.output.copy(), false); assert.equal(h.app.dirty, true);
});

test('a web clipboard fallback still sends the next manual copy through main', async () => {
  const writes = [];
  const writeClipboardImage = vm.runInNewContext(withoutImports('src/renderer/editor/output.js') + '\nwriteClipboardImage;', {
    Blob, ClipboardItem: class {}, console: { warn() {} },
    kadr: { async invoke(channel) {
      assert.equal(channel, 'clipboard:write-image');
      writes.push('main');
      if (writes.length === 1) throw new Error('clipboard unavailable');
    } },
    navigator: { clipboard: { async write() { writes.push('web'); } } },
  });
  await writeClipboardImage(Buffer.from('first'));
  await writeClipboardImage(Buffer.from('second'));
  assert.deepEqual(writes, ['main', 'web', 'main']);
});
test('overlapping saves finish in request order so an older snapshot cannot overwrite a newer one', async () => {
  const writes = []; let entered, finish;
  const started = new Promise((r) => { entered = r; }); const release = new Promise((r) => { finish = r; });
  const h = outputHarness({ invoke: async (channel, data) => {
    if (channel !== 'image:save') return;
    if (data.data.toString() === 'jpg:0') { entered(); await release; }
    writes.push(data.data.toString()); return '/tmp/synthetic.jpg';
  } });
  const first = h.output.save(); await started;
  h.app.doc.version++; h.app.dirty = true;
  const second = h.output.save(); await new Promise(setImmediate); finish();
  await Promise.all([first, second]); assert.deepEqual(writes, ['jpg:0', 'jpg:1']); assert.equal(h.app.dirty, false);
});

test('a delayed copy cannot overwrite the library image stored by a newer save', async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const libraryWrites = [];
  const h = outputHarness({ meta: { libraryId: 'fixture' },
    encode: async (canvas, format) => {
      if (format === 'png' && canvas.revision === 0) { entered(); await gate; }
      return Buffer.from(`${format}:${canvas.revision}`);
    },
    invoke: async (channel, data) => {
      if (channel === 'library:update-image') libraryWrites.push(data.data.toString());
      if (channel === 'image:save') return '/tmp/synthetic.jpg';
    },
  });
  const copying = h.output.copy(); await started;
  h.app.doc.version++;
  const saving = h.output.save(); await new Promise(setImmediate);
  release(); await Promise.all([copying, saving]);
  assert.deepEqual(libraryWrites, ['png:0', 'png:1']);
});

test('GIF before and after frames use the same revision even if edits arrive during encoding', async () => {
  let h, first = true;
  const frames = [];
  h = outputHarness({ encode: async (canvas) => {
    if (first) { first = false; await new Promise(setImmediate); h.app.doc.version++; }
    return Buffer.from(`png:${canvas.revision}`);
  }, invoke: async (channel, data) => {
    if (channel === 'editor:export-gif') { frames.push(...data.frames.map((frame) => frame.toString())); return Buffer.from('gif'); }
    return '/tmp/synthetic.gif';
  } });
  await h.output.exportGif();
  assert.deepEqual(frames, ['png:0', 'png:0']);
});

test('GIF keeps concealment in both frames and shows other annotations only in the after frame', async () => {
  function makeCanvas(width, height) {
    const canvas = { width, height, pixels: [] };
    const ctx = {
      setTransform() {}, save() {}, restore() {},
      clearRect() { canvas.pixels = []; },
      drawImage(source) { canvas.pixels = [...source.pixels]; },
      fillRect(x, _y, _width, _height) { canvas.pixels[x] = this.fillStyle; },
    };
    return Object.assign(canvas, { getContext: () => ctx });
  }
  const { conceal } = await import('../src/renderer/editor/objects/effects.js');
  const drawMark = { draw(ctx) { ctx.fillStyle = 'annotation'; ctx.fillRect(1, 0, 1, 1); } };
  const Renderer = vm.runInNewContext(withoutImports('src/renderer/editor/render.js') + '\nRenderer;', {
    console, makeCanvas, typeOf: (object) => object.type === 'conceal' ? conceal : drawMark,
  });
  let frames;
  const { app, output } = outputHarness({
    makeCanvas,
    encode: async (canvas) => canvas.pixels,
    invoke: async (channel, data) => {
      if (channel === 'editor:export-gif') frames = [...data.frames];
      return '/tmp/synthetic.gif';
    },
  });
  Object.assign(app.doc, {
    width: 2, height: 1, baseVersion: 1, base: { pixels: ['secret', 'background'] },
    objects: [{ type: 'conceal', mode: 'erase', x: 0, y: 0, w: 1, h: 1 }, { type: 'text' }],
  });
  app.renderer = new Renderer(app.doc);
  app.renderer.cache.set('erase:0,0,1,1:1', 'covered');
  await output.exportGif();
  assert.deepEqual(frames, [['covered', 'background'], ['covered', 'annotation']]);
});
