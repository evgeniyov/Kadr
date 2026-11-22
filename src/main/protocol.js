'use strict';
// kadr:// custom scheme. All app pages and images are served from it so that
// renderers share one origin (ES modules work, canvases are never tainted).
//
//   kadr://app/<path>           → <appRoot>/src/<path>
//   kadr://app/__data__/<path>  → <userData>/<path>   (same origin as the pages!)
//   kadr://data/<path>          → <userData>/<path>   (legacy alias, CORS-enabled)
//   kadr://modules/<path>       → <appRoot>/node_modules/<path> (allow-listed packages)

const { protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const SCHEME = 'kadr';
const MODULE_ALLOWLIST = ['jsqr'];
const DATA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.ogv', '.m4a', '.mp3', '.wav']);

function registerSchemeAsPrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function inside(base, p) {
  const rel = path.relative(base, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function handle({ appRoot, userData }) {
  const srcRoot = path.join(appRoot, 'src');
  const modulesRoot = path.join(appRoot, 'node_modules');

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let base;
    let isData = false;
    if (url.host === 'app' && rel.startsWith('__data__/')) {
      rel = rel.slice('__data__/'.length);
      base = userData;
      isData = true;
    } else if (url.host === 'app') base = srcRoot;
    else if (url.host === 'data') {
      base = userData;
      isData = true;
    }
    else if (url.host === 'modules') {
      if (!MODULE_ALLOWLIST.includes(rel.split('/')[0])) return new Response('forbidden', { status: 403 });
      base = modulesRoot;
    } else return new Response('not found', { status: 404 });

    const file = path.join(base, rel);
    if (!inside(base, file)) return new Response('forbidden', { status: 403 });

    if (isData && !DATA_EXTENSIONS.has(path.extname(file).toLowerCase())) return new Response('forbidden', { status: 403 });
    const type = MIME[path.extname(file).toLowerCase()];
    try {
      // User data (captures, videos) is plain files on disk: stream them ourselves so
      // <video> gets proper byte-range responses and can seek.
      if (isData) return await serveFile(file, type, request.headers.get('range'));
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      if (type) headers.set('Content-Type', type);
      headers.set('Cache-Control', 'no-cache');
      headers.set('Access-Control-Allow-Origin', 'kadr://app');
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

async function serveFile(file, type, range) {
  const { size } = await fs.promises.stat(file); // follows symlinks
  const headers = new Headers({
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': 'kadr://app',
  });
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec((range || '').trim());
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else start = Math.max(0, size - Number(m[2]));
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(size ? end - start + 1 : 0));
  const body = size ? Readable.toWeb(fs.createReadStream(file, { start, end })) : null;
  return new Response(body, { status, headers });
}

// Build a kadr://data URL for a file inside userData.
function dataUrlFor(userData, absPath) {
  const rel = path.relative(userData, absPath).split(path.sep).map(encodeURIComponent).join('/');
  return `${SCHEME}://app/__data__/${rel}`;
}

function appUrl(rel) {
  return `${SCHEME}://app/${rel}`;
}

module.exports = { registerSchemeAsPrivileged, handle, dataUrlFor, appUrl, SCHEME };
