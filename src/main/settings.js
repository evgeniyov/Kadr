'use strict';
// Persistent settings store (JSON in userData). Modules may register extra
// defaults for their own section via registerDefaults().

const fs = require('fs');
const { readJson, writeJsonSync } = require('./atomic-file');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { EventEmitter } = require('events');
const { isDeepStrictEqual } = require('util');

const isMac = process.platform === 'darwin';
const mod = isMac ? 'Command' : 'Control';

function baseDefaults() {
  return {
    language: 'system', // 'system' | 'ru' | 'en'
    launchAtLogin: false,
    // macOS: Kadr is in the Dock and ⌘Tab while one of its windows is open; this keeps it there
    // for good. (Replaces the old `showDockIcon`, which predates that and is ignored now.)
    alwaysShowDockIcon: false,
    showTrayIcon: true, // menu-bar (macOS) / tray (Windows) icon
    afterCapture: 'editor', // 'editor' | 'preview' | 'none'
    copyAfterCapture: true,
    saveAfterCapture: false,
    saveFolder: path.join(app.getPath('pictures'), 'Kadr'),
    fileNameTemplate: 'Kadr {YYYY}-{MM}-{DD} в {HH}.{mm}.{ss}',
    imageFormat: 'png', // 'png' | 'jpg' | 'webp'
    jpgQuality: 90,
    downscaleRetina: false,
    captureCursor: false,
    detectBlocks: true, // highlight posts, cards, pictures inside windows in the selection overlay
    playSound: true,
    previewTimeout: 6, // seconds, 0 = keep
    deepLinks: false, // kadr:// URL commands (automation)
    firstRunDone: false,
    screenAccessRequestedFor: '', // build id that already asked for Screen Recording
    screenAccessConfirmedFor: '',
    windowCapture: {
      shadow: true, // macOS: keep native window shadow (transparent PNG)
      backdrop: false, // open with backdrop (window with embedded background)
    },
    scrolling: {
      maxHeight: 30000, // px
      auto: true, // auto-scroll; false = manual scrolling
      step: 0.6, // fraction of region height scrolled per step
    },
    translateTo: 'ru', // target language for "Translate" (text already in it goes to English)
    colorFormat: 'hex', // hex | HEX | rgb | hsl | css-rgba | swiftui | uicolor | android | csharp | flutter
    library: {
      enabled: true,
      maxItems: 1000,
      keepDays: 0, // 0 = forever
    },
    pin: {
      opacity: 1,
      shadow: true,
    },
    hotkeys: {
      area: `${mod}+Shift+2`,
      fullscreen: `${mod}+Shift+1`,
      window: `${mod}+Shift+7`,
      activeWindow: '',
      repeatArea: '',
      scrolling: `${mod}+Shift+8`,
      ocr: `${mod}+Shift+9`,
      translate: '',
      colorPicker: '',
      delayed: '',
      record: `${mod}+Shift+0`,
      recordStop: '',
      openClipboard: '',
      pinClipboard: '',
      library: '',
      settings: '',
    },
    editor: {
      tool: 'arrow',
      color: '#FF3B30',
      size: 3, // 1..6 preset index
      customColors: [],
      arrowStyle: 'classic', // classic | curved | double | thin
      rectFill: 'outline', // outline | semi | solid
      textStyle: 'outline', // plain | outline | box
      concealType: 'pixelate', // pixelate | blur | erase | pixelate-text | blur-text | erase-text
      lineStyle: 'solid', // solid | dashed | dotted
      backdrop: {
        enabled: false,
        type: 'gradient', // gradient | solid | image | transparent
        gradient: 3, // preset index
        gradientFrom: '#7F7FD5',
        gradientTo: '#91EAE4',
        gradientAngle: 135,
        solid: '#E9E9EF',
        imagePath: '',
        padding: 64,
        innerRadius: 12,
        outerRadius: 0,
        shadow: 0.5,
        ratio: 'auto', // auto | 16:9 | 4:3 | 1:1 | 3:2 | 9:16 | twitter | ...
        autocrop: false,
      },
    },
    recording: {
      format: 'mp4', // mp4 | webm
      fps: 30, // 24 | 30 | 60
      quality: 'high', // low | medium | high | max
      mic: true,
      micDeviceId: 'default',
      micVolume: 1,
      systemAudio: false,
      systemVolume: 1,
      showCursor: true,
      countdown: 3, // seconds, 0 = off
      saveFolder: path.join(app.getPath(isMac ? 'videos' : 'videos'), 'Kadr'),
      fileNameTemplate: 'Kadr Запись {YYYY}-{MM}-{DD} в {HH}.{mm}.{ss}',
      lastMode: 'screen', // screen | window | region
      lastDisplayId: null,
      lastWindowName: '',
      lastRegion: null, // { displayId, x, y, width, height } in DIP
      afterRecording: 'preview', // preview | reveal | none
      hideControlsWhileRecording: false,
    },
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, src) {
  if (!isObj(src)) throw new Error('settings patch must be an object');
  for (const k of Object.keys(src)) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error('unsafe settings key');
    if (isObj(src[k]) && isObj(target[k])) deepMerge(target[k], src[k]);
    else target[k] = src[k];
  }
  return target;
}

// Fill missing keys of obj from defaults (recursively), keeping existing values.
function fillDefaults(obj, defs) {
  for (const k of Object.keys(defs)) {
    if (!(k in obj)) obj[k] = structuredClone(defs[k]);
    else if (isObj(defs[k]) && isObj(obj[k])) fillDefaults(obj[k], defs[k]);
  }
  return obj;
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.defaults = baseDefaults();
    this.data = structuredClone(this.defaults);
    this._saveTimer = null;
    const loaded = readJson(this.file, isObj);
    if (loaded.data) this.data = fillDefaults(loaded.data, this.defaults);
  }

  registerDefaults(section, defs) {
    this.defaults[section] = deepMerge(this.defaults[section] || {}, defs);
    if (!isObj(this.data[section])) this.data[section] = {};
    fillDefaults(this.data[section], this.defaults[section]);
  }

  get(keyPath) {
    if (!keyPath) return this.data;
    return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  // patch: deep partial object, e.g. { editor: { color: '#fff' } }
  set(patch) {
    deepMerge(this.data, patch);
    this._publishChange(patch);
    return this.data;
  }

  _publishChange(patch) {
    this._scheduleSave();
    this.emit('change', this.data, patch);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings:changed', this.data, patch);
    }
  }

  // set a single dotted key
  setKey(keyPath, value) {
    const patch = {};
    const keys = keyPath.split('.');
    let o = patch;
    keys.slice(0, -1).forEach((k) => (o = o[k] = {}));
    o[keys[keys.length - 1]] = value;
    // arrays/objects at leaf should replace, not merge
    return this.set(patch);
  }

  reset() {
    const next = structuredClone(this.defaults);
    const keys = new Set([...Object.keys(this.data), ...Object.keys(next)]);
    const patch = Object.fromEntries([...keys]
      .filter((key) => !isDeepStrictEqual(this.data[key], next[key]))
      .map((key) => [key, next[key]]));
    this.data = next;
    this._publishChange(patch);
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonSync(this.file, this.data);
    } catch (e) {
      console.error('settings save failed', e);
    }
  }
}

module.exports = { Settings, deepMerge };
