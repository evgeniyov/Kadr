'use strict';

// Match the document pages in settings-window.js; overlays and toolbars are not documents.
const DOCUMENT_PAGES = new Set(['editor', 'library', 'settings', 'recorder/editor']);

function activate(ctx) {
  const windows = [...ctx.registry.values()]
    .filter(({ page, win }) => DOCUMENT_PAGES.has(page) && !win.isDestroyed()
      && (win.isVisible() || win.isMinimized()))
    .map(({ win }) => win);
  // A hidden prepared editor must stay hidden until its capture is ready.
  const win = windows.find((w) => w.isFocused())
    || windows.find((w) => w.isVisible()) || windows[0];
  if (!win) return ctx.modules.settingsWindow?.open();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

module.exports = activate;
