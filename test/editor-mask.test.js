'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const paths = [];
  class Path2D {
    constructor() { this.segments = 0; paths.push(this); }
    moveTo() {}
    lineTo() { this.segments++; }
    rect(...values) { this.rectangle = values; }
  }
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/editor/mask.js'), 'utf8').replace(/^export /gm, '');
  return { Mask: vm.runInNewContext(code + ';Mask;', { Path2D, Uint8ClampedArray }), paths };
}

test('high-detail selection stops constructing the outline once its animation budget is exceeded', () => {
  const { Mask, paths } = harness();
  const size = 1024, data = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = x % 2 === 0 && y % 2 === 0 ? 255 : 0;
  const outline = new Mask(size, size, data).outline();
  assert.deepEqual(outline.rectangle, [0, 0, size - 1, size - 1]);
  assert(paths[0].segments <= 250001, `constructed ${paths[0].segments} segments before falling back`);
});

test('a simple mask keeps its exact outline and caches the path', () => {
  const { Mask, paths } = harness();
  const mask = Mask.all(5, 3);
  const outline = mask.outline();
  assert.equal(outline.segments, 4);
  assert.equal(outline.rectangle, undefined);
  assert.equal(mask.outline(), outline);
  assert.equal(paths.length, 1);
});
