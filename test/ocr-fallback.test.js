'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
test('mac packaging retains offline OCR worker, WASM core and bundled ru/en models', () => {
  const { build } = require('../package.json');
  assert(!build.mac.files.some((p) => p.startsWith('!') && p.includes('tesseract')));
  assert(build.mac.files.includes('src/**/*'), 'mac files override must retain a positive source allowlist');
  assert(build.mac.files.includes('package.json'));
  assert(!build.mac.files.includes('**/*'), 'previous releases and caches must not enter the archive');
  assert(build.mac.extraResources.some((r) => r.from === 'resources/tessdata' && r.to === 'tessdata'));
  for (const lang of ['rus', 'eng']) assert(fs.statSync(path.join(root, 'resources/tessdata', `${lang}.traineddata.gz`)).size > 100000);
  for (const pkg of ['tesseract.js', 'tesseract.js-core']) assert(build.asarUnpack.includes(`node_modules/${pkg}/**`));
});
test('system OCR reader failure falls back offline and avoids immediately repeating the failing model', async () => {
  let nativeCalls = 0, workerCalls = 0, workerOptions;
  const ctx = { paths: { resources: '/synthetic/resources', userData: '/synthetic/data' }, modules: { native: { capabilities: () => ({ ocr: true, barcodes: true }), ocr: async () => { nativeCalls++; throw new Error('TextRecognition.CRImageReaderError 1'); }, barcodes: async () => [] } } };
  const worker = { recognize: async () => { workerCalls++; return { data: { blocks: [{ paragraphs: [{ lines: [{ text: 'Hello world.\n', confidence: 99, bbox: { x0: 1, y0: 2, x1: 51, y1: 12 } }] }] }] } }; }, terminate: async () => {} };
  const mocks = { path, electron: { nativeImage: {} }, './context': ctx, './basics': { toBuffer: (b) => b }, 'tesseract.js': { createWorker: async (languages, oem, opts) => { assert.deepEqual(Array.from(languages), ['rus', 'eng']); workerOptions = opts; return worker; } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/main/ocr.js'), 'utf8'), { module, exports: module.exports, require: (id) => { if (!(id in mocks)) throw new Error(id); return mocks[id]; }, console: { warn() {}, error() {} }, Date, Uint8ClampedArray, setTimeout: () => ({}), clearTimeout() {} });
  for (let i = 0; i < 2; i++) { const res = await module.exports.recognize(Buffer.from('synthetic')); assert.equal(res.text, 'Hello world.'); assert.equal(res.engine, 'tesseract'); }
  assert.equal(nativeCalls, 1); assert.equal(workerCalls, 2);
  assert.equal(workerOptions.langPath, path.join(ctx.paths.resources, 'tessdata'));
});
test('editor can query native capabilities through the restricted IPC policy', () => {
  assert(require('../src/main/ipc-policy.json').editor.invoke.includes('native:capabilities'));
});
