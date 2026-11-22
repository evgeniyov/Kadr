'use strict';
// Checks the Windows worker on any platform: requiring it has no side effects (no DLL is
// loaded), the koffi types have the Win64 layouts, every prototype parses, and the pure
// helpers (wheel notches, INPUT records, PNG encoding) behave.
//
//   node native/test/win-worker.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..', '..');
const koffi = require(path.join(root, 'node_modules', 'koffi'));

// Fail loudly if the worker tries to load any library at require time.
const realLoad = koffi.load;
let loads = 0;
koffi.load = (...args) => {
  loads++;
  return realLoad(...args);
};
const worker = require(path.join(root, 'src', 'main', 'native', 'win-worker.js'));
koffi.load = realLoad;

test('require has no side effects', () => {
  assert.equal(loads, 0);
  assert.equal(typeof worker.declareTypes, 'function');
});

test('struct layouts match the Win64 SDK', () => {
  const T = worker.declareTypes(koffi);
  assert.equal(worker.declareTypes(koffi), T, 'declareTypes is idempotent');
  assert.equal(koffi.sizeof(T.RECT), 16);
  assert.equal(koffi.sizeof(T.POINT), 8);
  assert.equal(koffi.sizeof(T.MOUSEINPUT), 32);
  assert.equal(koffi.offsetof(T.MOUSEINPUT, 'mouseData'), 8);
  assert.equal(koffi.offsetof(T.MOUSEINPUT, 'dwFlags'), 12);
  assert.equal(koffi.offsetof(T.MOUSEINPUT, 'dwExtraInfo'), 24);
  assert.equal(koffi.sizeof(T.KEYBDINPUT), 24);
  assert.equal(koffi.sizeof(T.HARDWAREINPUT), 8);
  assert.equal(koffi.sizeof(T.INPUT), 40, 'sizeof(INPUT) on x64/arm64 Windows');
  assert.equal(koffi.offsetof(T.INPUT, 'u'), 8);
  assert.equal(koffi.sizeof('HANDLE'), 8);
  assert.equal(koffi.sizeof('intptr_t'), 8);
});

test('every prototype parses (only the symbol lookup fails off Windows)', () => {
  worker.declareTypes(koffi);
  const self = realLoad(null); // the current process: parsing succeeds, symbols are missing
  const all = [...Object.values(worker.PROTOTYPES).flat(), ...Object.values(worker.OPTIONAL_PROTOTYPES).flat()];
  assert.ok(all.length >= 25);
  for (const proto of all) {
    assert.ok(proto.includes('__stdcall'), `${proto} must use __stdcall`);
    // Also parse it as a standalone prototype type.
    assert.doesNotThrow(() => koffi.proto(proto.replace(/(\w+)\s*\(/, '$1_T(')), proto);
    if (process.platform !== 'win32') {
      assert.throws(() => self.func(proto), /Cannot find function/, proto);
    }
  }
  assert.equal(worker.functionName(all[0]), 'EnumWindows');
});

test('INPUT records marshal to the expected bytes', () => {
  const T = worker.declareTypes(koffi);
  const inputs = worker.wheelInputs(240, -100);
  assert.equal(inputs.length, 3); // 2 notches down + 1 notch left
  const lib = realLoad(null);
  const memcpy = lib.func('void *memcpy(_Out_ void *dst, INPUT *src, size_t n)');
  const buf = Buffer.alloc(koffi.sizeof(T.INPUT) * inputs.length);
  memcpy(buf, inputs, buf.length);
  const rec = (i) => ({
    type: buf.readUInt32LE(i * 40),
    mouseData: buf.readInt32LE(i * 40 + 8 + 8),
    flags: buf.readUInt32LE(i * 40 + 8 + 12),
  });
  assert.deepEqual(rec(0), { type: 0, mouseData: -120, flags: worker.W.MOUSEEVENTF_WHEEL });
  assert.deepEqual(rec(1), { type: 0, mouseData: -120, flags: worker.W.MOUSEEVENTF_WHEEL });
  assert.deepEqual(rec(2), { type: 0, mouseData: -120, flags: worker.W.MOUSEEVENTF_HWHEEL });
});

test('wheel notches', () => {
  assert.equal(worker.wheelNotches(0), 0);
  assert.equal(worker.wheelNotches(1), 1);
  assert.equal(worker.wheelNotches(-30), -1);
  assert.equal(worker.wheelNotches(149), 1);
  assert.equal(worker.wheelNotches(151), 2);
  assert.equal(worker.wheelNotches(1e6), 50);
  assert.equal(worker.wheelInputs(-100, 0)[0].u.mi.mouseData, 120, 'scrolling up is a positive wheel delta');
});

test('crop to the DWM frame', () => {
  const wr = { left: 93, top: 50, right: 1107, bottom: 857 }; // includes 7 px invisible borders
  const fr = { left: 100, top: 50, right: 1100, bottom: 850 };
  assert.deepEqual(worker.cropToFrame(wr, fr), { x: 7, y: 0, width: 1000, height: 800 });
  assert.deepEqual(worker.cropToFrame(wr, wr), { x: 0, y: 0, width: 1014, height: 807 });
});

test('BITMAPINFOHEADER', () => {
  const bmi = worker.bitmapInfoHeader(640, 480);
  assert.equal(bmi.readUInt32LE(0), 40);
  assert.equal(bmi.readInt32LE(4), 640);
  assert.equal(bmi.readInt32LE(8), -480);
  assert.equal(bmi.readUInt16LE(12), 1);
  assert.equal(bmi.readUInt16LE(14), 32);
  assert.equal(bmi.readUInt32LE(16), 0);
});

test('PNG encoding from BGRA (crop, channel order, opaque alpha)', () => {
  const w = 4;
  const h = 3;
  const bgra = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) bgra.set([10 + i, 100, 200, 0], i * 4); // B, G, R, A(undefined)
  const png = worker.encodePngFromBGRA(bgra, w, { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Walk the chunks, verify CRCs, inflate IDAT.
  let off = 8;
  let ihdr;
  let idat = Buffer.alloc(0);
  const types = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), worker.crc32(png.subarray(off + 4, off + 8 + len)), `${type} crc`);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    types.push(type);
    off += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(ihdr.readUInt32BE(0), 2);
  assert.equal(ihdr.readUInt32BE(4), 2);
  assert.equal(ihdr[9], 6);
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, 2 * (1 + 2 * 4));
  const px = (row, col) => [...raw.subarray(row * 9 + 1 + col * 4, row * 9 + 1 + col * 4 + 4)];
  assert.deepEqual(px(0, 0), [200, 100, 10 + 5, 255]); // source pixel (1,1) = index 5
  assert.deepEqual(px(1, 1), [200, 100, 10 + 10, 255]); // source pixel (2,2) = index 10
  assert.equal(worker.encodePngFromBGRA(Buffer.alloc(16), 2, { x: 0, y: 0, width: 2, height: 2 }), null, 'all-black -> null');
});

test('crc32 matches the PNG reference value', () => {
  const data = Buffer.from('IEND');
  assert.equal(worker.crc32(data), 0xae426082);
});
