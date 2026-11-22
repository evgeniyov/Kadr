'use strict';
// Generic, namespace-restricted IPC bridge. Renderers use window.kadr.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

const CHANNELS = {
  "invoke": [
    "app:choose-file",
    "app:choose-folder",
    "app:confirm",
    "app:hotkey-status",
    "app:locale",
    "app:open-external",
    "app:open-library",
    "app:open-path",
    "app:permissions",
    "app:request-permission",
    "app:reveal",
    "app:suspend-hotkeys",
    "app:version",
    "capture:start",
    "clipboard:read-image",
    "clipboard:read-text",
    "clipboard:write-image",
    "clipboard:write-text",
    "editor:close-save-finished",
    "editor:dirty",
    "editor:export-gif",
    "editor:import-image",
    "editor:ready",
    "editor:save-original",
    "image:open-with-default",
    "image:save",
    "library:clear",
    "library:copy",
    "library:delete",
    "library:list",
    "library:open",
    "library:pin",
    "library:reveal",
    "library:update-image",
    "native:capabilities",
    "native:ocr",
    "native:prepare-translation",
    "native:remove-bg",
    "native:translate",
    "native:translate-list",
    "native:translation-status",
    "native:web-translate",
    "overlay:cancel",
    "overlay:copy-color",
    "overlay:done",
    "overlay:frozen",
    "overlay:ready",
    "pin:copy",
    "pin:create",
    "pin:edit",
    "pin:menu",
    "pin:move-by",
    "pin:opacity-by",
    "pin:reset-size",
    "pin:save",
    "pin:zoom",
    "preview:copy",
    "preview:edit",
    "preview:pin",
    "preview:save",
    "recorder:chunk",
    "recorder:control",
    "recorder:delete",
    "recorder:editor-info",
    "recorder:editor-open",
    "recorder:export",
    "recorder:export-cancel",
    "recorder:file-exists",
    "recorder:get-state",
    "recorder:open-editor",
    "recorder:open-privacy",
    "recorder:panel-init",
    "recorder:request-screen-access",
    "recorder:select-region",
    "recorder:sources",
    "recorder:start",
    "recorder:stem-chunk",
    "recorder:stub-done",
    "recorder:video-url",
    "recorder:worker-event",
    "scroll:cancel",
    "scroll:finish",
    "scroll:start-auto",
    "settings:get",
    "settings:reset",
    "settings:set",
    "win:close",
    "win:focus",
    "win:hide",
    "win:params",
    "win:set-ignore-mouse",
    "win:show"
  ],
  "send": [
    "image:start-drag",
    "library:start-drag",
    "preview:start-drag",
    "scroll:reply"
  ],
  "on": [
    "editor:save-and-close",
    "library:changed",
    "overlay:image",
    "overlay:reset",
    "overlay:start",
    "overlay:windows",
    "recorder:cmd",
    "recorder:countdown-go",
    "recorder:export-progress",
    "recorder:level",
    "recorder:panel-mode",
    "recorder:state",
    "scroll:finish",
    "scroll:grab",
    "scroll:init",
    "scroll:message",
    "scroll:progress",
    "scroll:ready",
    "settings:changed",
    "settings:tab"
  ]
};

function check(mode, channel) {
  if (typeof channel !== 'string' || !CHANNELS[mode].includes(channel)) throw new Error('IPC channel not allowed');
}

contextBridge.exposeInMainWorld('kadr', {
  platform: process.platform,
  invoke(channel, ...args) {
    check('invoke', channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    check('send', channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, cb) {
    check('on', channel);
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Drop cached resources (e.g. decoded screenshots) after a long-lived window is done with them.
  clearCache() {
    webFrame.clearCache();
  },
  // Absolute path of a File from a drop event / <input type=file>.
  pathForFile(file) {
    try {
      const path = webUtils.getPathForFile(file);
      if (path) ipcRenderer.send('app:grant-file', path);
      return path;
    } catch {
      return '';
    }
  },
});
