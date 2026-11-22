'use strict';
// RpcClient behaviour with fake helper processes: lazy start, shared start, timeouts,
// crash -> rejection + backoff, recycling an unresponsive helper, graceful stop.
//
//   node native/test/rpc.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { RpcClient } = require(path.join(__dirname, '..', '..', 'src', 'main', 'native', 'rpc.js'));

// A fake helper: `behaviour(cmd, args, reply, proc)` decides what happens to each request.
function fakeSpawner(behaviour) {
  const procs = [];
  const spawn = () => {
    let onMsg = () => {};
    let onExit = () => {};
    const proc = {
      pid: 1000 + procs.length,
      killed: false,
      closed: false,
      send(m) {
        if (this.dead) throw new Error('dead');
        setImmediate(() => behaviour(m.cmd, m.args, (reply) => onMsg({ id: m.id, ...reply }), proc));
      },
      onMessage: (cb) => (onMsg = cb),
      onExit: (cb) => (onExit = cb),
      exit(code = 1, signal = null) {
        if (this.dead) return;
        this.dead = true;
        setImmediate(() => onExit(code, signal));
      },
      kill() {
        this.killed = true;
        this.exit(null, 'SIGKILL');
      },
      close() {
        this.closed = true;
        this.exit(0);
      },
    };
    procs.push(proc);
    return proc;
  };
  return { spawn, procs };
}

const hello = { ok: true, result: { capabilities: { ocr: true } } };

test('lazy start, one shared start, hello handshake', async () => {
  const f = fakeSpawner((cmd, args, reply) => reply(cmd === 'hello' ? hello : { ok: true, result: args.n * 2 }));
  let helloSeen = null;
  const c = new RpcClient({ name: 't', spawn: f.spawn, onHello: (h) => (helloSeen = h) });
  assert.equal(f.procs.length, 0);
  const [a, b] = await Promise.all([c.call('double', { n: 2 }), c.call('double', { n: 5 })]);
  assert.deepEqual([a, b], [4, 10]);
  assert.equal(f.procs.length, 1);
  assert.deepEqual(helloSeen, hello.result);
  assert.equal(c.running, true);
});

test('errors carry the helper code', async () => {
  const f = fakeSpawner((cmd, args, reply) =>
    reply(cmd === 'hello' ? hello : { ok: false, error: 'unsupported: x', code: 'UNSUPPORTED' }),
  );
  const c = new RpcClient({ name: 't', spawn: f.spawn });
  await assert.rejects(c.call('x'), (e) => e.code === 'UNSUPPORTED' && /unsupported/.test(e.message));
});

test('timeout rejects; three in a row recycle the helper', async () => {
  const f = fakeSpawner((cmd, args, reply) => cmd === 'hello' && reply(hello)); // never answers other commands
  const c = new RpcClient({ name: 't', spawn: f.spawn });
  for (let i = 0; i < 3; i++) await assert.rejects(c.call('slow', {}, { timeout: 20 }), { code: 'TIMEOUT' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.procs[0].killed, true);
});

test('canRecycle=false keeps an unresponsive helper alive (e.g. while recording)', async () => {
  const f = fakeSpawner((cmd, args, reply) => cmd === 'hello' && reply(hello));
  const c = new RpcClient({ name: 't', spawn: f.spawn, canRecycle: () => false });
  for (let i = 0; i < 4; i++) await assert.rejects(c.call('slow', {}, { timeout: 10 }), { code: 'TIMEOUT' });
  assert.equal(f.procs[0].killed, false);
});

test('crash rejects in-flight requests, restarts after backoff', async () => {
  const f = fakeSpawner((cmd, args, reply, proc) => {
    if (cmd === 'hello') reply(hello);
    else if (cmd === 'crash') proc.exit(null, 'SIGSEGV');
    else reply({ ok: true, result: 'pong' });
  });
  const exits = [];
  const c = new RpcClient({ name: 't', spawn: f.spawn, onExit: (i) => exits.push(i) });
  await c.call('ping');
  await assert.rejects(c.call('crash'), { code: 'HELPER_EXITED' });
  assert.equal(exits.length, 1);
  assert.equal(exits[0].crashed, true);
  const t0 = Date.now();
  assert.equal(await c.call('ping'), 'pong'); // waits for the 500 ms backoff (or the eager restart)
  assert.ok(Date.now() - t0 >= 400, 'restart respected the backoff');
  assert.equal(f.procs.length, 2);
});

test('a helper that dies at start makes calls fail fast with HELPER_UNAVAILABLE', async () => {
  const f = fakeSpawner((cmd, args, reply, proc) => proc.exit(1));
  const c = new RpcClient({ name: 't', spawn: f.spawn });
  for (let i = 0; i < 5; i++) await c.call('x').catch(() => {}); // backoff grows: .5, 1, 2, 4, 8 s
  await assert.rejects(c.call('x'), { code: 'HELPER_UNAVAILABLE' });
});

test('spawn throwing is reported, not thrown synchronously', async () => {
  const c = new RpcClient({
    name: 't',
    spawn: () => {
      throw new Error('ENOENT');
    },
  });
  await assert.rejects(c.call('x'), { code: 'HELPER_UNAVAILABLE' });
});

test('stop() is graceful and not treated as a crash', async () => {
  const f = fakeSpawner((cmd, args, reply) => reply(hello));
  const exits = [];
  const c = new RpcClient({ name: 't', spawn: f.spawn, onExit: (i) => exits.push(i) });
  await c.ensure();
  c.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.procs[0].closed, true);
  assert.equal(exits[0].crashed, false);
  assert.equal(c.running, false);
});
