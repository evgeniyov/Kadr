'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createRequire } = require('module');
const atomic = require('../src/main/atomic-file');

function harness(t, writeFileAtomic = atomic.writeFileAtomic) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.resolve(__dirname, '../src/main/basics.js');
  const localRequire = createRequire(file), module = { exports: {} };
  const ctx = { settings: { get: () => ({ saveFolder: dir, fileNameTemplate: 'same-second' }) },
    formatFileName: (s) => s, uniquePath(folder, base, ext) {
      let dest = path.join(folder, `${base}.${ext}`), n = 2;
      while (fs.existsSync(dest)) dest = path.join(folder, `${base} (${n++}).${ext}`);
      return dest;
    } };
  const mocks = { electron: {}, './clip': {}, './context': ctx, './atomic-file': { writeFileAtomic } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Buffer, console,
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id) }, { filename: file });
  return { dir, save: module.exports.saveBytes };
}

test('simultaneous automatic saves with the same name preserve every image', async (t) => {
  const { dir, save } = harness(t);
  fs.writeFileSync(path.join(dir, 'same-second.png'), 'existing');
  const values = ['first', 'second', 'third'];
  const files = await Promise.all(values.map((s) => save({ data: Buffer.from(s) })));
  assert.equal(new Set(files).size, values.length);
  assert.equal(fs.readFileSync(path.join(dir, 'same-second.png'), 'utf8'), 'existing');
  files.forEach((file, i) => assert.equal(fs.readFileSync(file, 'utf8'), values[i]));
  assert.equal(fs.readdirSync(dir).length, 4);
});

test('an automatic save failure does not block the next save or leave temporary files', async (t) => {
  let writes = 0;
  const { dir, save } = harness(t, async (...args) => {
    if (++writes === 1) throw new Error('synthetic disk error');
    return atomic.writeFileAtomic(...args);
  });
  const failed = assert.rejects(save({ data: Buffer.from('failed') }), /synthetic disk error/);
  const saved = save({ data: Buffer.from('kept') });
  await failed;
  assert.equal(fs.readFileSync(await saved, 'utf8'), 'kept');
  assert.deepEqual(fs.readdirSync(dir), ['same-second.png']);
});
