# Kadr architecture and module contracts

Kadr is a screenshot, annotation, and screen recording app for macOS and Windows.
It uses Electron 44 with Chromium 152 and Node 24. The code is plain JavaScript and uses
no bundler, framework, or TypeScript. The interface supports Russian and English.

## Code conventions

- Use CommonJS in the main process. Files in `src/main/` use `'use strict'; require(...)`.
- Use ES modules in renderers with `<script type="module" src="./index.js">`. Each window has a
  folder under `src/renderer/<kind>/` with `index.html`, `index.js`, and `style.css`.
- Load each page at `kadr://app/renderer/<kind>/index.html`.
  - The protocol maps `kadr://app/<path>` to `src/<path>`. A renderer can import `../../shared/ui.js`.
  - `ctx.dataUrl()` returns a URL under `kadr://app/__data__/<path>` for files in Electron's
    `userData`. These URLs share an origin with the pages.
  - `kadr://data/<path>` maps to Electron's `userData` for captures, the library, and temporary files.
  - `kadr://modules/jsqr/...` maps to allowed `node_modules` packages.
  - The shared origin lets renderers use `fetch` and ES modules and keeps canvases untainted.
- Renderers have no Node access. They talk to the main process through `window.kadr`, defined in
  `src/preload/preload.js`. The bridge has `kadr.invoke(channel, ...args)`, `kadr.send(...)`,
  `kadr.on(channel, cb)`, `kadr.platform`, and `kadr.pathForFile(file)`.
  `kadr.on(channel, cb)` returns a function that unsubscribes.
  `src/main/ipc-policy.json` restricts calls within the historical channel namespaces
  `win: app: settings: clipboard: image: pin: editor: capture:
  overlay: scroll: native: library: preview: recorder: ocr:`.
- For binary data over interprocess communication (IPC), use `Uint8Array` in the renderer and
  `Buffer` in the main process.
- `src/shared/ui.js` provides renderer helpers such as `initPage`, `t`, `el`, `$`, `toast`,
  `canvasToBytes`, `loadImage`, `setSettings`, `formatAccelerator`, and `formatDuration`.
  Call `await initPage()` first in a window's `index.js`.
- `src/shared/ui.css` defines light and dark CSS variables, `.btn`, `.ibtn`, `.seg`,
  `.switch`, `.input`, `.panel`, `.card`, `[data-tip]` tooltips, and `.toast`.
  Link it before your own CSS using `<link rel="stylesheet" href="../../shared/ui.css">`.
  Use compact spacing, translucent panels, and 13px base text in SF on macOS or Segoe on
  Windows 11 to match the platform.
- `src/shared/i18n/index.mjs` merges module dictionaries. Each module owns its dictionary
  file, such as `core.mjs`, `editor.mjs`, or `recorder.mjs`, with `{ ru: {...}, en: {...} }`.
  Prefix keys with the module name, as in `editor.tool.arrow`. Pass every user-visible string
  through `t()` and include it in both `ru` and `en`. In HTML, use `data-i18n="key"`,
  `data-i18n-tip`, `data-i18n-title`, and `data-i18n-placeholder`. In the main process, use
  `ctx.t(key, vars)`.
- `src/main/settings.js` defines defaults for every section, including `editor.*` and `recording.*`.
  In renderers, use `getSettings()` and `setSettings(deepPartialPatch)`. Settings changes go out
  as `settings:changed`. In the main process, use `ctx.settings.get('a.b')` and
  `ctx.settings.set(patch)`. Modules can add keys with `ctx.settings.registerDefaults(section, obj)`.
- `src/main/context.js` provides `ctx` to the main process. It has `paths`, `settings`, `t`,
  `createWindow(kind, { params, page, ...BrowserWindowOptions })`, `windowsOfKind`,
  `handle(channel, fn)` and `on(channel, fn)` for `ipcMain`, `notify`, `formatFileName`,
  `uniquePath`, `newId`, `displayById`, and `dataUrl(absPath)`. The main `index.js` adds loaded
  modules to `ctx.modules.<name>`. Read them inside functions when needed, after module loading.
- Pass parameters with `ctx.createWindow('editor', { params: {...} })`. The renderer gets
  `{ params }` from `initPage()`.
- Keep functions short and focused. Comment when the reason for a choice needs explanation.
- Keep the main process responsive. Synchronous image loops must stay under about 50 ms.

## Directory ownership

| Path | Owner |
|---|---|
| `src/main/{index,context,settings,protocol,basics,capture,tray,hotkeys,library,pin,preview,ocr,settings-window,scroll-capture,ffmpeg}.js` | core |
| `src/renderer/{overlay,preview,pin,library,settings,scroller}/` | core |
| `src/shared/*`, `src/shared/i18n/core.mjs` | core |
| `src/main/editor.js`, `src/renderer/editor/`, `src/shared/i18n/editor.mjs` | editor |
| `src/main/recording.js`, `src/renderer/recorder/**`, `src/shared/i18n/recorder.mjs` | recorder |
| `src/main/native/**`, `native/**`, `resources/bin/**` | native |

Edit only the files your module owns. If you need another module to provide something outside
this contract, ask for it in your final report.

## Generic IPC

`src/main/basics.js` implements these calls.

- `win:params` returns the window parameters. Other window calls are `win:close`, `win:hide`,
  `win:show({focus})`, `win:focus`, `win:minimize`, `win:toggle-maximize`, `win:get-bounds`,
  `win:set-bounds(b, animate)`, `win:set-size({width,height,center})`, `win:set-min-size`,
  `win:center`, `win:set-title`, `win:set-ignore-mouse(ignore, forward)`, `win:set-opacity(v)`,
  `win:set-always-on-top(v, level)`, and `win:set-resizable`.
  `win:display` returns `{id,bounds,workArea,scaleFactor}`.
- Settings calls are `settings:get`, `settings:set(patch)`, `settings:reset`, and `settings:defaults`.
- App calls are `app:locale`, `app:version`, `app:open-external(url)`, `app:reveal(path)`,
  `app:open-path(path)`, `app:open-settings(tab?)`, `app:open-library`, `app:quit`,
  `app:notify({title, body})`, `app:choose-folder({defaultPath})`, `app:choose-file({filters})`,
  and `app:request-permission(kind)`.
  `app:confirm({message, detail, ok, cancel, danger})` returns a boolean.
  `app:permissions` returns `{screen, accessibility, microphone}`.
- Clipboard calls are `clipboard:write-image(pngBytes)`, `clipboard:write-text(text)`,
  `clipboard:read-text`, and `clipboard:read-image`. The last returns PNG bytes or null.
- `image:save({data, ext, name?, saveAs?, silent?})` returns a path or null. It uses the default
  folder and filename template from settings and shows a notification.
  `image:temp-file({data, ext, name?})` returns a path.
  `image:open-with-default({data, ext})` opens the image in its default app.
- In `dragstart`, call `e.preventDefault()`, then send `image:start-drag` with `{ path }` or
  `{ data, ext, name? }` to start a native file drag out of the app.

## Core IPC

The core module implements these calls for all modules.

- `capture:start({ mode, return? })` accepts these modes.
  `area fullscreen window activeWindow repeatArea
  scrolling scrollingUp scrollingManual ocr colorPicker delayed`.
  In `area`, `window`, and `fullscreen` modes, set `return: true` to get
  `{ data: pngBytes, scale, width, height } | null` and skip the normal steps after capture.
  The editor uses this option for "Add capture".
- `capture:select-region({ purpose })` returns
  `null | { displayId, scaleFactor, displayBounds,
  rect: {x,y,width,height} /* DIP, relative to the display */, global: {x,y,width,height} }`.
  In the main process, call `ctx.modules.capture.selectRegion({ purpose })`.
- `pin:create({ data: pngBytes, scale, x?, y? })` pins an image above other windows.
- `native:ocr({ data: pngBytes })` returns
  `{ text, lines: [{ text, box:{x,y,width,height} }], qr: [{ text, box }] }`.
  Each box uses image pixels and a top-left origin. Text recognition uses Vision on macOS and
  Tesseract.js elsewhere. QR detection uses Vision or jsQR.
- `native:remove-bg({ data })` returns PNG bytes or throws `unsupported` if it is unavailable.
- `native:capabilities` returns booleans in `{ ocr, removeBackground, systemAudio, scrollInject, windowList }`.
- `library:update-image({ id, data, baseVersion })` returns `{ id, version } | null`.
  It replaces the image if the base version matches. Otherwise it creates a new library item
  and notifies the user. The result identifies the item and version to use for the next save.
- To open the editor, call `ctx.modules.editor.openEditor(...)` from the main process.
  There is no `editor:open` IPC channel.

## Module contracts

### Editor

`src/main/editor.js` exports `{ register(), openEditor(opts) }`. The renderer lives in
`src/renderer/editor/`.

`openEditor({ imagePath, scale = 1, meta = {}, options = {} })` opens a new editor window.

- Pass an absolute PNG path inside `userData` as `imagePath`. Load it in the renderer with
  `ctx.dataUrl(imagePath)`.
- Set `scale` to device pixels per device-independent pixel (DIP) in the capture, with 2 on Retina.
  The editor displays the image at `1/scale` so 100% zoom matches the screen. Annotation sizes
  use DIP × scale.
- Pass `{ source, appName?, windowTitle?, libraryId?, libraryVersion?, fileName?, filePath? }`
  as `meta`. A new capture starts at library version 0.
- Pass `{ backdrop?: boolean /* auto-enable backdrop (window with background) */, tool?: string }`
  as `options`.
- The editor centers and focuses the window and sizes it to fit the image, with a minimum
  of 720×480 and a maximum of 90% of the work area. On macOS it uses
  `titleBarStyle: 'hiddenInset'`. Users can open multiple editors at once.

### Editor tools

- Zoom with pinch, ⌘/Ctrl+scroll, or ⌘+/⌘-/⌘0/⌘1. Pan with space-drag or scrolling.
  Switch between pixels and points.
- Arrow `A` has classic, curved (Bézier), double-headed, thin, and thick tapered styles.
  Rectangle `R` supports outlines, semi-transparent or solid fills, and rounded corners.
  Use Oval `O` for ovals. Line `L` has solid, dashed, and dotted styles.
- Text `T` supports plain text, outlines, a box background, font sizes, and multiple lines.
  Double-click to edit. Counter `C` numbers steps in order (1, 2, 3, and so on) and can add a label.
- Draw strokes with Freehand `D`. Highlighter `H` uses a multiply blend.
  Blur/Erase `B` can pixelate, blur, or fill with the surrounding color. Its `*-text` variants
  use `native:ocr` to conceal only recognized lines inside the area.
- Spotlight `S` darkens everything outside one or more selected areas. Magnifier `M` adds a
  circular view of a region that you can place anywhere. Ruler `1`/`2` measures distance
  between edges horizontally or vertically from the cursor and labels it in pixels.
- Crop with the drag handles and press `Enter` to apply. You can also expand the canvas beyond
  the image. Color picker `I` shows the color under the cursor in the status bar. Click to
  copy a color in `settings.colorFormat`.
- Select, move, resize, reshape, delete, or duplicate objects. Use the handles to resize or
  reshape and ⌘D to duplicate. Change stacking order, color, size, opacity, or style after
  creation. Use ⌘Z to undo and ⇧⌘Z to redo.
- Use preset colors, custom colors in `settings.editor.customColors`, or the system color
  picker. The editor has size presets. It stores the last tool, color, and size in `settings.editor`.
- Backdrop `K` supports padding, preset gradients, custom two-color gradients with an angle,
  solid colors, custom images via `app:choose-file`, and transparency. It has inner and outer
  corner radii, shadow, automatic edge cropping, and randomization. Aspect ratio templates
  include auto, 16:9, 4:3, 1:1, 3:2, 9:16, and Twitter 16:9. The editor stores these settings
  in `settings.editor.backdrop`.
- Paste an image with ⌘V, drop an image file, or use **Add capture**. Add capture calls
  `capture:start` with `return: true`. Move or resize any of these image objects.
- Resize in pixels or percent and keep the aspect ratio if needed. Rotate by 90° or flip the image.
- Run text recognition on a selection or the whole image. The popover shows recognized text
  and QR codes. It can copy text with or without line breaks.
- Remove the background if `native:capabilities.removeBackground` is available.
- Use ⌘C for Copy. By default, `Esc` copies and closes the editor. Use ⌘S for Save to the default
  folder or ⇧⌘S for Save As in `png`, `jpg`, or `webp`. Use the drag handle to send the image to
  another app via `image:start-drag`.
- Pin an image with ⌘P via `pin:create`, open it in its default app, or export a before-and-after
  GIF of the original and annotated image. GIF export may use `src/main/ffmpeg.js`.
  Use the output format and quality from settings. If `meta.libraryId` is set, call
  `library:update-image` after Copy or Save so the library keeps the edited version.
- The top toolbar shows the tools and the current tool's properties. The bottom status bar
  shows image size, zoom, cursor position, and the color under the cursor. Tooltips show shortcuts.

### Recorder

`src/main/recording.js` exports
`{ register(), openPanel(opts?), toggle(), stop(), cancel(), isRecording(), events }`.
The renderer lives in `src/renderer/recorder/**`.
`events` is an `EventEmitter` that emits `'state'` with
`{ status: 'idle'|'countdown'|'recording'|'paused'|'processing', startedAt, elapsedMs }`.
The core tray and hotkey modules call these functions and listen to `events`.

- The compact source picker has **Screen** for displays, **Window** for windows, and **Region**
  for an area. The first two show thumbnails. **Window** gets its thumbnails through
  `desktopCapturer`. **Region** calls `ctx.modules.capture.selectRegion({ purpose: 'record' })`
  and stores the area in `settings.recording.lastRegion` for the next recording.
- Users can switch the microphone on or off, select a device, and see its level. They can also
  switch system audio on or off. Windows uses Chromium desktop loopback for system audio.
  On macOS, Chromium loopback fails with a custom picker. See electron#52738. Use the
  ScreenCaptureKit helper through `ctx.modules.native.systemAudio.start(path)/pause()/resume()/stop()`
  and mix system audio with FFmpeg after recording. If `native.capabilities().systemAudio`
  is false, disable the toggle and explain why.
- Use `settings.recording` for MP4 or WebM format, frame rate, quality, cursor visibility, and
  countdown. The countdown overlay shows 3, 2, 1 before recording when
  `settings.recording.countdown` is on.
- Record in a hidden worker window with `backgroundThrottling: false`. Get the stream with
  `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`.
  To crop a region, read frames with `MediaStreamTrackProcessor`, create
  `new VideoFrame(frame, { visibleRect })`, and pass each frame to `MediaStreamTrackGenerator`.
  Use even widths and heights. Mix audio with WebAudio. Use `MediaRecorder` with
  `video/mp4;codecs=avc1.640028,mp4a.40.2` when available and WebM otherwise. Stream chunks to the
  main process and append them to a temporary file so the app never holds the whole video in memory.
- After recording stops, use FFmpeg to make a seekable file with `+faststart` and mix in macOS system audio.
  Save to `settings.recording.saveFolder` using `settings.recording.fileNameTemplate`.
  Open the result in the video editor at `recorder/editor`. The editor previews, trims, crops,
  resizes, converts to MP4, WebM, MOV, MKV, GIF, M4A, or MP3, and changes frame rate, mute, or speed.
  `openVideoEditor(file)` opens an existing video. Choose "Open video..." in the tray menu.
- During recording, show a small floating control bar with a timer and controls for pause,
  resume, stop, microphone mute, and discard. Draw a click-through dashed frame around the
  recorded region. Call `setContentProtection(true)` on all recorder windows to keep them
  out of the recording. Keep `powerSaveBlocker` active.
- The core module `src/main/ffmpeg.js` provides `ffmpegPath()` and `run(args, { onStderr })`, which returns a Promise.
  The latter returns a Promise.

### Native helper

`src/main/native/index.js` exports the functions below. They are asynchronous unless noted.
The module must load without throwing. Its macOS implementation lives in `native/mac/` and
`resources/bin/mac/`.

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

- On macOS, `native/mac/build.sh` builds the Swift command-line helper from `native/mac/*.swift`
  into the universal binary `resources/bin/mac/kadr-helper`. The deployment target is macOS 13.
  The helper runs as a long-lived child process and exchanges JSON lines over standard input
  and output. It uses CGWindowList, ScreenCaptureKit with `SCScreenshotManager` on macOS 14 and
  later and `SCStream` for audio, Vision for text and barcodes and
  `VNGenerateForegroundInstanceMaskRequest` on macOS 14 and later, and CGEvent for scrolling.
- On Windows, an Electron `utilityProcess` runs `src/main/native/win-worker.js`. The worker uses
  prebuilt `koffi` as its foreign function interface to call Win32 APIs. It calls `EnumWindows`,
  `DwmGetWindowAttribute` for extended frame bounds, `GetWindowThreadProcessId`, and `SendInput`
  for wheel events. It can also call `PrintWindow` to capture a covered window. The main process
  converts rectangles from physical pixels to device-independent pixels with
  `screen.screenToDipRect(null, rect)`. The app must keep running if the utility process crashes.

## Storage and renderer access

- Save original images with `atomic-file.writeFileAtomic`. Keep two current atomic JSON copies
  of settings and the library index, with the second in `.bak`. Keep malformed JSON as
  `.corrupt-*` before recovering.
- Clear text recognition results from memory and both index copies before replacing library
  pixels. Apply results only if they match the current image revision. Before quitting,
  `library.flushForQuit()` waits for pending image writes and the final index write. It skips
  starting or waiting for background text recognition. Each quit retry uses its bypass once.
  This keeps canceled closes from skipping later saves.
- The main process checks the registered window, exact renderer URL, top frame, and list of
  channels allowed for the page. Keep the public channels in the sandboxed preload and
  `ipc-policy.json` in sync when adding an API.
- File operations need a path grant for the specific window. The grant comes from a native file
  picker, a dropped File verified in preload, or an open or export in the main process.
  The generic bridge cannot grant paths or move arbitrary files to the trash.
- Grant clipboard permissions to clipboard pages, audio and capture permissions to recorder
  pages, and video-only media access to the scrolling capture worker. Online translation
  requires native confirmation that names Google and says what text will be sent.
- `npm test` uses temporary synthetic files and mocks the native and Electron interfaces.
  Real capture and system permissions require separate tests.

## Editor and library operation ordering

- Show an error page if the source image fails to decode. Do not open a blank editable document.
- Commit inline text before encoding or checking the cache. Concurrent requests for the same
  encoding share one promise. Copy or Save can clear the unsaved state or close the editor only
  if the exported revision is still current. Encode files and library images from the same
  immutable canvas.
- Ask before closing an editor with unsaved changes. Copying the current revision delivers the
  screenshot, so Esc can close its editor. A file opened from disk stays marked as unsaved
  after a copy if it had unsaved changes.
- Use one queue per library item for replacement, deletion, and removal under retention
  settings. If deletion queues during replacement, remove the image and thumbnail after the
  replacement finishes. Background text recognition keeps one pending timer and the
  latest queued revision per item.
- Before copying an audio stream during export, check the selected track's codec. Imported
  files can contain tracks with different codecs.
- Require explicit preparation of translation languages. After preparation succeeds, retry the
  native in-image translation request once. Skip the interface check that prevents overlapping requests and reuse the text recognition result. Check the generation of settings responses and refresh model availability on focus.

## Requirements from the 2026-11-09 audit

- Queue automatic screenshot saves by directory through `basics.saveBytes`. This prevents
  concurrent windows from choosing the same output name before an atomic write finishes.
- The library index accepts only the item's own `id.png` and `id.thumb.jpg`. At startup, the
  library reconciles unindexed PNGs even if the old index is valid. It also repairs missing
  or incomplete thumbnails. Redaction removes the old thumbnail before it replaces the
  pixels, so a failed thumbnail write cannot reveal old pixels.
- Mark text input and backdrop changes as unsaved immediately. Use one queue for Copy and Save.
  Check document and base image revisions before applying asynchronous pixel changes or text
  recognition results used for redaction.
- Tie the selection overlay and scrolling capture worker to their session. Release pending work
  on close, renderer failure, load failure, or timeout. Reject fallback sources with a different
  known display ID. For screenshots and recordings, use position in the list if a complete
  older source list has no IDs.
- Wait for pending file and audio setup before the recorder returns to idle. Reserve the video
  document before asynchronous import, delete, or export work. When reading video dimensions,
  account for right-angle rotation.
- Keep raw, audio, and finished files in `recordings-tmp` if probing or delivery fails.
  Remove ordinary intermediates after successful full delivery. This version has no automatic
  recovery of separate audio and no recovery manager. Repeated failures can leave files that
  need manual review.
- Use the 11.0.1 override for `minimatch@>=7 <11.0.1` to address GHSA-g3hv-75wg-m249.
  Versions 3 and 5 keep their callable APIs. Revisit the override when electron-builder's
  transitive constraints include the fix.
- To check the renderer, run `npx --no-install electron test/integration/editor-benchmark.cjs`.
  It writes synthetic PNGs, screenshots of the interface, and JSON to the `kadr-audit-visuals`
  folder in the operating system's temporary directory by default. You can specify another
  output directory as an argument. The script takes one sample per size. Capture latency and
  steady-state memory use require separate measurements.
