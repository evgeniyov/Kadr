'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function harness() {
  const timers = [], events = new Map(); let requests = 0, mutations = 0;
  const ctx = { isMac: true, settings: { get: () => '', set: () => { mutations++; } }, modules: { native: { requestScreenAccess: async () => { requests++; return false; } } } };
  const app = { isPackaged: true, on: (name, fn) => events.set(name, fn), getVersion: () => 'synthetic', quit() {} };
  const mocks = { fs, electron: { app, shell: { openExternal: async () => {} }, systemPreferences: { getMediaAccessStatus: () => 'denied', isTrustedAccessibilityClient: () => false } }, child_process: { spawn: () => { throw new Error('unexpected process'); }, execFile: () => { throw new Error('unexpected privacy reset'); } }, './context': ctx };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/main/permissions.js'), 'utf8');
  vm.runInNewContext(source, { module, exports: module.exports, require: (id) => mocks[id], console, process, setTimeout: (fn) => { timers.push(fn); } });
  return { api: module.exports, timers, source, counts: () => ({ requests, mutations }) };
}
test('startup without screen access neither resets privacy entries nor requests access', () => {
  const h = harness();h.api.register();assert.equal(h.timers.length, 0);assert.deepEqual(h.counts(), { requests: 0, mutations: 0 });assert(!h.source.includes('tccutil'));
});
test('an explicit screen-permission request uses the native prompt without resetting privacy entries', async () => {
  const h = harness();await h.api.requestScreen({ openPane: false });assert.deepEqual(h.counts(), { requests: 1, mutations: 0 });
});
