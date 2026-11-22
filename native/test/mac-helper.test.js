'use strict';
// Integration test of src/main/native (index.js + the built Swift helper) under plain Node
// on macOS. Build first: `bash native/mac/build.sh`.
//
//   node native/test/mac-helper.test.js
//
// Never triggers permission prompts: capture/audio run only when Screen Recording is
// already granted (CGPreflightScreenCaptureAccess), scroll only checks the NO_ACCESS path
// unless KADR_TEST_SCROLL=1. Set KADR_TEST_SKIP_CAPTURE=1 to skip screen/audio capture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const fixtures = path.join(__dirname, 'fixtures');
const native = require(path.join(root, 'src', 'main', 'native'));

const skip = process.platform !== 'darwin' && 'macOS only';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadr-native-test-'));
let perms = { screen: false, accessibility: false };

test.after(() => {
  native.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('capabilities are known before init', { skip }, () => {
  const caps = native.capabilities();
  for (const k of ['windowList', 'captureWindow', 'captureDisplays', 'scroll', 'ocr', 'barcodes', 'removeBackground', 'systemAudio']) {
    assert.equal(typeof caps[k], 'boolean', k);
  }
  assert.equal(caps.ocr, true, 'helper binary present (run native/mac/build.sh)');
});

test('init starts the helper and is idempotent', { skip }, async () => {
  const [a, b] = await Promise.all([native.init(), native.init()]);
  assert.deepEqual(a, b);
  assert.deepEqual(native.capabilities(), a);
  perms = await native.permissions();
  assert.equal(typeof perms.screen, 'boolean');
  assert.equal(typeof perms.accessibility, 'boolean');
});

test('listWindows / activeWindow', { skip }, async () => {
  const list = await native.listWindows();
  assert.ok(Array.isArray(list));
  for (const w of list) {
    assert.equal(typeof w.id, 'number');
    assert.notEqual(w.pid, process.pid);
    assert.equal(w.layer, 0);
    assert.ok(w.bounds.width >= 24 && w.bounds.height >= 24);
    assert.equal(typeof w.title, 'string');
  }
  const active = await native.activeWindow();
  assert.ok(active === null || list.some((w) => w.id === active.id));
});

test('ocr: Russian + English lines with pixel boxes', { skip }, async () => {
  const png = fs.readFileSync(path.join(fixtures, 'ocr-ru-en-qr.png'));
  const r = await native.ocr(png, { languages: ['ru', 'en'] });
  const texts = r.lines.map((l) => l.text);
  assert.ok(texts.includes('Привет, мир! Это тест распознавания.'), texts.join(' | '));
  assert.ok(texts.includes('Hello world, OCR test 12345.'), texts.join(' | '));
  const first = r.lines.find((l) => l.text.startsWith('Привет'));
  assert.ok(first.box.x > 20 && first.box.x < 40, `x=${first.box.x}`);
  assert.ok(first.box.y > 10 && first.box.y < 40, `y=${first.box.y} (top-left origin)`);
  assert.ok(first.confidence > 0.5);
  // tesseract-style codes and a file path are accepted too; fast + Cyrillic uses the accurate model
  const r2 = await native.ocr(path.join(fixtures, 'ocr-ru-en-qr.png'), { languages: 'rus+eng', fast: true });
  assert.ok(r2.lines.some((l) => l.text.startsWith('Съешь')));
});

test('barcodes: QR payload and box', { skip }, async () => {
  const codes = await native.barcodes(fs.readFileSync(path.join(fixtures, 'ocr-ru-en-qr.png')));
  assert.equal(codes.length, 1);
  assert.equal(codes[0].text, 'https://kadr.app/test?q=Привет');
  assert.equal(codes[0].symbology, 'QR');
  const b = codes[0].box;
  assert.ok(Math.abs(b.x - 35) <= 2 && Math.abs(b.y - 260) <= 2 && Math.abs(b.width - 145) <= 2, JSON.stringify(b));
});

test('removeBackground: PNG with transparent background', { skip }, async (t) => {
  if (!native.capabilities().removeBackground) return t.skip('needs macOS 14');
  const out = await native.removeBackground(fs.readFileSync(path.join(fixtures, 'subject.png')));
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out.readUInt32BE(16), 480);
  assert.equal(out.readUInt32BE(20), 360);
  assert.equal(out[25], 6, 'RGBA');
  await assert.rejects(native.removeBackground(fs.readFileSync(path.join(fixtures, 'ocr-ru-en-qr.png'))), {
    code: 'NO_SUBJECT',
  });
});

test('bad input is rejected cleanly', { skip }, async () => {
  await assert.rejects(native.ocr(Buffer.from('not a png')), { code: 'BAD_IMAGE' });
  await assert.rejects(native.ocr(Buffer.alloc(0)), { code: 'BAD_ARGS' });
  await assert.rejects(native.scroll({ x: 'a', y: 1, deltaY: 1 }), { code: 'BAD_ARGS' });
});

test('scroll', { skip }, async (t) => {
  if (!perms.accessibility) {
    await assert.rejects(native.scroll({ x: 10, y: 10, deltaY: 100 }), { code: 'NO_ACCESS' });
    return;
  }
  if (process.env.KADR_TEST_SCROLL !== '1') return t.skip('accessibility granted; set KADR_TEST_SCROLL=1 to post a real event');
  assert.equal(await native.scroll({ x: 10, y: 10, deltaY: 1 }), true);
});

const captureSkip = (t) => {
  if (process.env.KADR_TEST_SKIP_CAPTURE === '1') return t.skip('KADR_TEST_SKIP_CAPTURE=1'), true;
  if (!perms.screen) return t.skip('Screen Recording not granted (not prompting)'), true;
  if (!native.capabilities().captureWindow) return t.skip('needs macOS 14'), true;
  return false;
};

test('captureWindow / captureDisplays', { skip }, async (t) => {
  if (captureSkip(t)) return;
  const win = (await native.listWindows()).find((w) => w.bounds.width > 100 && w.bounds.height > 100);
  if (win) {
    const plain = await native.captureWindow(win.id, { shadow: false });
    assert.ok(plain && Buffer.isBuffer(plain.png) && plain.scale >= 1);
    const w = plain.png.readUInt32BE(16);
    assert.ok(Math.abs(w - win.bounds.width * plain.scale) <= 2, `png ${w}px vs window ${win.bounds.width}pt`);
    const shadowed = await native.captureWindow(win.id, { shadow: true });
    // Normal windows gain a shadow margin; full-screen windows have no shadow.
    assert.ok(shadowed.png.readUInt32BE(16) >= w, 'shadow never shrinks the image');
  }
  assert.equal(await native.captureWindow(1e9), null, 'unknown window -> null');
  for (let attempt = 0; attempt < 3; attempt++) {
    // An early hotkey or a display change can overlap preparation and a real capture.
    const [shots, prepared] = await Promise.all([
      native.captureDisplays({ cursor: false }),
      native.prepareCapture(),
    ]);
    try {
      assert.equal(prepared, true);
      assert.ok(shots?.length >= 1);
      for (const s of shots) {
        const png = fs.readFileSync(s.path);
        assert.equal(png.readUInt32BE(16), s.pixelWidth);
        assert.equal(png.readUInt32BE(20), s.pixelHeight);
        assert.ok(s.pixelWidth > 0 && s.pixelHeight > 0 && typeof s.displayId === 'number');
      }
    } finally {
      for (const s of shots || []) fs.rmSync(s.path, { force: true });
    }
  }
});

test('systemAudio start/pause/resume/stop', { skip }, async (t) => {
  if (captureSkip(t)) return;
  const out = path.join(tmp, 'system.m4a');
  const started = await native.systemAudio.start(out);
  assert.equal(started.path, out);
  await assert.rejects(native.systemAudio.start(path.join(tmp, 'x.m4a')), { code: 'BUSY' });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await native.systemAudio.pause(), true);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await native.systemAudio.resume(), true);
  await new Promise((r) => setTimeout(r, 1200));
  const r = await native.systemAudio.stop();
  assert.ok(r, 'audio captured');
  assert.equal(r.path, out);
  assert.ok(Math.abs(r.startedAt - started.startedAt) < 1000);
  // ~2.4 s recorded + command latency, the 1 s pause removed
  assert.ok(r.durationMs > 1800 && r.durationMs < 3300, `durationMs=${r.durationMs}`);
  assert.ok(fs.statSync(out).size > 500);
  assert.equal(await native.systemAudio.stop(), null, 'stop when idle -> null');
});

test('without Screen Recording permission capture/audio reject NO_ACCESS (simulated, no prompt)', { skip }, async (t) => {
  if (!native.capabilities().captureWindow) return t.skip('needs macOS 14');
  native.shutdown(); // the helper reads the switch at start
  process.env.KADR_HELPER_SIMULATE_NO_SCREEN_ACCESS = '1';
  try {
    assert.deepEqual((await native.permissions()).screen, false);
    await assert.rejects(native.captureWindow(1, { shadow: true }), { code: 'NO_ACCESS' });
    await assert.rejects(native.captureDisplays({ cursor: false }), { code: 'NO_ACCESS' });
    await assert.rejects(native.systemAudio.start(path.join(tmp, 'denied.m4a')), { code: 'NO_ACCESS' });
    assert.ok(Array.isArray(await native.listWindows()), 'window list still works (titles may be empty)');
  } finally {
    delete process.env.KADR_HELPER_SIMULATE_NO_SCREEN_ACCESS;
    native.shutdown();
  }
});

test('helper crash: in-flight requests fail, the next call restarts it', { skip }, async () => {
  const before = await native.permissions();
  const exited = new Promise((resolve) => {
    const onExit = (info) => {
      if (!info.crashed) return; // e.g. the previous test's graceful shutdown
      native.events.off('helper-exit', onExit);
      resolve(info);
    };
    native.events.on('helper-exit', onExit);
  });
  const { execFileSync } = require('child_process');
  const pid = Number(execFileSync('pgrep', ['-n', '-P', String(process.pid), 'kadr-helper']).toString().trim());
  assert.ok(pid > 0);
  process.kill(pid, 'SIGKILL');
  const info = await exited;
  assert.equal(info.crashed, true);
  assert.deepEqual(await native.permissions(), before, 'restarted after backoff');
});
