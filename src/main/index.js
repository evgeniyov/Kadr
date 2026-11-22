'use strict';
// Kadr — application entry point.

const { app, session, nativeTheme, Menu } = require('electron');
const path = require('path');
const protocol = require('./protocol');
const activate = require('./activate');
const security = require('./security');

protocol.registerSchemeAsPrivileged();

// Single instance: a second launch activates the running app or opens the supplied file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => {});

// Files opened with Kadr ("Open With", double click, drop on the Dock icon) and kadr://
// deep links may arrive before the app is ready; queue them until the modules are loaded.
const OPENABLE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|mp4|mov|m4v|webm|mkv|avi)$/i;
const pendingFiles = [];
function handleFile(file) {
  const tray = require('./context').modules.tray;
  if (tray?.openAnyFile) tray.openAnyFile(file);
  else pendingFiles.push(file);
}
// Windows passes files on the command line.
function filesFromArgv(argv) {
  const fs = require('fs');
  return argv.slice(1).filter((a) => !a.startsWith('-') && OPENABLE.test(a) && fs.existsSync(a));
}
app.on('open-file', (e, file) => {
  e.preventDefault();
  handleFile(file);
});

const pendingUrls = [];
function handleUrl(url) {
  const dl = require('./context').modules.deeplinks;
  if (dl) dl.run(url);
  else pendingUrls.push(url);
}
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleUrl(url);
});

const ctx = require('./context');

function safeRequire(name) {
  try {
    return require(name);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(name.replace('./', ''))) {
      console.warn(`[kadr] module ${name} is not available yet`);
      return null;
    }
    console.error(`[kadr] failed to load ${name}`, e);
    return null;
  }
}

// Temporary captures/exports are only needed while their window is open; drop old ones.
function cleanupOldFiles() {
  const fs = require('fs');
  const now = Date.now();
  const walk = (dir, maxAgeMs) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        const st = fs.lstatSync(p);
        if (e.isDirectory()) walk(p, maxAgeMs);
        else if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch {
        /* in use or gone */
      }
    }
  };
  walk(ctx.paths.captures, 2 * 86400000);
  walk(ctx.paths.tmp, 86400000);
}

function devArg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function start() {
  ctx.applyLang();
  ctx.settings.on('change', (s, patch) => {
    if ('language' in patch) ctx.applyLang();
  });

  protocol.handle({ appRoot: ctx.paths.appRoot, userData: ctx.paths.userData });
  setTimeout(cleanupOldFiles, 15000);

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(security.permissionAllowed(wc, ctx.entryFor(wc), permission, details));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return security.permissionAllowed(wc, wc && ctx.entryFor(wc), permission, { ...details, requestingOrigin });
  });

  if (ctx.isMac && !ctx.settings.get('alwaysShowDockIcon')) app.dock?.hide();
  // macOS routes ⌘C/⌘V/⌘Z in text fields through the application menu.
  // Its Quit goes through permissions.quitApp so a user quit is never mistaken for a
  // System Settings "Quit & Reopen".
  const quit = () => (ctx.modules.permissions ? ctx.modules.permissions.quitApp() : app.quit());
  Menu.setApplicationMenu(
    ctx.isMac
      ? Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: ctx.t('action.quit'), accelerator: 'Command+Q', click: quit }],
          },
          {
            role: 'fileMenu',
            submenu: [
              { label: ctx.t('action.openFile'), accelerator: 'CommandOrControl+O', click: () => ctx.modules.tray?.openFile?.() },
              { type: 'separator' },
              { role: 'close' },
            ],
          },
          { role: 'editMenu' },
          { role: 'windowMenu' },
        ])
      : null
  );

  const modules = {
    basics: require('./basics'),
    permissions: safeRequire('./permissions'),
    native: safeRequire('./native'),
    ocr: safeRequire('./ocr'),
    translate: safeRequire('./translate'),
    library: safeRequire('./library'),
    capture: safeRequire('./capture'),
    scrollCapture: safeRequire('./scroll-capture'),
    preview: safeRequire('./preview'),
    pin: safeRequire('./pin'),
    editor: safeRequire('./editor'),
    recording: safeRequire('./recording'),
    settingsWindow: safeRequire('./settings-window'),
    deeplinks: safeRequire('./deeplinks'),
    tray: safeRequire('./tray'),
    hotkeys: safeRequire('./hotkeys'),
  };
  Object.assign(ctx.modules, modules);

  for (const [name, m] of Object.entries(modules)) {
    if (!m || typeof m.register !== 'function') continue;
    try {
      await m.register();
    } catch (e) {
      console.error(`[kadr] ${name}.register() failed`, e);
    }
  }
  modules.native
    ?.init?.()
    .then(() => warmUpOcr(modules.native))
    .catch((e) => console.error('[kadr] native init failed', e));
  pendingUrls.splice(0).forEach(handleUrl);
  [...pendingFiles.splice(0), ...filesFromArgv(process.argv)].forEach(handleFile);

  // Developer shortcuts: `npm run dev -- --open-editor=/path/img.png`, `--open=recorder|settings|library`
  const img = devArg('open-editor');
  if (img && modules.editor) {
    const fs = require('fs');
    const dst = path.join(ctx.paths.captures, `${ctx.newId()}.png`);
    fs.copyFileSync(path.resolve(img), dst);
    modules.editor.openEditor({ imagePath: dst, scale: Number(devArg('scale') || 2), meta: { source: 'file' } });
  }
  const open = devArg('open');
  if (open === 'recorder') modules.recording?.openPanel();
  if (open === 'settings') modules.settingsWindow?.open();
  if (open === 'library') modules.library?.openWindow();
  const cap = devArg('capture');
  if (cap) modules.capture?.start({ mode: cap });

  // Test harness: `electron . --dev --dev-script=/abs/script.js`
  // script: module.exports = async (ctx, helpers) => { ... }  (helpers.shot(win, file), helpers.wait(ms), helpers.quit())
  // Only for development builds (or packaged builds explicitly started with KADR_DEV=1).
  const script = !app.isPackaged || process.env.KADR_DEV === '1' ? devArg('dev-script') : null;
  if (script) {
    const helpers = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      async shot(win, file) {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(file, img.toPNG());
        return file;
      },
      exec: (win, code) => win.webContents.executeJavaScript(code, true),
      quit: () => app.exit(0),
    };
    try {
      await require(path.resolve(script))(ctx, helpers);
    } catch (e) {
      console.error('[dev-script] failed', e);
      app.exit(1);
    }
  }

  nativeTheme.on('updated', () => modules.tray?.refresh?.());

  // First launch: show where the app lives and open settings (permissions, shortcuts).
  if (!ctx.settings.get('firstRunDone') && !script) {
    ctx.settings.set({ firstRunDone: true });
    modules.settingsWindow?.open('general');
    ctx.notify(ctx.t('notify.welcome'), ctx.t(ctx.isMac ? 'notify.welcomeBodyMac' : 'notify.welcomeBodyWin'));
  }
}

// The first Vision OCR request compiles models (tens of seconds); do it in the background.
function warmUpOcr(native) {
  if (!native?.capabilities?.().ocr || process.argv.some((a) => a.startsWith('--dev-script='))) return;
  setTimeout(() => {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP8z4AATEhsPBwAM9EBBzDn4UwAAAAASUVORK5CYII='
    );
    native.ocr(img.resize({ width: 64 }).toPNG(), { languages: ['ru-RU', 'en-US'] }).catch(() => {});
  }, 8000);
}

app.on('second-instance', (e, argv) => {
  const url = argv.find((a) => a.startsWith('kadr://'));
  const files = filesFromArgv(argv);
  if (url) handleUrl(url);
  else if (files.length) files.forEach(handleFile);
  else activate(ctx);
});

// macOS: Dock/Finder activation returns to an existing document when possible.
app.on('activate', () => activate(ctx));

app.whenReady().then(start);

let libraryFlushed = false;
let quitFlush = null;
app.on('before-quit', (event) => {
  if (libraryFlushed) {
    // Permit only the retry below: a document or recording can cancel this quit.
    libraryFlushed = false;
    quitFlush = null;
    return;
  }
  if (!ctx.modules.library) return;
  event.preventDefault();
  if (quitFlush) return;
  quitFlush = ctx.modules.library.flushForQuit().then(() => {
    libraryFlushed = true;
    app.quit();
  }).catch((e) => {
    console.error('[library] cannot flush before quit', e);
    quitFlush = null;
    ctx.notify(ctx.t('common.error'), ctx.t('library.saveFailed'));
  });
});

app.on('will-quit', () => {
  try {
    require('electron').globalShortcut.unregisterAll();
    ctx.modules.native?.shutdown?.();
    ctx.settings.saveNow();
  } catch {
    /* ignore */
  }
});
