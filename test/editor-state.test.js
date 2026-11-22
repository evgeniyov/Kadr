'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (file) => fs.readFileSync(path.join(__dirname, '../src/renderer/editor', file), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
const rectKey = (o) => `${o.x},${o.y},${o.w},${o.h}`;

function appHarness() {
  const App = vm.runInNewContext(source('app.js') + ';App;', {
    EventTarget, OBJECT_TOOLS: [], console, rectKey, t: (key) => key, toast() {},
  });
  const app = Object.create(App.prototype);
  Object.assign(app, { backdrop: { enabled: false }, backdropVersion: 0, _dirty: false,
    emit() {}, invalidate() {}, persistBackdrop() {}, renderer: { unfreeze() {} }, ocrInFlight: new Map() });
  return app;
}

test('changing only the backdrop marks an opened image as unsaved', () => {
  const app = appHarness();
  app.setBackdrop({ enabled: true });
  assert.equal(app.dirty, true);
});

test('an unchanged backdrop patch does not create unsaved changes', () => {
  const app = appHarness();
  app.setBackdrop({ enabled: false });
  assert.equal(app.dirty, false);
  assert.equal(app.backdropVersion, 0);
});

test('typing marks a document dirty before the textarea loses focus', () => {
  const handlers = new Map();
  const TextEditor = vm.runInNewContext(source('ui/text-editor.js') + ';TextEditor;');
  const app = { dirty: false, doc: { changed() {} }, on() {} };
  const editor = new TextEditor(app, { addEventListener: (name, fn) => handlers.set(name, fn), value: 'changed text' });
  editor.obj = { text: 'old text' };
  editor.position = () => {};
  handlers.get('input')();
  assert.equal(app.dirty, true);
  assert.equal(editor.obj.text, 'changed text');
});

for (const saveAs of [false, true]) test(`save shortcut works while typing${saveAs ? ' with Save As' : ''}`, () => {
  const handlers = new Map(), saved = [];
  let prevented = false;
  const TextEditor = vm.runInNewContext(source('ui/text-editor.js') + ';TextEditor;');
  new TextEditor({ on() {} }, { addEventListener: (name, fn) => handlers.set(name, fn) }, { save: (options) => saved.push(options.saveAs) });
  handlers.get('keydown')({ code: 'KeyS', key: 'ы', metaKey: true, shiftKey: saveAs,
    stopPropagation() {}, preventDefault() { prevented = true; } });
  assert.deepEqual(saved, [saveAs]);
  assert.equal(prevented, true);
});

function backgroundHarness(stage, fail = false) {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let replaces = 0, fallbacks = 0, commits = 0;
  const notices = [];
  const pause = async (at, value) => {
    if (stage === at) { entered(); await gate; if (fail) throw new Error('synthetic failure'); }
    return value;
  };
  const Output = vm.runInNewContext(source('output.js') + ';Output;', {
    console: { warn() {} }, t: (key) => key, toast: (key) => notices.push(key),
    canvasToBytes: () => pause('encode', new Uint8Array([1])),
    kadr: { invoke: () => pause('native', new Uint8Array([2])) },
    bytesToObjectUrl: () => 'blob:synthetic', URL: { revokeObjectURL() {} },
    loadBitmap: () => pause('decode', { width: 10, height: 10 }),
    makeCanvas: (width, height) => ({ width, height, getContext: () => ({ drawImage() {} }) }),
  });
  const app = { doc: { version: 0, width: 10, height: 10, base: {}, setBase() { replaces++; this.version++; } },
    caps: { removeBackground: true }, textEditor: { commit() {} }, commit() { commits++; } };
  const output = new Output(app);
  output.removeUniformBackground = () => { fallbacks++; };
  return { app, output, started, release, notices, stats: () => ({ replaces, fallbacks, commits }) };
}

for (const stage of ['encode', 'native', 'decode']) test(`background removal preserves newer edits during ${stage}`, async () => {
  const h = backgroundHarness(stage);
  const task = h.output.removeBackground();
  await h.started;
  h.app.doc.version++;
  h.release(); await task;
  assert.deepEqual(h.stats(), { replaces: 0, fallbacks: 0, commits: 0 });
});

test('failed old background removal cannot start a fallback on a newer document', async () => {
  const h = backgroundHarness('native', true);
  const task = h.output.removeBackground();
  await h.started;
  h.app.doc.version++;
  h.release(); await task;
  assert.deepEqual(h.stats(), { replaces: 0, fallbacks: 0, commits: 0 });
});

test('background removal still applies an unchanged result and keeps native failure fallback', async () => {
  const h = backgroundHarness('unused');
  await h.output.removeBackground();
  assert.deepEqual(h.stats(), { replaces: 1, fallbacks: 0, commits: 1 });
  const failure = backgroundHarness('native', true);
  const task = failure.output.removeBackground();
  await failure.started; failure.release(); await task;
  assert.deepEqual(failure.stats(), { replaces: 0, fallbacks: 1, commits: 0 });
});

test('conceal OCR ignores text locations from the previous base image', async () => {
  const app = appHarness();
  const object = { id: 'conceal', type: 'conceal', textOnly: true, x: 0, y: 0, w: 10, h: 10 };
  let release, changes = 0;
  app.doc = { baseVersion: 1, get: () => object, changed: () => { changes++; } };
  app.history = { amend() {} };
  app.ocrRegion = () => new Promise((resolve) => { release = resolve; });
  const task = app.ensureConcealOcr(object);
  app.doc.baseVersion++;
  release({ rect: { x: 0, y: 0 }, lines: [{ box: { x: 1, y: 1, width: 5, height: 5 } }] });
  await task;
  assert.equal(changes, 0);
  assert.equal(object.boxes, undefined);
});

test('conceal OCR for a newer base may start before the old request finishes', async () => {
  const app = appHarness();
  const object = { id: 'conceal', type: 'conceal', textOnly: true, x: 0, y: 0, w: 10, h: 10 };
  const pending = [];
  app.doc = { baseVersion: 1, get: () => object, changed() {} };
  app.history = { amend() {} };
  app.ocrRegion = () => new Promise((resolve) => pending.push(resolve));
  const old = app.ensureConcealOcr(object);
  app.doc.baseVersion++;
  const current = app.ensureConcealOcr(object);
  assert.equal(pending.length, 2);
  const result = (x) => ({ rect: { x: 0, y: 0 }, lines: [{ box: { x, y: 1, width: 1, height: 1 } }] });
  pending[0](result(1)); await old;
  assert.equal(app.ocrInFlight.size, 1);
  pending[1](result(5)); await current;
  assert.equal(object.boxes[0].x, 5);
  assert.equal(app.ocrInFlight.size, 0);
  assert.equal(app.dirty, true, 'a late OCR result changes the rendered image even if it was saved while OCR was running');
});

test('a result for an object removed by undo cannot amend its restored replacement', async () => {
  const app = appHarness();
  const object = { id: 'conceal', type: 'conceal', textOnly: true, x: 0, y: 0, w: 10, h: 10 };
  let current = object, release, amendments = 0;
  app.doc = { baseVersion: 1, get: () => current, changed() {} };
  app.history = { amend() { amendments++; } };
  app.ocrRegion = () => new Promise((resolve) => { release = resolve; });
  const task = app.ensureConcealOcr(object);
  current = { ...object };
  release({ rect: { x: 0, y: 0 }, lines: [] }); await task;
  assert.equal(amendments, 0);
  assert.equal(current.boxes, undefined);
});

function documentHarness() {
  const geometry = vm.runInNewContext(source('geom.js') + ';({ mapRect, rectKey });');
  const api = vm.runInNewContext(source('doc.js') + ';({ Doc, History });', {
    EventTarget, CustomEvent, structuredClone, performance, ...geometry,
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    typeOf: () => ({ translate(o, dx, dy) { o.x += dx; o.y += dy; } }),
  });
  const doc = new api.Doc({ width: 20, height: 20 });
  const object = { id: 'conceal', type: 'conceal', textOnly: true, x: 4, y: 4, w: 10, h: 10,
    boxes: [{ x: 5, y: 6, w: 3, h: 2 }] };
  object.ocrKey = geometry.rectKey(object);
  doc.add(object);
  return { doc, object, api, geometry };
}

test('pixel replacement invalidates conceal boxes and undo restores the original text locations', () => {
  const { doc, object, api, geometry } = documentHarness();
  const history = new api.History(doc);
  doc.setBase({ width: 20, height: 20 });
  history.commit();
  assert.equal(object.boxes, null);
  assert.equal(object.ocrKey, '');
  history.undo();
  assert.equal(doc.objects[0].boxes[0].x, 5);
  assert.equal(doc.objects[0].ocrKey, geometry.rectKey(doc.objects[0]));
});

test('cropping retains and translates valid conceal text locations', () => {
  const { doc, object, geometry } = documentHarness();
  doc.crop({ x: 2, y: 3, w: 15, h: 15 });
  assert.equal(object.boxes[0].x, 3);
  assert.equal(object.boxes[0].y, 3);
  assert.equal(object.ocrKey, geometry.rectKey(object));
});
