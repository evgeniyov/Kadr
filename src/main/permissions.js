'use strict';
// macOS privacy permissions: make Kadr show up in System Settings on its own, and survive
// System Settings' "Quit & Reopen" after the user grants Screen Recording.

const fs = require('fs');
const { app, shell, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const ctx = require('./context');

const PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

let startedWithoutScreen = false;
let quitByUser = false;
let relauncherSpawned = false;

const screenGranted = () => systemPreferences.getMediaAccessStatus('screen') === 'granted';

function bundlePath() {
  const m = /^(.*?\.app)\//.exec(process.execPath);
  return m ? m[1] : null;
}

// Screen Recording: system prompt + Kadr listed in System Settings, then open that pane.
async function requestScreen({ openPane = true } = {}) {
  if (!ctx.isMac || screenGranted()) return true;
  let granted = false;
  try {
    granted = await ctx.modules.native?.requestScreenAccess?.();
  } catch (e) {
    console.warn('[permissions] screen request failed', e.message);
  }
  if (!granted && openPane) shell.openExternal(PANES.screen);
  return granted;
}

async function request(kind) {
  if (!ctx.isMac) return true;
  if (kind === 'screen' || kind === 'screen-settings') return requestScreen();
  if (kind === 'accessibility') {
    if (systemPreferences.isTrustedAccessibilityClient(false)) return true;
    const ok = systemPreferences.isTrustedAccessibilityClient(true);
    if (!ok) shell.openExternal(PANES.accessibility);
    return ok;
  }
  if (kind === 'accessibility-settings') return shell.openExternal(PANES.accessibility);
  if (kind === 'microphone') {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
    shell.openExternal(PANES.microphone);
    return false;
  }
  if (kind === 'microphone-settings') return shell.openExternal(PANES.microphone);
  return false;
}

// After granting Screen Recording, System Settings offers "Quit & Reopen". It relaunches the
// app while the old process is still shutting down, LaunchServices routes the launch to the
// dying process and nothing comes back. A tiny detached script waits for our exit and opens
// Kadr again if nobody else did.
function spawnRelauncher() {
  const bundle = bundlePath();
  if (!bundle || relauncherSpawned) return;
  relauncherSpawned = true;
  const script = [
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
    'sleep 1.2',
    `pgrep -f "$KADR_EXE" >/dev/null || /usr/bin/open "$KADR_APP"`,
  ].join('\n');
  try {
    spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', KADR_EXE: process.execPath, KADR_APP: bundle },
    }).unref();
  } catch (e) {
    console.warn('[permissions] relauncher failed', e.message);
  }
}

// Quits initiated from Kadr's own UI (tray, menus) never relaunch.
function quitApp() {
  quitByUser = true;
  app.quit();
}

function register() {
  if (!ctx.isMac) return;
  startedWithoutScreen = !screenGranted();

  app.on('before-quit', () => {
    // An outside quit (System Settings' "Quit & Reopen", Dock) of an app that started without
    // Screen Recording access: that is the permission restart — make sure we come back.
    if (startedWithoutScreen && !quitByUser && app.isPackaged) spawnRelauncher();
  });

  // First launch after the user granted access (and we restarted): confirm it worked.
  if (!startedWithoutScreen && ctx.settings.get('screenAccessRequestedFor') && ctx.settings.get('screenAccessConfirmedFor') !== ctx.settings.get('screenAccessRequestedFor')) {
    ctx.settings.set({ screenAccessConfirmedFor: ctx.settings.get('screenAccessRequestedFor') });
    ctx.notify(ctx.t('notify.screenReady'), ctx.t('notify.screenReadyBody'));
  }

  // Permission prompts are initiated only by an explicit user action. Launching
  // an updated build must never reset privacy entries or request new access.

}

module.exports = { register, request, requestScreen, quitApp, PANES };
