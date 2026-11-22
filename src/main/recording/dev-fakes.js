'use strict';
// Dev/test stand-ins, used only with --dev together with the synthetic capture source:
// tests must never start real screen/audio capture (that can raise system prompts).

const ffmpeg = require('../ffmpeg');

// Mimics ctx.modules.native.systemAudio: on stop it writes a 1 kHz sine .m4a that
// "started" delayMs after start() and excludes paused time, like the real helper.
function fakeSystemAudio({ delayMs = 250 } = {}) {
  let file = null;
  let startedAt = 0;
  let pausedAt = 0;
  let pausedMs = 0;
  return {
    async start(out) {
      file = out;
      startedAt = Date.now() + delayMs;
      return { path: out, startedAt };
    },
    async pause() {
      pausedAt = Date.now();
      return true;
    },
    async resume() {
      if (pausedAt) pausedMs += Date.now() - pausedAt;
      pausedAt = 0;
      return true;
    },
    async stop() {
      if (!file) return null;
      const durationMs = Math.max(500, Date.now() - startedAt - pausedMs);
      await ffmpeg.run(['-f', 'lavfi', '-i', `sine=frequency=1000:duration=${(durationMs / 1000).toFixed(3)}`, '-c:a', 'aac', '-b:a', '128k', file]);
      return { path: file, startedAt, durationMs };
    },
  };
}

module.exports = { fakeSystemAudio };
