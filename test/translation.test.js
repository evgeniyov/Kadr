'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
function imageHarness(responses) {
  const objects = [], notices = []; let ocrCalls = 0, calls = 0;
  const context = { console, Float32Array, t: (key) => key, toast: (msg) => notices.push(msg), measure: (text, size) => text.length * size * .5, LINE_HEIGHT: 1.2, dominantBorderColor: () => '#ffffff', kadr: { invoke: async (channel) => { assert.equal(channel, 'native:translate-list'); return responses[Math.min(calls++, responses.length - 1)]; } } };
  const api = vm.runInNewContext(source('src/renderer/editor/translate-image.js') + ';({ translateImage, parseColor });', context);
  const app = { ocrRegion: async () => { ocrCalls++; return { rect: { x: 0, y: 0 }, lines: [{ text: 'Hello world.', box: { x: 20, y: 20, width: 180, height: 30 } }] }; }, doc: { base: { width: 500, height: 200, getContext: () => ({ getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) }) }, scale: 1, add: (o) => objects.push(o), changed() {} }, newObject: (type, x, y, props) => ({ type, x, y, ...props }), select() {}, commit() {} };
  return { api, app, objects, notices, stats: () => ({ ocrCalls, calls }) };
}
test('image translation resumes after explicit language preparation without another OCR pass', async () => {
  const h = imageHarness([{ error: 'not-installed', from: 'en', to: 'ru' }, { texts: ['Привет, мир.'], from: 'en', to: 'ru' }]);
  let preparations = 0;
  await h.api.translateImage(h.app, { onNeedLanguages: async () => { preparations++; return true; } });
  assert.equal(preparations, 1); assert.equal(h.stats().calls, 2); assert.equal(h.stats().ocrCalls, 1);
  assert(h.objects.some((o) => o.type === 'text' && o.text === 'Привет, мир.'));
});
test('cancelled language preparation never retries translation or mutates the image', async () => {
  const h = imageHarness([{ error: 'not-installed' }]);
  await h.api.translateImage(h.app, { onNeedLanguages: async () => false }); assert.equal(h.stats().calls, 1); assert.equal(h.objects.length, 0);
});
test('still-missing language models stop after one retry with an actionable error', async () => {
  const h = imageHarness([{ error: 'not-installed' }]);
  await h.api.translateImage(h.app, { onNeedLanguages: async () => true }); assert.equal(h.stats().calls, 2); assert(h.notices.includes('editor.ocr.setupFailed')); assert.equal(h.objects.length, 0);
});
test('hex colors containing zero channels keep black and saturated colors intact', () => {
  const { api } = imageHarness([]);
  assert.deepEqual(Array.from(api.parseColor('#000000')), [0, 0, 0]); assert.deepEqual(Array.from(api.parseColor('#ff0000')), [255, 0, 0]);
});
test('screen translation with missing models opens explicit setup without starting a download', async () => {
  let prepared = 0, settings = 0;
  const code = source('src/main/capture.js'); const start = code.indexOf('async function copyTranslation('); const end = code.indexOf('// Small centered countdown', start);
  const run = vm.runInNewContext(code.slice(start, end) + ';copyTranslation;', { ctx: { t: (k) => k, notify() {}, modules: { translate: { translateText: async () => ({ error: 'not-installed' }), prepare: async () => { prepared++; } }, settingsWindow: { open: (tab) => { assert.equal(tab, 'capture'); settings++; } } } }, clip: { writeText: async () => {} } });
  await run('Synthetic text'); assert.equal(prepared, 0); assert.equal(settings, 1);
});
test('a delayed translation-status response cannot replace a newer settings tab', async () => {
  const code = source('src/renderer/settings/index.js'); const a = code.indexOf('async function renderTab(id)'); const b = code.indexOf('const { params }', a); let finish, content;
  const render = vm.runInNewContext("let currentTab = 'general'; let renderGeneration = 0;" + code.slice(a, b) + ';renderTab;', { TABS: { capture: () => new Promise((r) => { finish = r; }), about: async () => ['about'] }, renderNav() {}, t: (k) => k, document: {}, $: (selector) => selector === '#content' ? { replaceChildren: (...nodes) => { content = nodes; } } : {} });
  const old = render('capture'); await render('about'); finish(['capture']); await old; assert.deepEqual(content, ['about']);
});
test('failed preparation re-enables the popover download button and reports the failure', async () => {
  let download, failed = false;
  const code = source('src/renderer/editor/ui/dialogs.js'); const a = code.indexOf('async function runTranslation('); const b = code.indexOf('// Resize dialog:', a);
  const el = (tag, attrs, ...children) => { const node = { tag, attrs, children, disabled: false, addEventListener() {} }; if (attrs?.onclick && tag === 'button.btn.primary') download = node; return node; };
  const run = vm.runInNewContext(code.slice(a, b) + ';runTranslation;', { console: { warn() {} }, el, t: (k) => k, toast: (k) => { if (k === 'editor.ocr.setupFailed') failed = true; }, kadr: { invoke: async (channel) => { if (channel === 'native:translate') return { error: 'not-installed' }; throw new Error('synthetic setup error'); } } });
  await run('Synthetic text', { classList: { remove() {} }, replaceChildren() {} }, {});
  await download.attrs.onclick({ currentTarget: download, target: {} }); assert.equal(download.disabled, false); assert.equal(failed, true);
});
for (const stage of ['ocr', 'translation', 'language setup']) test(`image translation ignores results if document changes during ${stage}`, async () => {
  let release, entered;
  const started = new Promise((r) => { entered = r; });
  const gate = new Promise((r) => { release = r; });
  const translated = { texts: ['Привет, мир.'], from: 'en', to: 'ru' };
  const h = imageHarness(stage === 'language setup' ? [{ error: 'not-installed' }, translated] : [stage === 'translation' ? gate : translated]);
  h.app.doc.version = 0;
  if (stage === 'ocr') {
    const original = h.app.ocrRegion;
    h.app.ocrRegion = async () => { entered(); await gate; return original(); };
  }
  const run = h.api.translateImage(h.app, { onNeedLanguages: () => { entered(); return gate; } });
  if (stage === 'translation') await new Promise(setImmediate);
  else await started;
  h.app.doc.version++;
  release(stage === 'translation' ? translated : true);
  await run;
  assert.equal(h.objects.length, 0);
  assert(h.notices.includes('editor.trImg.changed'));
  if (stage === 'ocr') assert.equal(h.stats().calls, 0);
  if (stage === 'language setup') assert.equal(h.stats().calls, 1);
});
