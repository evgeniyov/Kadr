'use strict';
// Windows native worker. Runs inside an Electron utilityProcess (forked by win.js) and
// calls Win32 through koffi. Never load it in the main process: a bad FFI call crashes
// the process it runs in, and here that only takes down this worker.
//
// Protocol (process.parentPort): { id, cmd, args } -> { id, ok: true, result }
//                                                   | { id, ok: false, error, code }
// All coordinates are physical screen pixels (the thread is per-monitor DPI aware).
//
// Requiring this file has no side effects unless it runs as a utilityProcess on Windows;
// `declareTypes`, `PROTOTYPES` and the pure helpers are exported for tests.

const os = require('os');
const zlib = require('zlib');

const WORKER_VERSION = '1.0.0';

const W = {
  GWL_EXSTYLE: -20,
  WS_EX_TRANSPARENT: 0x00000020,
  WS_EX_TOOLWINDOW: 0x00000080,
  WS_EX_LAYERED: 0x00080000,
  LWA_ALPHA: 0x00000002,
  DWMWA_EXTENDED_FRAME_BOUNDS: 9,
  DWMWA_CLOAKED: 14,
  GA_ROOT: 2,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  INPUT_MOUSE: 0,
  MOUSEEVENTF_WHEEL: 0x0800,
  MOUSEEVENTF_HWHEEL: 0x1000,
  WHEEL_DELTA: 120,
  PW_RENDERFULLCONTENT: 0x00000002,
  BI_RGB: 0,
  DIB_RGB_COLORS: 0,
  // DPI_AWARENESS_CONTEXT pseudo-handles.
  DPI_CTX_PER_MONITOR_AWARE: -3,
  DPI_CTX_PER_MONITOR_AWARE_V2: -4,
};

// Shell surfaces that are never capture targets.
const SKIP_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
]);

const PX_PER_NOTCH = 100; // one wheel notch (120 units) scrolls roughly 100 px
const MAX_NOTCHES = 50;
const MAX_CAPTURE_PIXELS = 50e6;

// ---- koffi declarations (no DLL is loaded here) --------------------------------

let types = null;

/** Declares Win32 types. koffi.struct/proto work on every platform, so tests call this on macOS. */
function declareTypes(koffi) {
  if (types) return types;
  const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
  const HWND = koffi.alias('HWND', HANDLE);
  const RECT = koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
  // mouseData is a DWORD in the SDK; int32_t has the same layout and takes negative deltas.
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32_t',
    dy: 'int32_t',
    mouseData: 'int32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32_t',
    u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });
  // BOOL CALLBACK EnumWindowsProc(HWND, LPARAM): BOOL is a 4-byte int, LPARAM is pointer-sized.
  const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(HWND hwnd, intptr_t lParam)');
  types = { HANDLE, HWND, RECT, POINT, MOUSEINPUT, KEYBDINPUT, HARDWAREINPUT, INPUT, EnumWindowsProc };
  return types;
}

// Win32 types used below: BOOL -> int, DWORD/UINT -> uint32_t, LONG -> int32_t,
// LPARAM/LONG_PTR -> intptr_t, HDC/HBITMAP/HGDIOBJ/HANDLE -> HANDLE (opaque pointer),
// DPI_AWARENESS_CONTEXT -> intptr_t (pointer-sized pseudo-handle), HRESULT -> int32_t.
// Buffers passed as `void *` are filled in place (UTF-16 text, DWM attributes, pixels).
const PROTOTYPES = {
  'user32.dll': [
    'int __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)',
    'int __stdcall IsWindow(HWND hWnd)',
    'int __stdcall IsWindowVisible(HWND hWnd)',
    'int __stdcall IsIconic(HWND hWnd)',
    'int __stdcall GetWindowTextW(HWND hWnd, void *lpString, int nMaxCount)',
    'int __stdcall GetClassNameW(HWND hWnd, void *lpClassName, int nMaxCount)',
    'uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *lpdwProcessId)',
    'int __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)',
    'int __stdcall GetLayeredWindowAttributes(HWND hwnd, _Out_ uint32_t *pcrKey, _Out_ uint8_t *pbAlpha, _Out_ uint32_t *pdwFlags)',
    'HWND __stdcall GetForegroundWindow()',
    'HWND __stdcall GetAncestor(HWND hwnd, uint32_t gaFlags)',
    'int __stdcall SetCursorPos(int X, int Y)',
    'uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)',
    'HANDLE __stdcall GetDC(HWND hWnd)',
    'int __stdcall ReleaseDC(HWND hWnd, HANDLE hDC)',
    'int __stdcall PrintWindow(HWND hwnd, HANDLE hdcBlt, uint32_t nFlags)',
  ],
  'gdi32.dll': [
    'HANDLE __stdcall CreateCompatibleDC(HANDLE hdc)',
    'HANDLE __stdcall CreateCompatibleBitmap(HANDLE hdc, int cx, int cy)',
    'HANDLE __stdcall SelectObject(HANDLE hdc, HANDLE h)',
    'int __stdcall DeleteObject(HANDLE ho)',
    'int __stdcall DeleteDC(HANDLE hdc)',
    'int __stdcall GetDIBits(HANDLE hdc, HANDLE hbm, uint32_t start, uint32_t cLines, void *lpvBits, void *lpbmi, uint32_t usage)',
  ],
  'dwmapi.dll': [
    'int32_t __stdcall DwmGetWindowAttribute(HWND hwnd, uint32_t dwAttribute, void *pvAttribute, uint32_t cbAttribute)',
  ],
  'kernel32.dll': [
    'HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)',
    'int __stdcall QueryFullProcessImageNameW(HANDLE hProcess, uint32_t dwFlags, void *lpExeName, _Inout_ uint32_t *lpdwSize)',
    'int __stdcall CloseHandle(HANDLE hObject)',
  ],
};

// Missing on older Windows builds (or 32-bit, for GetWindowLongPtrW); bound if present.
const OPTIONAL_PROTOTYPES = {
  'user32.dll': [
    'intptr_t __stdcall GetWindowLongPtrW(HWND hWnd, int nIndex)',
    'int32_t __stdcall GetWindowLongW(HWND hWnd, int nIndex)',
    'intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t dpiContext)',
    'intptr_t __stdcall GetWindowDpiAwarenessContext(HWND hwnd)',
    'int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t value)',
    'uint32_t __stdcall GetDpiForWindow(HWND hwnd)',
  ],
};

function functionName(proto) {
  return /(\w+)\s*\(/.exec(proto)[1];
}

/** Loads the DLLs and binds every function. Windows only. */
function bindApi(koffi) {
  const T = declareTypes(koffi);
  const api = { T, koffi };
  for (const [dll, protos] of Object.entries(PROTOTYPES)) {
    const lib = koffi.load(dll);
    for (const p of protos) api[functionName(p)] = lib.func(p);
  }
  for (const [dll, protos] of Object.entries(OPTIONAL_PROTOTYPES)) {
    const lib = koffi.load(dll);
    for (const p of protos) {
      try {
        api[functionName(p)] = lib.func(p);
      } catch {
        api[functionName(p)] = null;
      }
    }
  }
  return api;
}

// ---- pure helpers (tested on every platform) -----------------------------------

/** Scroll distance in px -> signed number of wheel notches (at least one when non-zero). */
function wheelNotches(deltaPx) {
  const d = Number(deltaPx) || 0;
  if (!d) return 0;
  return Math.sign(d) * Math.min(MAX_NOTCHES, Math.max(1, Math.round(Math.abs(d) / PX_PER_NOTCH)));
}

/**
 * INPUT records for a wheel scroll. WHEEL: positive = away from the user = content up,
 * so deltaY > 0 (scroll down) becomes negative. HWHEEL: positive = scroll right.
 */
function wheelInputs(deltaY, deltaX) {
  const make = (flag, data) => ({
    type: W.INPUT_MOUSE,
    u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flag, time: 0, dwExtraInfo: 0 } },
  });
  const inputs = [];
  const ny = wheelNotches(deltaY);
  for (let i = 0; i < Math.abs(ny); i++) inputs.push(make(W.MOUSEEVENTF_WHEEL, -Math.sign(ny) * W.WHEEL_DELTA));
  const nx = wheelNotches(deltaX);
  for (let i = 0; i < Math.abs(nx); i++) inputs.push(make(W.MOUSEEVENTF_HWHEEL, Math.sign(nx) * W.WHEEL_DELTA));
  return inputs;
}

function rectFromBuffer(buf) {
  return { left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) };
}

function bitmapInfoHeader(width, height) {
  // BITMAPINFOHEADER (40 bytes) + room for a colour table / bit-field masks GetDIBits may write.
  const bmi = Buffer.alloc(40 + 256 * 4);
  bmi.writeUInt32LE(40, 0); // biSize
  bmi.writeInt32LE(width, 4); // biWidth
  bmi.writeInt32LE(-height, 8); // biHeight < 0: top-down rows
  bmi.writeUInt16LE(1, 12); // biPlanes
  bmi.writeUInt16LE(32, 14); // biBitCount
  bmi.writeUInt32LE(W.BI_RGB, 16); // biCompression
  return bmi;
}

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes a region of a top-down BGRA bitmap as an opaque RGBA PNG.
 * Returns null when the region is entirely black (PrintWindow failure mode).
 */
function encodePngFromBGRA(bgra, srcWidth, rect) {
  const { x, y, width, height } = rect;
  const rowLen = width * 4 + 1;
  const raw = Buffer.allocUnsafe(rowLen * height);
  let anyColor = false;
  for (let row = 0; row < height; row++) {
    let o = row * rowLen;
    raw[o++] = 0; // filter: none
    let s = ((y + row) * srcWidth + x) * 4;
    for (let col = 0; col < width; col++, s += 4) {
      const b = bgra[s];
      const g = bgra[s + 1];
      const r = bgra[s + 2];
      if (r | g | b) anyColor = true;
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255; // PrintWindow leaves alpha undefined
    }
  }
  if (!anyColor) return null;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Visible-frame crop inside the full window bitmap (drops the invisible resize borders). */
function cropToFrame(windowRect, frameRect) {
  const w = windowRect.right - windowRect.left;
  const h = windowRect.bottom - windowRect.top;
  const x = Math.min(Math.max(frameRect.left - windowRect.left, 0), w);
  const y = Math.min(Math.max(frameRect.top - windowRect.top, 0), h);
  const width = Math.max(0, Math.min(frameRect.right - frameRect.left, w - x));
  const height = Math.max(0, Math.min(frameRect.bottom - frameRect.top, h - y));
  return { x, y, width, height };
}

// ---- Win32 operations ----------------------------------------------------------

function createOps(api) {
  const pidNames = new Map();

  // Window ids travel as JS numbers. HWNDs only use the low 32 bits but may come back
  // sign-extended, so convert through a signed 64-bit value to keep them exact.
  function handle(id) {
    return BigInt.asUintN(64, BigInt(id));
  }
  function idOf(hwnd) {
    return Number(BigInt.asIntN(64, BigInt(hwnd)));
  }

  function dwmRect(hwnd) {
    const buf = Buffer.alloc(16);
    return api.DwmGetWindowAttribute(hwnd, W.DWMWA_EXTENDED_FRAME_BOUNDS, buf, 16) === 0 ? rectFromBuffer(buf) : null;
  }

  function windowRect(hwnd) {
    const r = {};
    return api.GetWindowRect(hwnd, r) ? r : null;
  }

  function isCloaked(hwnd) {
    const buf = Buffer.alloc(4);
    return api.DwmGetWindowAttribute(hwnd, W.DWMWA_CLOAKED, buf, 4) === 0 && buf.readUInt32LE(0) !== 0;
  }

  function exStyle(hwnd) {
    const get = api.GetWindowLongPtrW || api.GetWindowLongW;
    return get ? Number(get(hwnd, W.GWL_EXSTYLE)) >>> 0 : 0;
  }

  function layeredAlpha(hwnd) {
    const key = [0];
    const alpha = [0];
    const flags = [0];
    if (!api.GetLayeredWindowAttributes(hwnd, key, alpha, flags)) return 255;
    return flags[0] & W.LWA_ALPHA ? alpha[0] : 255;
  }

  function utf16(fn, hwnd, chars) {
    const buf = Buffer.alloc(chars * 2);
    const n = fn(hwnd, buf, chars);
    return n > 0 ? buf.toString('utf16le', 0, Math.min(n, chars) * 2) : '';
  }

  function processName(pid) {
    if (pidNames.has(pid)) return pidNames.get(pid);
    let name = '';
    const h = api.OpenProcess(W.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (h) {
      try {
        const buf = Buffer.alloc(1024 * 2);
        const size = [1024];
        if (api.QueryFullProcessImageNameW(h, 0, buf, size)) {
          const full = buf.toString('utf16le', 0, size[0] * 2);
          name = full.split('\\').pop().replace(/\.exe$/i, '');
        }
      } finally {
        api.CloseHandle(h);
      }
    }
    if (pidNames.size > 500) pidNames.clear();
    pidNames.set(pid, name);
    return name;
  }

  function describe(hwnd) {
    if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd) || isCloaked(hwnd)) return null;
    const ex = exStyle(hwnd);
    if (ex & W.WS_EX_TOOLWINDOW) return null;
    if (ex & W.WS_EX_LAYERED) {
      if (ex & W.WS_EX_TRANSPARENT) return null; // click-through overlay
      if (layeredAlpha(hwnd) === 0) return null; // fully transparent
    }
    const className = utf16(api.GetClassNameW, hwnd, 256);
    if (SKIP_CLASSES.has(className)) return null;
    const r = dwmRect(hwnd) || windowRect(hwnd);
    if (!r || r.right - r.left <= 0 || r.bottom - r.top <= 0) return null;
    const pidOut = [0];
    api.GetWindowThreadProcessId(hwnd, pidOut);
    const pid = pidOut[0];
    return {
      id: idOf(hwnd),
      pid,
      appName: processName(pid),
      title: utf16(api.GetWindowTextW, hwnd, 512),
      className,
      bounds: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top },
      layer: 0,
    };
  }

  function listWindows() {
    const hwnds = [];
    // Transient callback: only called while EnumWindows runs. Order = Z-order, top first.
    api.EnumWindows((hwnd) => {
      if (hwnd) hwnds.push(hwnd);
      return 1;
    }, 0);
    const windows = [];
    for (const hwnd of hwnds) {
      try {
        const w = describe(hwnd);
        if (w) windows.push(w);
      } catch {
        /* window vanished meanwhile */
      }
    }
    let fg = api.GetForegroundWindow();
    if (fg) fg = api.GetAncestor(fg, W.GA_ROOT) || fg;
    let foregroundPid = null;
    if (fg) {
      const out = [0];
      api.GetWindowThreadProcessId(fg, out);
      foregroundPid = out[0] || null;
    }
    return { windows, foregroundId: fg ? idOf(fg) : null, foregroundPid };
  }

  function scroll({ x, y, deltaY = 0, deltaX = 0 }) {
    if (!api.SetCursorPos(Math.round(x), Math.round(y))) {
      const e = new Error('SetCursorPos failed');
      e.code = 'FAILED';
      throw e;
    }
    const inputs = wheelInputs(deltaY, deltaX);
    const sent = inputs.length ? api.SendInput(inputs.length, inputs, api.koffi.sizeof(api.T.INPUT)) : 0;
    return { sent, notches: wheelNotches(deltaY) };
  }

  function printWindow(hwnd, width, height) {
    const screenDC = api.GetDC(null);
    if (!screenDC) return null;
    let memDC = null;
    let bmp = null;
    let old = null;
    try {
      memDC = api.CreateCompatibleDC(screenDC);
      if (!memDC) return null;
      bmp = api.CreateCompatibleBitmap(screenDC, width, height);
      if (!bmp) return null;
      old = api.SelectObject(memDC, bmp);
      let ok = api.PrintWindow(hwnd, memDC, W.PW_RENDERFULLCONTENT);
      if (!ok) ok = api.PrintWindow(hwnd, memDC, 0);
      // GetDIBits requires the bitmap not to be selected into a DC.
      api.SelectObject(memDC, old);
      old = null;
      if (!ok) return null;
      const pixels = Buffer.alloc(width * height * 4);
      const lines = api.GetDIBits(memDC, bmp, 0, height, pixels, bitmapInfoHeader(width, height), W.DIB_RGB_COLORS);
      return lines === height ? pixels : null;
    } finally {
      if (old) api.SelectObject(memDC, old);
      if (bmp) api.DeleteObject(bmp);
      if (memDC) api.DeleteDC(memDC);
      api.ReleaseDC(null, screenDC);
    }
  }

  function captureWindow({ id }) {
    const hwnd = handle(id);
    if (!api.IsWindow(hwnd) || api.IsIconic(hwnd)) return null;
    const wr = windowRect(hwnd);
    if (!wr) return null;
    const width = wr.right - wr.left;
    const height = wr.bottom - wr.top;
    if (width <= 0 || height <= 0 || width * height > MAX_CAPTURE_PIXELS) return null;
    const frame = dwmRect(hwnd) || wr;
    const crop = cropToFrame(wr, frame);
    if (!crop.width || !crop.height) return null;
    const bgra = printWindow(hwnd, width, height);
    if (!bgra) return null;
    const png = encodePngFromBGRA(bgra, width, crop);
    if (!png) return null;
    let awareness = null;
    if (api.GetWindowDpiAwarenessContext && api.GetAwarenessFromDpiAwarenessContext) {
      awareness = api.GetAwarenessFromDpiAwarenessContext(api.GetWindowDpiAwarenessContext(hwnd));
    }
    return {
      png,
      width: crop.width,
      height: crop.height,
      frame: { x: frame.left, y: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top },
      dpi: api.GetDpiForWindow ? api.GetDpiForWindow(hwnd) : null,
      awareness,
    };
  }

  return { listWindows, scroll, captureWindow };
}

// ---- worker entry ---------------------------------------------------------------

function startWorker(port) {
  let ops = null;
  let initError = null;
  try {
    const koffi = require('koffi');
    const api = bindApi(koffi);
    // Physical coordinates everywhere, whatever the process default is.
    if (api.SetThreadDpiAwarenessContext && !api.SetThreadDpiAwarenessContext(W.DPI_CTX_PER_MONITOR_AWARE_V2)) {
      api.SetThreadDpiAwarenessContext(W.DPI_CTX_PER_MONITOR_AWARE);
    }
    ops = createOps(api);
  } catch (e) {
    initError = e;
    console.error('[win-worker] init failed:', e && e.message);
  }

  const handlers = {
    hello: () => ({
      version: WORKER_VERSION,
      os: os.release(),
      arch: process.arch,
      error: initError ? String(initError.message || initError) : null,
      capabilities: {
        windowList: !!ops,
        captureWindow: !!ops,
        captureDisplays: false,
        scroll: !!ops,
        ocr: false,
        barcodes: false,
        removeBackground: false,
        systemAudio: false,
      },
    }),
    // Round-trips a tiny PNG through the same encoder and transport as captureWindow.
    selftest: () => {
      const bgra = Buffer.alloc(2 * 2 * 4, 0x80);
      return { png: encodePngFromBGRA(bgra, 2, { x: 0, y: 0, width: 2, height: 2 }), width: 2, height: 2 };
    },
    windows: () => ops.listWindows(),
    scroll: (args) => ops.scroll(args),
    captureWindow: (args) => ops.captureWindow(args),
  };

  port.on('message', (event) => {
    const msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    const { id, cmd, args } = msg;
    let reply;
    try {
      const fn = handlers[cmd];
      if (!fn) {
        reply = { id, ok: false, error: `unknown command '${cmd}'`, code: 'UNKNOWN_COMMAND' };
      } else if (cmd !== 'hello' && cmd !== 'selftest' && !ops) {
        reply = { id, ok: false, error: 'unsupported', code: 'UNSUPPORTED' };
      } else {
        reply = { id, ok: true, result: fn(args || {}) ?? null };
      }
    } catch (e) {
      reply = { id, ok: false, error: String((e && e.message) || e), code: (e && e.code) || 'FAILED' };
    }
    port.postMessage(reply);
  });
}

// KADR_WIN_WORKER_TEST=1 runs the message loop elsewhere (binding fails, hello reports it),
// which lets the utilityProcess plumbing be tested on macOS.
if (process.parentPort && (process.platform === 'win32' || process.env.KADR_WIN_WORKER_TEST === '1')) {
  startWorker(process.parentPort);
}

module.exports = {
  W,
  PROTOTYPES,
  OPTIONAL_PROTOTYPES,
  declareTypes,
  functionName,
  wheelNotches,
  wheelInputs,
  rectFromBuffer,
  bitmapInfoHeader,
  encodePngFromBGRA,
  cropToFrame,
  crc32,
};
