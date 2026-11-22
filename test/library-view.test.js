'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function harness() {
  const requests = [], rendered = [], errors = [];
  const source = fs.readFileSync(path.resolve(__dirname, '../src/renderer/library/index.js'), 'utf8');
  const load = source.slice(source.indexOf('async function load()'), source.indexOf("search.addEventListener('input'"));
  const context = vm.createContext({ search: { value: '' }, selected: new Set(),
    kadr: { invoke: (_, args) => new Promise((resolve, reject) => requests.push({ ...args, resolve, reject })) },
    toast: (message) => errors.push(message), t: (key) => key,
    record: (items) => rendered.push(items) });
  vm.runInContext(`let items = []; let loadGeneration = 0; const render = () => record(items); ${load}`, context);
  return { context, requests, rendered, errors, load: () => vm.runInContext('load()', context) };
}
test('a delayed old search cannot replace current library results or selection', async () => {
  const h = harness();
  h.context.search.value = 'old'; const old = h.load();
  h.context.search.value = 'new'; const current = h.load();
  h.context.selected.add('new');
  h.requests[1].resolve([{ id: 'new' }]); await current;
  h.requests[0].resolve([{ id: 'old' }]); await old;
  assert.deepEqual(h.rendered, [[{ id: 'new' }]]);
  assert(h.context.selected.has('new'));
});
test('search edits during debounce invalidate old results and current errors are visible', async () => {
  const h = harness(); const old = h.load();
  h.context.search.value = 'typed'; h.requests[0].resolve([{ id: 'old' }]); await old;
  assert.equal(h.rendered.length, 0);
  const current = h.load(); h.requests[1].reject(new Error('synthetic failure')); await current;
  assert.deepEqual(h.errors, ['common.error: synthetic failure']);
});
