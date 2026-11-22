'use strict';
// Video editor / exporter windows (also used as the post-recording result window)
// and kadr:// URLs for arbitrary video files.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, dialog, shell } = require('electron');
const ctx = require('../context');
const ffmpeg = require('../ffmpeg');
const post = require('./post');
const ui = require('./windows');
const plan = require('../../renderer/recorder/shared/export-plan.mjs');
const { sanitizeSpec } = require('./export-spec');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ogv']);
const editors = new Map(); // webContents.id → { win, file, raw, job: AbortController | null }
const linksByOwner = new Map(); // webContents.id → Set<link path>

const t = (k, v) => ctx.t(k, v);
const unlinkQuiet = (f) => f && fs.promises.unlink(f).catch(() => {});
const videosDir = () => path.join(ctx.paths.tmp, 'videos');

// ---- kadr:// URLs for files outside userData ------------------------------------
// The protocol only serves userData, so the file is exposed through a symlink
// (hard link as a fallback on Windows without symlink rights) that lives as long as
// the renderer that asked for it. Range requests pass through net.fetch → seeking works.
function videoUrl(file, owner) {
  const ext = path.extname(file).toLowerCase();
  if (!VIDEO_EXT.has(ext) || !fs.existsSync(file)) return null;
  fs.mkdirSync(videosDir(), { recursive: true });
  const link = path.join(videosDir(), `${ctx.newId()}${ext}`);
  let made = false;
  for (const make of [() => fs.symlinkSync(file, link, 'file'), () => fs.linkSync(file, link)]) {
    try {
      make();
      made = true;
      break;
    } catch {
      /* try the next way */
    }
  }
  if (!made) return null;
  if (owner) {
    let set = linksByOwner.get(owner.id);
    if (!set) {
      set = new Set();
      linksByOwner.set(owner.id, set);
      const id = owner.id;
      owner.once('destroyed', () => {
        for (const l of linksByOwner.get(id) || []) unlinkQuiet(l);
        linksByOwner.delete(id);
      });
    }
    set.add(link);
  }
  return ctx.dataUrl(link);
}

// ---- editor windows ----------------------------------------------------------------

async function describe(file) {
  const [info, st] = await Promise.all([post.probe(file), fs.promises.stat(file)]);
  return { file, name: path.basename(file), size: st.size, ...info };
}

async function openVideoEditor(filePath, { raw = false } = {}) {
  const file = path.resolve(String(filePath || ''));
  let info;
  try {
    info = await describe(file);
  } catch (err) {
    info = null;
    console.error('[recorder] cannot open video', file, err.message);
  }
  if (!info?.video) {
    ctx.notify(t('recorder.editor.openFailed'), path.basename(file));
    return null;
  }
  const win = ui.createEditor({ ...info, raw, platform: process.platform });
  ctx.grantPath(win.webContents, file);
  const id = win.webContents.id;
  editors.set(id, { win, file, raw, job: null });
  win.on('closed', () => {
    editors.get(id)?.job?.abort();
    editors.delete(id);
  });
  return win;
}

function editorOf(sender) {
  return editors.get(sender.id) || null;
}

// ---- export --------------------------------------------------------------------------

async function chooseTarget(sender, ed, format, target) {
  const f = plan.FORMATS[format];
  const dir = path.dirname(ed.file);
  const base = path.basename(ed.file, path.extname(ed.file));
  if (target === 'replace') {
    if (path.extname(ed.file).slice(1).toLowerCase() !== f.ext) return { error: 'replace-format' };
    return { final: ed.file, replace: true };
  }
  const copyBase = `${base} ${t('recorder.editor.suffix')}`;
  if (target !== 'saveAs') return { copyTo: { dir, base: copyBase, ext: f.ext } };
  const suggested = ctx.uniquePath(dir, copyBase, f.ext);
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
    defaultPath: suggested,
    filters: [{ name: f.label, extensions: [f.ext] }],
  });
  if (res.canceled || !res.filePath) return { cancelled: true };
  const final = path.extname(res.filePath) ? res.filePath : `${res.filePath}.${f.ext}`;
  return { final, replace: path.resolve(final) === path.resolve(ed.file) };
}

async function publishCopy(tmp, { dir, base, ext }, signal) {
  for (let i = 1; ; i++) {
    signal.throwIfAborted();
    const name = i === 1 ? base : `${base} (${i})`;
    const file = path.join(dir, `${name}.${ext}`);
    try {
      // A hard link publishes the complete file atomically and fails if the name is taken.
      // Filesystems without hard links still get an exclusive copy.
      await fs.promises.link(tmp, file).catch((err) => {
        if (!['ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES', 'EMLINK'].includes(err.code)) throw err;
        signal.throwIfAborted();
        return fs.promises.copyFile(tmp, file, fs.constants.COPYFILE_EXCL);
      });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function runExport(sender, rawSpec, target) {
  const ed = editorOf(sender);
  if (!ed?.file) return { error: 'gone' };
  if (ed.job || ed.loading || ed.deleting) return { error: 'busy' };
  const ac = new AbortController();
  ed.job = ac;
  let tmp;
  let palette;
  try {
    const spec = sanitizeSpec(rawSpec);
    const src = await post.probe(ed.file);
    ac.signal.throwIfAborted();
    if (spec.audioTrack > 0 && !src.audioTracks?.[spec.audioTrack]) return { error: 'failed', message: t('recorder.error.audioTrack') };
    if (plan.FORMATS[spec.format].kind === 'audio' && !src.audio) return { error: 'no-audio' };
    const dest = await chooseTarget(sender, ed, spec.format, target);
    ac.signal.throwIfAborted();
    if (dest.error || dest.cancelled) return dest;

    // Encode next to the destination on the same volume, hidden while in progress.
    const dir = dest.copyTo?.dir ?? path.dirname(dest.final);
    const base = dest.copyTo?.base ?? path.basename(dest.final);
    tmp = path.join(dir, `.${base}.kadr-${ctx.newId()}.part.${plan.FORMATS[spec.format].ext}`);
    palette = path.join(ctx.paths.tmp, `palette-${ctx.newId()}.png`);
    const { passes, durationSec, copy } = plan.buildExportArgs(src, spec, ed.file, tmp, { palette });
    for (let i = 0; i < passes.length; i++) {
      // GIF: the palette pass is ~15% of the work.
      const [from, to] = passes.length === 2 ? (i === 0 ? [0, 0.15] : [0.15, 1]) : [0, 1];
      let last = -1;
      await ffmpeg.run(passes[i], {
        signal: ac.signal,
        onStderr: (line) => {
          const sec = ffmpeg.parseTime(line);
          if (sec == null || sender.isDestroyed()) return;
          const p = from + (to - from) * Math.min(1, durationSec > 0 ? sec / durationSec : 0);
          if (p - last >= 0.005) sender.send('recorder:export-progress', (last = p));
        },
      });
      ac.signal.throwIfAborted();
      if (!sender.isDestroyed()) sender.send('recorder:export-progress', to);
    }
    const out = await post.probe(tmp);
    ac.signal.throwIfAborted();
    const kind = plan.FORMATS[spec.format].kind;
    if (kind === 'audio' ? !out.audio : !out.video) throw new Error('the exported file is empty');
    let file = dest.final;
    if (dest.copyTo) file = await publishCopy(tmp, dest.copyTo, ac.signal);
    else await fs.promises.rename(tmp, file);
    ctx.grantPath(sender, file);
    const size = (await fs.promises.stat(file)).size;
    if (dest.replace) ed.raw = false;
    return { path: file, name: path.basename(file), size, replaced: !!dest.replace, copy, ...out };
  } catch (err) {
    if (ac.signal.aborted) return { cancelled: true };
    console.error('[recorder] export failed', err);
    return { error: 'failed', message: String(err.message || err).slice(0, 300) };
  } finally {
    await Promise.all([unlinkQuiet(tmp), unlinkQuiet(palette)]);
    ed.job = null;
  }
}

async function deleteCurrent(sender) {
  const ed = editorOf(sender);
  if (!ed?.file || ed.loading || ed.deleting) return false;
  ed.deleting = true;
  ed.job?.abort();
  try {
    await shell.trashItem(ed.file);
    ed.file = null;
    return true;
  } catch (err) {
    console.error('[recorder] trash failed', err);
    return false;
  } finally {
    ed.deleting = false;
  }
}

function register() {
  const { handle } = ctx;
  // Generic: a kadr:// URL that plays a local video file (symlink in tmp/videos).
  handle('recorder:video-url', (e, file) => videoUrl(ctx.assertPath(e.sender, file), e.sender));
  handle('recorder:open-editor', (e, file) => openVideoEditor(ctx.assertPath(e.sender, file)).then((w) => !!w));
  handle('recorder:editor-open', async (e, file) => {
    const ed = editorOf(e.sender);
    if (!ed || ed.job || ed.loading || ed.deleting || typeof file !== 'string') return { error: 'busy' };
    // Reserve the document before probing. Otherwise an export can begin with
    // the old metadata and continue with a newly assigned input path.
    ed.loading = true;
    try {
      ctx.assertPath(e.sender, file);
      const info = await describe(path.resolve(file));
      if (editorOf(e.sender) !== ed || e.sender.isDestroyed()) return { error: 'gone' };
      if (!info.video) return { error: 'not-video' };
      Object.assign(ed, { file: info.file, raw: false });
      return info;
    } catch {
      return { error: 'not-video' };
    } finally {
      ed.loading = false;
    }
  });
  handle('recorder:editor-info', async (e) => {
    const ed = editorOf(e.sender);
    return ed?.file ? { ...(await describe(ed.file).catch(() => ({}))), raw: ed.raw } : null;
  });
  handle('recorder:export', (e, spec, target) => runExport(e.sender, spec, target));
  handle('recorder:export-cancel', (e) => editorOf(e.sender)?.job?.abort());
  handle('recorder:delete', (e) => deleteCurrent(e.sender));
  handle('recorder:file-exists', (e) => {
    const f = editorOf(e.sender)?.file;
    return !!f && fs.existsSync(f);
  });
  // Links from a previous run are stale.
  fs.promises.rm(videosDir(), { recursive: true, force: true }).catch(() => {});
}

module.exports = { register, openVideoEditor, videoUrl };
