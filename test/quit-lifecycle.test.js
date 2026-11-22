'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(setImmediate);
function harness(barrier) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const begin = source.indexOf('let libraryFlushed');
  const end = source.indexOf("app.on('will-quit'", begin);
  assert(begin >= 0 && end > begin);
  let handler, retries = 0, notices = 0;
  const attempt = () => { let prevented = false; handler({ preventDefault() { prevented = true; } }); return prevented; };
  vm.runInNewContext(source.slice(begin, end), {
    console: { error() {} },
    ctx: { modules: { library: { flush: barrier, flushForQuit: barrier } }, t: (k) => k, notify() { notices++; } },
    // Electron synchronously emits before-quit again; then a window cancels close.
    app: { on: (_, fn) => { handler = fn; }, quit() { retries++; assert.equal(attempt(), false); } },
  });
  return { attempt, stats: () => ({ retries, notices }) };
}
test('cancelled document close does not bypass the barrier on a second user quit', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; });
  assert.equal(h.attempt(), true); await tick();
  assert.equal(h.stats().retries, 1);
  assert.equal(h.attempt(), true); await tick();
  assert.equal(calls, 2); assert.equal(h.stats().retries, 2);
});
test('overlapping quit requests share a barrier and a failed barrier can be retried', async () => {
  let reject, calls = 0;
  const h = harness(() => { calls++; return calls === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve(); });
  assert.equal(h.attempt(), true); assert.equal(h.attempt(), true); assert.equal(calls, 1);
  reject(new Error('synthetic disk failure')); await tick();
  assert.deepEqual(h.stats(), { retries: 0, notices: 1 });
  assert.equal(h.attempt(), true); await tick();
  assert.equal(calls, 2); assert.equal(h.stats().retries, 1);
});
