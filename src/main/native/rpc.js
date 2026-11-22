'use strict';
// Request/response client for a helper process: lazy start, a `hello` handshake,
// per-request timeouts, crash detection and restart with exponential backoff.
// Transport-agnostic: `spawn()` returns an adapter
//   { pid, send(obj), onMessage(cb), onExit(cb(code, signal)), kill(), close() }.

const { nativeError, sleep } = require('./util');

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;
const STABLE_UPTIME_MS = 60000; // a helper that ran this long resets the crash counter
const MAX_WAIT_FOR_RESTART_MS = 5000; // longer backoffs reject instead of waiting
const MAX_EAGER_RESTARTS = 5;
const TIMEOUTS_BEFORE_RECYCLE = 3;

class RpcClient {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {() => object} o.spawn
   * @param {(hello: any) => void} [o.onHello]
   * @param {(info: {code, signal, crashed}) => void} [o.onExit]
   * @param {() => boolean} [o.canRecycle] may the client kill an unresponsive helper now?
   * @param {number} [o.defaultTimeout]
   * @param {number} [o.idleMs] close the helper after this long without requests (0 = never)
   * @param {() => boolean} [o.canIdle] may an idle helper be closed now?
   * @param {(cmd: string) => void} [o.onCall] sees every request
   */
  constructor({ name, spawn, onHello, onExit, canRecycle, defaultTimeout = 15000, idleMs = 0, canIdle, onCall }) {
    this.name = name;
    this.spawnFn = spawn;
    this.onHello = onHello;
    this.onExitCb = onExit;
    this.canRecycle = canRecycle || (() => true);
    this.defaultTimeout = defaultTimeout;
    this.proc = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.failures = 0;
    this.nextStartAt = 0;
    this.consecutiveTimeouts = 0;
    this.stopped = false;
    this.lastError = null;
    this.idleMs = idleMs;
    this.canIdle = canIdle || (() => true);
    this.onCall = onCall;
    this.idleTimer = null;
  }

  get running() {
    return !!(this.proc && this.proc.ready);
  }

  get pid() {
    return this.proc ? this.proc.pid || null : null;
  }

  async call(cmd, args = {}, { timeout } = {}) {
    clearTimeout(this.idleTimer);
    this.onCall?.(cmd);
    const proc = await this.ensure();
    try {
      return await this.send(proc, cmd, args, timeout || this.defaultTimeout);
    } finally {
      this.armIdle();
    }
  }

  // Idle helpers are closed to free their memory (Vision models etc.); the next call
  // simply starts a fresh one.
  armIdle() {
    if (!this.idleMs || this.pending.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleClose(), this.idleMs);
    this.idleTimer.unref?.();
  }

  idleClose() {
    const proc = this.proc;
    if (!proc || proc.exited || this.pending.size || this.starting) return;
    if (!this.canIdle()) return this.armIdle();
    proc.intentional = true;
    this.proc = null;
    try {
      proc.close();
    } catch {
      proc.kill();
    }
  }

  /** Starts the helper if needed; concurrent callers share one start attempt. */
  ensure() {
    if (this.proc && this.proc.ready) return Promise.resolve(this.proc);
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async start() {
    this.stopped = false;
    const wait = this.nextStartAt - Date.now();
    if (wait > MAX_WAIT_FOR_RESTART_MS) {
      throw nativeError('HELPER_UNAVAILABLE', `${this.name} crashed recently; retry in ${Math.ceil(wait / 1000)} s`);
    }
    if (wait > 0) await sleep(wait);

    let proc;
    try {
      proc = this.spawnFn();
    } catch (e) {
      this.lastError = e;
      this.scheduleBackoff(0);
      throw nativeError('HELPER_UNAVAILABLE', `${this.name} failed to start: ${e.message}`);
    }
    proc.startedAt = Date.now();
    proc.ready = false;
    this.proc = proc;
    proc.onMessage((m) => this.onMessage(proc, m));
    proc.onExit((code, signal) => this.onExit(proc, code, signal));

    try {
      const hello = await this.send(proc, 'hello', {}, 10000);
      if (proc.exited) throw nativeError('HELPER_EXITED', `${this.name} exited during start`);
      proc.ready = true;
      this.lastError = null;
      try {
        this.onHello?.(hello);
      } catch (e) {
        console.error('[native] onHello failed', e);
      }
      return proc;
    } catch (e) {
      this.lastError = e;
      if (!proc.exited) proc.kill();
      throw e.code === 'HELPER_EXITED' || e.code === 'TIMEOUT' ? nativeError('HELPER_UNAVAILABLE', e.message) : e;
    }
  }

  send(proc, cmd, args, timeout) {
    return new Promise((resolve, reject) => {
      if (proc.exited) {
        reject(nativeError('HELPER_EXITED', `${this.name} is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(nativeError('TIMEOUT', `${this.name}: '${cmd}' timed out after ${timeout} ms`));
        this.onTimeout(proc, cmd);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, proc, cmd });
      try {
        proc.send({ id, cmd, args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(nativeError('HELPER_EXITED', `${this.name}: ${e.message}`));
      }
    });
  }

  onMessage(proc, m) {
    if (!m || typeof m !== 'object') return;
    const p = this.pending.get(m.id);
    if (!p || p.proc !== proc) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    this.consecutiveTimeouts = 0;
    if (m.ok) p.resolve(m.result);
    else p.reject(nativeError(m.code || 'FAILED', m.error || `${this.name}: '${p.cmd}' failed`));
  }

  onTimeout(proc, cmd) {
    this.consecutiveTimeouts++;
    if (this.consecutiveTimeouts >= TIMEOUTS_BEFORE_RECYCLE && !proc.exited && this.canRecycle()) {
      console.warn(`[native] ${this.name} is unresponsive ('${cmd}'), restarting it`);
      this.consecutiveTimeouts = 0;
      proc.kill();
    }
  }

  onExit(proc, code, signal) {
    if (proc.exited) return;
    proc.exited = true;
    if (this.proc === proc) this.proc = null;
    for (const [id, p] of this.pending) {
      if (p.proc !== proc) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(nativeError('HELPER_EXITED', `${this.name} exited (${signal || code}) during '${p.cmd}'`));
    }
    const crashed = !proc.intentional;
    if (crashed) {
      const uptime = Date.now() - proc.startedAt;
      this.scheduleBackoff(uptime, proc.ready);
      console.warn(`[native] ${this.name} exited unexpectedly (code ${code}, signal ${signal})`);
    }
    try {
      this.onExitCb?.({ code, signal, crashed });
    } catch (e) {
      console.error('[native] onExit failed', e);
    }
  }

  scheduleBackoff(uptime, wasReady = false) {
    this.failures = uptime > STABLE_UPTIME_MS ? 1 : this.failures + 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
    this.nextStartAt = Date.now() + delay;
    // Bring a helper that had been working back up on its own, so the next request is fast.
    if (wasReady && this.failures <= MAX_EAGER_RESTARTS) {
      const t = setTimeout(() => {
        if (!this.stopped && !this.proc) this.ensure().catch(() => {});
      }, delay + 10);
      t.unref?.();
    }
  }

  /** Graceful stop (lets the helper finish, e.g. finalise audio); no restart. */
  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exited) return;
    proc.intentional = true;
    try {
      proc.close();
    } catch {
      proc.kill();
    }
  }
}

module.exports = { RpcClient };
