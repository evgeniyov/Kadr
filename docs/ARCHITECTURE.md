# Kadr — architecture & module contracts

Kadr is a screenshot, annotation and screen recording app for macOS and Windows.
Electron 44 (Chromium 152, Node 24). **Plain JavaScript, no bundler, no framework,
no TypeScript.** UI languages: Russian and English.

## Ground rules (read before writing code)

- Main process: CommonJS (`'use strict'; require(...)`), files in `src/main/`.
- Renderers: ES modules (`<script type="module" src="./index.js">`), one folder per window
  in `src/renderer/<kind>/` with `index.html`, `index.js`, `style.css`.
- Every page is loaded from the custom scheme **`kadr://app/renderer/<kind>/index.html`**.
  - `kadr://app/<path>` → `src/<path>` (so a renderer imports `../../shared/ui.js`)
  - `kadr://app/__data__/<path>` → Electron `userData` — this is what `ctx.dataUrl()` returns; same origin as pages, so canvases are never tainted
  - `kadr://data/<path>` → Electron `userData` (captures, library, temp files)
  - `kadr://modules/jsqr/...` → allow-listed `node_modules` packages
  - Same origin everywhere ⇒ canvases are never tainted, `fetch` works, ES modules work.
- Renderers have **no Node access**. They talk to main only through `window.kadr`
  (see `src/preload/preload.js`): `kadr.invoke(channel, ...args)`, `kadr.send(...)`,
  `kadr.on(channel, cb) → unsubscribe`, `kadr.platform`, `kadr.pathForFile(file)`.
  Historical channel namespaces (actual calls are restricted by `src/main/ipc-policy.json`): `win: app: settings: clipboard: image: pin: editor: capture:
  overlay: scroll: native: library: preview: recorder: ocr:`.
- Binary data over IPC is `Uint8Array` (renderer) / `Buffer` (main).
- Shared renderer helpers: `src/shared/ui.js` (`initPage`, `t`, `el`, `$`, `toast`,
  `canvasToBytes`, `loadImage`, `setSettings`, `formatAccelerator`, `formatDuration`…).
  Always call `await initPage()` first in a window's `index.js`.
- Design system: `src/shared/ui.css` (CSS variables for light/dark, `.btn`, `.ibtn`, `.seg`,
  `.switch`, `.input`, `.panel`, `.card`, `[data-tip]` tooltips, `.toast`). Link it before
  your own CSS: `<link rel="stylesheet" href="../../shared/ui.css">`. Look & feel: compact,
  native-looking macOS/Win11 style, translucent panels, SF/Segoe font, 13px base.
- i18n: `src/shared/i18n/index.mjs` merges per-module dictionaries. **Each module owns its
  own dictionary file** (`core.mjs`, `editor.mjs`, `recorder.mjs`) with `{ ru: {...}, en: {...} }`.
  Keys are prefixed with the module name (`editor.tool.arrow`). Every string shown to the
  user must go through `t()` and exist in both `ru` and `en`. In HTML use
  `data-i18n="key"`, `data-i18n-tip`, `data-i18n-title`, `data-i18n-placeholder`.
  Main process: `ctx.t(key, vars)`.
- Settings: `src/main/settings.js` (defaults for every section incl. `editor.*` and
  `recording.*`). Renderer: `getSettings()`, `setSettings(deepPartialPatch)`; changes are
  broadcast as `settings:changed`. Main: `ctx.settings.get('a.b')`, `ctx.settings.set(patch)`.
  A module may add keys with `ctx.settings.registerDefaults(section, obj)`.
- Shared main context: `src/main/context.js` (`ctx`): `paths`, `settings`, `t`,
  `createWindow(kind, { params, page, ...BrowserWindowOptions })`, `windowsOfKind`,
  `handle(channel, fn)` / `on(channel, fn)` (ipcMain wrappers), `notify`, `formatFileName`,
  `uniquePath`, `newId`, `displayById`, `dataUrl(absPath)`, and `ctx.modules.<name>` —
  the loaded modules (filled by `index.js`, use lazily inside functions, never at require time).
- Window params: `ctx.createWindow('editor', { params: {...} })`; the renderer reads them from
  `initPage()` → `{ params }`.
- Keep code readable: short focused functions, comments only where the "why" is not obvious.
- Nothing may block the main process for long (no sync image loops > ~50ms in main).

## Directory ownership

| Path | Owner |
|---|---|
| `src/main/{index,context,settings,protocol,basics,capture,tray,hotkeys,library,pin,preview,ocr,settings-window,scroll-capture,ffmpeg}.js` | core |
| `src/renderer/{overlay,preview,pin,library,settings,scroller}/` | core |
| `src/shared/*`, `src/shared/i18n/core.mjs` | core |
| `src/main/editor.js`, `src/renderer/editor/`, `src/shared/i18n/editor.mjs` | **editor** |
| `src/main/recording.js`, `src/renderer/recorder/**`, `src/shared/i18n/recorder.mjs` | **recorder** |
| `src/main/native/**`, `native/**`, `resources/bin/**` | **native** |

Do not edit files owned by another module. If you need something from another module that
is not in this contract, write a clear note in your final report instead.

## Generic IPC (implemented in `src/main/basics.js`)

- `win:params` → params · `win:close` · `win:hide` · `win:show({focus})` · `win:focus` ·
  `win:minimize` · `win:toggle-maximize` · `win:get-bounds` · `win:set-bounds(b, animate)` ·
  `win:set-size({width,height,center})` · `win:set-min-size` · `win:center` · `win:set-title` ·
  `win:set-ignore-mouse(ignore, forward)` · `win:set-opacity(v)` ·
  `win:set-always-on-top(v, level)` · `win:set-resizable` · `win:display` → `{id,bounds,workArea,scaleFactor}`
- `settings:get` · `settings:set(patch)` · `settings:reset` · `settings:defaults`
- `app:locale` · `app:version` · `app:open-external(url)` · `app:reveal(path)` ·
  `app:open-path(path)` · `app:open-settings(tab?)` · `app:open-library` ·
  `app:quit` · `app:notify({title, body})` · `app:choose-folder({defaultPath})` ·
  `app:choose-file({filters})` · `app:confirm({message, detail, ok, cancel, danger})` → bool ·
  `app:permissions` → `{screen, accessibility, microphone}` · `app:request-permission(kind)`
- `clipboard:write-image(pngBytes)` · `clipboard:write-text(text)` · `clipboard:read-text` ·
  `clipboard:read-image` → pngBytes | null
- `image:save({data, ext, name?, saveAs?, silent?})` → path | null (default folder + file-name
  template from settings; shows a notification) · `image:temp-file({data, ext, name?})` → path ·
  `image:open-with-default({data, ext})`
- `image:start-drag` (**send**, call inside `dragstart` after `e.preventDefault()`):
  `{ path }` or `{ data, ext, name? }` → native file drag out of the app.

## Core IPC (implemented by core, available to everyone)

- `capture:start({ mode, return? })` — modes: `area fullscreen window activeWindow repeatArea
  scrolling scrollingUp scrollingManual ocr colorPicker delayed`. With `return: true` (only
  `area`/`window`/`fullscreen`) the result is returned instead of going through the after-capture
  pipeline: `{ data: pngBytes, scale, width, height } | null`. Used by the editor's "Add capture".
- `capture:select-region({ purpose })` → `null | { displayId, scaleFactor, displayBounds,
  rect: {x,y,width,height} /* DIP, relative to the display */, global: {x,y,width,height} }`.
  Main-process equivalent: `ctx.modules.capture.selectRegion({ purpose })`.
- `pin:create({ data: pngBytes, scale, x?, y? })` — floating always-on-top image.
- `native:ocr({ data: pngBytes })` → `{ text, lines: [{ text, box:{x,y,width,height} }], qr: [{ text, box }] }`
  (box in image pixels, top-left origin). Uses Vision on macOS, tesseract.js elsewhere; QR via Vision/jsQR.
- `native:remove-bg({ data })` → pngBytes (throws `unsupported` if not available).
- `native:capabilities` → `{ ocr, removeBackground, systemAudio, scrollInject, windowList }` (booleans).
- `library:update-image({ id, data, baseVersion })` → `{ id, version } | null`. Replaces the
  image when the base version matches. A stale editor gets a new library item and a
  notification. The result identifies the item and version for the next save.
- `editor:open` is **not** an IPC; main calls `ctx.modules.editor.openEditor(...)`.

## Module contracts

### Editor (`src/main/editor.js`, `src/renderer/editor/`)

`src/main/editor.js` exports `{ register(), openEditor(opts) }`.

`openEditor({ imagePath, scale = 1, meta = {}, options = {} })` opens a new editor window:
- `imagePath`: absolute PNG path inside `userData` (load it in the renderer via `ctx.dataUrl(imagePath)`).
- `scale`: device pixels per DIP of the capture (2 on Retina). The editor shows the image at
  `1/scale` so 100% zoom looks like the real screen; annotation sizes are in DIP × scale.
- `meta`: `{ source, appName?, windowTitle?, libraryId?, libraryVersion?, fileName?, filePath? }`.
  A fresh capture starts at library version 0.
- `options`: `{ backdrop?: boolean /* auto-enable backdrop (window with background) */, tool?: string }`.
- Window: sized to fit the image (≥ 720×480, ≤ 90% of the work area), centered, focused,
  `titleBarStyle: 'hiddenInset'` on macOS; multiple editors may be open simultaneously.

### Editor features

- Canvas with zoom (pinch, ⌘/Ctrl+scroll, ⌘+/⌘-/⌘0/⌘1), pan (space-drag, scroll), px/pt toggle.
- Tools and keyboard shortcuts include Arrow `A` (styles: classic, curved/bezier, double-headed, thin,
  thick tapered), Rectangle `R` (outline / semi-transparent fill / solid, rounded corners),
  Oval `O`, Line `L` (solid/dashed/dotted), Text `T` (plain / outlined / box background,
  font size, multi-line, edit on double-click), Counter `C` (numbered steps 1,2,3… with
  optional label, auto-increment), Freehand `D`, Highlighter `H` (marker, multiply blend),
  Blur/Erase `B` (pixelate, blur, erase = fill with surrounding colour, and *-text variants that
  only conceal recognised text lines inside the area via `native:ocr`), Spotlight `S`
  (darken everything except the area; several areas allowed), Magnifier `M` (circular loupe
  enlarging a region, placed anywhere), Ruler `1`/`2` (smart ruler that measures distance
  between edges horizontally/vertically from the cursor, with pixel labels), Crop (drag handles,
  `Enter` to apply, can also *expand* the canvas beyond the image = uncrop), Color picker `I`
  (hover shows colour under cursor in the status bar; click copies in `settings.colorFormat`).
- Every object: select, move, resize/re-shape with handles, delete, duplicate (⌘D),
  bring forward/back, change colour/size/opacity/style after creation. Undo/redo (⌘Z/⇧⌘Z).
- Palette: preset colours + custom colours (stored in `settings.editor.customColors`) + system
  colour input; size presets; the last used tool/colour/size persist in `settings.editor`.
- Backdrop `K`: padding, gradient presets + custom 2-colour gradient +
  angle, solid, custom image (`app:choose-file`), transparent; inner corner radius, outer radius,
  shadow, aspect-ratio templates (auto, 16:9, 4:3, 1:1, 3:2, 9:16, Twitter 16:9, …),
  auto-crop edges, randomize. Settings persist in `settings.editor.backdrop`.
- Image objects: paste an image (⌘V), drop an image file, **Add capture** (`capture:start`
  with `return: true`), all movable/resizable.
- Resize image dialog (px or %, keep ratio). Rotate 90°, flip.
- OCR: select area (or whole image) → recognised text + QR shown in a popover, copy
  text/copy without line breaks.
- Remove background (if `native:capabilities.removeBackground`).
- Output: Copy (⌘C; `Esc` = copy and close by default),
  Save (⌘S to default folder), Save As (⇧⌘S; png/jpg/webp), drag-out handle (drag the final
  image into other apps via `image:start-drag`), Pin (⌘P → `pin:create`), Open in default app,
  Animated GIF export "before/after" (original ↔ annotated) — may use `src/main/ffmpeg.js`.
  Output format/quality from settings. When `meta.libraryId` is set, call
  `library:update-image` after Copy/Save so the library keeps the edited version.
- Toolbar on top (tools + properties of the current tool), status bar at bottom (image size,
  zoom, cursor position, colour under cursor). Keyboard shortcuts shown in tooltips.

### Recorder (`src/main/recording.js`, `src/renderer/recorder/**`)

`src/main/recording.js` exports:
`{ register(), openPanel(opts?), toggle(), stop(), cancel(), isRecording(), events }`
where `events` is an `EventEmitter` emitting `'state'` with
`{ status: 'idle'|'countdown'|'recording'|'paused'|'processing', startedAt, elapsedMs }`.
The tray and hotkeys (core) call these functions and listen to `events`.

Requirements:
- Source picker panel (compact window): **Screen** (choose display, thumbnails), **Window**
  (thumbnails of windows via `desktopCapturer`), **Region** (calls
  `ctx.modules.capture.selectRegion({ purpose: 'record' })`, remembered in
  `settings.recording.lastRegion` so the same area can be re-recorded).
- Audio: microphone on/off + device selection (+ level meter), system audio on/off.
  - Windows: system audio via Chromium desktop loopback.
  - macOS: Chromium's loopback does not work with a custom picker (electron#52738), so use
    `ctx.modules.native.systemAudio.start(path)/pause()/resume()/stop()` (ScreenCaptureKit
    helper) and mix it in with ffmpeg after recording. If `native.capabilities().systemAudio`
    is false, disable the toggle with an explanation.
- Options from `settings.recording` (format mp4/webm, fps, quality, cursor, countdown).
- Recording runs in a hidden worker window (`backgroundThrottling: false`) using
  `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`,
  region crop via `MediaStreamTrackProcessor` → `new VideoFrame(frame, { visibleRect })` →
  `MediaStreamTrackGenerator` (even width/height!), audio mixed with WebAudio,
  `MediaRecorder` (`video/mp4;codecs=avc1.640028,mp4a.40.2` when supported, otherwise webm),
  chunks streamed to main and appended to a temp file (never keep the whole video in memory).
- After stop: ffmpeg post-processing (remux to seekable file with `+faststart`, mix mac system
  audio), save to `settings.recording.saveFolder` using `settings.recording.fileNameTemplate`,
  then the **video editor window** (`recorder/editor`): preview, trim, crop, resize, format
  conversion (mp4/webm/mov/mkv/gif/m4a/mp3), fps, mute, speed; `openVideoEditor(file)` opens any
  existing video in it (tray → “Open video…”).
- While recording: small floating control bar (timer, pause/resume, stop, mic mute, discard),
  a click-through dashed frame around a recorded region, `setContentProtection(true)` on all
  recorder UI windows so they never appear in the video, `powerSaveBlocker` active.
- Countdown overlay (3-2-1) before starting (settings.recording.countdown).
- `src/main/ffmpeg.js` (core) provides `ffmpegPath()` and `run(args, { onStderr }) → Promise`.

### Native (`src/main/native/index.js`, `native/mac/`, `resources/bin/mac/`)

`src/main/native/index.js` exports (all async unless noted; must never throw at require time):

```js
init()                         // start helpers lazily; safe to call many times
capabilities()                 // sync → { windowList, captureWindow, captureDisplays, scroll, ocr, barcodes, removeBackground, systemAudio }
listWindows({ allLayers = false } = {})
                               // → [{ id, pid, appName, title, bounds:{x,y,width,height}, layer }]
                               //   global DIP coords (same space as Electron `screen`), front-to-back,
                               //   normal on-screen windows by default, excluding Kadr's own windows.
                               //   allLayers also includes visible positive-layer windows on macOS.
activeWindow()                 // → WindowInfo | null (frontmost window not owned by Kadr)
captureWindow(id, { shadow })  // → { png: Buffer, scale } | null  (window image incl. alpha/shadow)
captureDisplays({ cursor })    // → [{ displayId, path, pixelWidth, pixelHeight }] | null
scroll({ x, y, deltaY })       // post a scroll-wheel event at global DIP point; deltaY>0 scrolls down
ocr(png, { languages, fast })  // → { lines: [{ text, box:{x,y,width,height}, confidence }] } (image px); throws 'unsupported'
barcodes(png)                  // → [{ text, symbology, box }]; throws 'unsupported'
removeBackground(png)          // → Buffer (PNG with alpha); throws 'unsupported'
systemAudio.start(outPath) / .pause() / .resume() / .stop() → { path, startedAt, durationMs } | null
shutdown()
```

- macOS: a Swift command-line helper (`native/mac/*.swift`, built by `native/mac/build.sh` into
  a universal binary `resources/bin/mac/kadr-helper`, deployment target macOS 13) that runs as a
  long-lived child process speaking JSON lines over stdin/stdout. Uses CGWindowList,
  ScreenCaptureKit (`SCScreenshotManager` on 14+, `SCStream` audio), Vision (text, barcodes,
  `VNGenerateForegroundInstanceMaskRequest` on 14+), CGEvent scroll.
- Windows: an Electron `utilityProcess` running `src/main/native/win-worker.js` which uses
  `koffi` (FFI, prebuilt) to call Win32: `EnumWindows`, `DwmGetWindowAttribute`
  (extended frame bounds), `GetWindowThreadProcessId`, `SendInput` (wheel), optionally
  `PrintWindow` for occluded window capture. Rects are physical pixels → convert to DIP in main
  with `screen.screenToDipRect(null, rect)`. A crash of the utility process must not crash the app.

## Persistence and renderer boundaries

- Save original images using `atomic-file.writeFileAtomic`; settings and library indexes keep two current atomic JSON copies (`.bak`). Malformed JSON is preserved as `.corrupt-*` before recovery.
- Library edits clear OCR in memory and both index copies before replacing pixels. OCR results must match the current image revision. `library.flushForQuit()` waits for pending image writes and the final index before quitting, without starting or waiting for background OCR. Each quit retry consumes its bypass once so cancelled closes cannot skip future saves.
- Main IPC validates the registered window, exact renderer URL, top frame and per-page channel catalog. The sandboxed preload embeds exact public channels; keep its catalog and `ipc-policy.json` aligned when adding an API.
- File operations require a window-owned path grant from a native chooser, an actual dropped File verified in preload, or a main-process open/export. The generic bridge cannot grant a path or trash arbitrary files.
- Permissions are limited to clipboard pages, recorder audio/capture pages, and video-only media in the scroller worker. Online translation always requires a native confirmation naming Google and the text disclosure.
- `npm test` uses temporary synthetic files and mocked native/Electron interfaces, never real capture or system permissions.

## Editor and library operation ordering

- A source-image decode error displays an error page; never substitute a writable blank document.
- Commit inline text before encoding/cache lookup. Identical concurrent encodes share one promise. Copy/save may clear dirty or close only when their exported revision is still current. File and library encodings use the same immutable canvas.
- Any dirty editor confirms a close. Copying the current revision delivers a screenshot, so
  Esc can close its editor. A file opened from disk keeps its dirty state after a copy.
- Library replacement, deletion and retention removal share a per-item operation queue. A deletion queued during replacement must leave no resurrected image or thumbnail. Background OCR uses one pending timer and the latest queued revision per item.
- Export stream-copy checks the selected audio track codec, including mixed-codec imported files.

- Translation language preparation is explicit. In-image translation retries its native request once after successful preparation without re-entering the UI guard or repeating OCR. Settings responses use a generation check and refresh model availability on focus.

## Audit invariants (2026-11-09)

- Automatic screenshot saves share a per-directory queue through `basics.saveBytes` so concurrent
  windows cannot select the same output name before either atomic write finishes.
- Library indexes accept only an item's own `id.png` and `id.thumb.jpg`. Startup reconciles orphan
  PNGs even with a valid old index, and repairs missing/interrupted thumbnails. Redaction removes
  the old thumbnail before committing new pixels; a failed thumbnail write cannot reveal old pixels.
- Editor text and backdrop edits set dirty immediately. Copy/save share an ordering queue;
  asynchronous pixel operations and conceal OCR check document/base revisions before applying.
- Overlay/scroller lifecycle is session-owned. Window close, renderer loss, failed load and deadlines
  release pending work. Known display IDs never fall back to a different display ID; legacy complete
  source lists without IDs still use positional mapping for screenshot/recording compatibility.
- Recorder teardown joins pending file/audio initialization before returning idle. Import/delete/export
  reserve the video document before asynchronous work. Probe dimensions include right-angle rotation.
- A failed probe or delivery is not evidence that a recording is disposable. Failed raw/audio/final
  material is retained in `recordings-tmp`; ordinary intermediates are removed after successful full
  delivery. Recovery does not yet reconstruct separate audio or expose a recovery manager, and
  repeated failures can accumulate candidates requiring explicit review.
- `minimatch@>=7 <11.0.1` is overridden to 11.0.1 for GHSA-g3hv-75wg-m249. Versions 3/5 retain their
  callable API. Revisit this override when electron-builder's transitive constraints include the fix.
- Optional diagnostic renderer run: `npx --no-install electron test/integration/editor-benchmark.cjs`.
  It writes synthetic PNGs, UI screenshots and JSON under the OS temporary directory's
  `kadr-audit-visuals` folder by default; an explicit output directory can be passed as an argument.
  It uses one sample per size and is not a capture-latency or steady-state memory benchmark.
