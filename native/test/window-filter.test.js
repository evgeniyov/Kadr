'use strict';
// listWindows/activeWindow filtering and ordering, driven by a fake helper that speaks the
// kadr-helper protocol (macOS code path; runs anywhere a `#!/usr/bin/env node` script can).
//
//   node native/test/window-filter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skip = process.platform !== 'darwin' && 'exercises the macOS backend';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-fake-helper-'));
const fake = path.join(tmp, 'fake-helper');

const me = process.pid;
const W = (id, pid, extra = {}) => ({
  id,
  pid,
  appName: `app${pid}`,
  title: `w${id}`,
  bounds: { x: 100, y: 100, width: 400, height: 300 },
  layer: 0,
  alpha: 1,
  ...extra,
});
const windows = [
  W(1, me), // Kadr's own window (front-most)
  W(2, 500, { bounds: { x: 0, y: -80, width: 1710, height: 40 } }), // parked above the screen
  W(3, 501, { alpha: 0 }), // fully transparent
  W(4, 502, { bounds: { x: 10, y: 10, width: 20, height: 300 } }), // too narrow
  W(5, 503, { appName: 'Dock' }),
  W(6, 504, { layer: 3 }), // floating level (only with allLayers)
  W(7, 505, { title: 'first real' }),
  W(8, 506, { title: 'frontmost app', bounds: { x: 1800, y: 50, width: 400, height: 300 } }), // 2nd display
  W(9, 505, { title: 'second of 505' }),
];
const script = `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
const reply = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const { id, cmd } = JSON.parse(line);
  if (cmd === 'hello') return reply({ id, ok: true, result: { version: 'fake', capabilities: { windowList: true, ocr: true } } });
  if (cmd === 'windows') return reply({ id, ok: true, result: {
    windows: ${JSON.stringify(windows)},
    displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1710, height: 1112 } }, { id: 2, bounds: { x: 1710, y: 0, width: 1920, height: 1080 } }],
    frontmostPid: Number(process.env.FAKE_FRONT || 0),
  } });
  reply({ id, ok: false, error: 'unsupported', code: 'UNSUPPORTED' });
});
rl.on('close', () => process.exit(0));
`;
fs.writeFileSync(fake, script, { mode: 0o755 });
process.env.KADR_HELPER_PATH = fake;

const native = require(path.join(__dirname, '..', '..', 'src', 'main', 'native'));

test.after(() => {
  native.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('filters own, off-screen, transparent, tiny, system and non-normal windows; keeps order', { skip }, async () => {
  const caps = await native.init();
  assert.equal(caps.windowList, true);
  assert.equal(caps.captureWindow, false, 'refined by the helper hello');
  const list = await native.listWindows();
  assert.deepEqual(
    list.map((w) => w.id),
    [7, 8, 9],
  );
  assert.deepEqual(Object.keys(list[0]).sort(), ['appName', 'bounds', 'id', 'layer', 'pid', 'title']);
});

test('activeWindow: frontmost app window, else first non-Kadr window', { skip }, async () => {
  // FAKE_FRONT is read by the helper at reply time; the helper inherited our env at spawn,
  // so restart it with the variable set.
  native.shutdown();
  process.env.FAKE_FRONT = '506';
  assert.equal((await native.activeWindow()).id, 8);
  native.shutdown();
  process.env.FAKE_FRONT = String(me); // Kadr itself is frontmost -> first other window
  assert.equal((await native.activeWindow()).id, 7);
});

test('unsupported features reject with code UNSUPPORTED', { skip }, async () => {
  await assert.rejects(native.captureWindow(7), (e) => e.code === 'UNSUPPORTED' && e.message === 'unsupported');
  await assert.rejects(native.ocr(Buffer.from('x')), { code: 'UNSUPPORTED' }); // helper said so at runtime
});
