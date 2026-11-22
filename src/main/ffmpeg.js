'use strict';
// In development, prefer the same build that is included in installers.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function ffmpegPath() {
  const { platform, arch } = process;
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.versions.electron && require('electron').app?.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'ffmpeg', binary);
  }

  const bundled = path.join(__dirname, '../../resources/bin/ffmpeg', `${platform}-${arch}`, binary);
  return fs.existsSync(bundled) ? bundled : binary;
}

// run(['-i', in, out], { onStderr(line), signal }) → Promise<{ code, stderr }>
function run(args, { onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('ffmpeg cancelled'), { name: 'AbortError' });
    if (signal?.aborted) return reject(abortError());
    const bin = ffmpegPath();
    const p = spawn(bin, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20000);
      if (onStderr) s.split(/\r?\n/).forEach((l) => l && onStderr(l));
    });
    const abort = () => p.kill('SIGKILL');
    const cleanup = () => signal?.removeEventListener('abort', abort);
    p.on('error', (err) => {
      cleanup();
      reject(signal?.aborted ? abortError() : err);
    });
    p.on('close', (code) => {
      cleanup();
      if (signal?.aborted) reject(abortError());
      else if (code === 0) resolve({ code, stderr });
      else reject(Object.assign(new Error(`ffmpeg exited with ${code}: ${stderr.split('\n').slice(-4).join(' ')}`), { code, stderr }));
    });
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

// Parse "time=00:01:02.34" progress lines into seconds.
function parseTime(line) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

module.exports = { ffmpegPath, run, parseTime };
