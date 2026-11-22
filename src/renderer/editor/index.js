// Annotation editor window: bootstrap and wiring of state, tools and UI.
import { initPage, kadr, t, $, el, toast, isMac, getSettings } from '../../shared/ui.js';
import { App, loadBitmap } from './app.js';
import { makeCanvas } from './doc.js';
import { OBJECT_TOOLS } from './consts.js';
import { drawOverlay } from './overlay.js';
import { attachInput } from './input.js';
import { Output, writeClipboardImage } from './output.js';
import { PixelSelection } from './selection.js';
import { WandTool, LassoTool } from './tools/selection-tools.js';
import { ObjectTool, TextTool, CounterTool } from './tools/object-tool.js';
import { CropTool, PickerTool, RulerTool, OcrTool } from './tools/special.js';
import { TextEditor } from './ui/text-editor.js';
import { buildToolbar, sc } from './ui/toolbar.js';
import { PropsBar } from './ui/props.js';
import { buildStatusBar } from './ui/statusbar.js';
import { BackdropPanel } from './ui/backdrop.js';
import { closePopovers, isModalOpen, openMenu } from './ui/popover.js';
import { showOcrResult, openResizeDialog } from './ui/dialogs.js';
import { translateImage } from './translate-image.js';
import { installTooltips } from './ui/tooltip.js';

let app;

const { params, settings } = await initPage({
  onSettings: (s, patch) => {
    if (!app) return;
    app.settings = s;
    if (patch?.editor?.customColors) {
      app.customColors = [...s.editor.customColors];
      app.emit('props');
    }
    if ('colorFormat' in (patch || {})) app.emit('cursor');
  },
});

const dom = { viewport: $('#viewport'), canvas: $('#view'), textarea: $('#text-editor') };

// Raw BGRA pixels from a fresh capture (no PNG on the way), else the image file.
function baseFromPixels({ width, height, data }) {
  const d = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < d.length; i += 4) {
    const b = d[i];
    d[i] = d[i + 2];
    d[i + 2] = b;
  }
  const c = makeCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(d, width, height), 0, 0);
  return c;
}

async function loadBase() {
  if (params.pixels) {
    const pixels = params.pixels;
    params.pixels = null; // tens of MB for a full screen: not kept around
    try {
      return baseFromPixels(pixels);
    } catch (e) {
      console.error('failed to use capture pixels', e);
    }
  }
  try {
    const img = await loadBitmap(params.imageUrl);
    const c = makeCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } catch (e) {
    console.error('failed to load image', params.imageUrl, e);
    return null;
  }
}

const loadedBase = await loadBase();
if (!loadedBase) {
  $('#app').replaceChildren(el('div.editor-load-error',
    el('p', t('editor.toast.loadFailed')),
    el('button.btn', { onclick: () => kadr.invoke('win:close') }, t('common.close')),
  ));
  kadr.invoke('editor:ready').catch(() => {});
} else {
app = new App({ params, settings, base: loadedBase, dom });
const output = new Output(app);
app.textEditor = new TextEditor(app, dom.textarea, { save: (options) => output.save(options) });
app.overlay = (g) => drawOverlay(app, g);
app.closePopovers = closePopovers;
app.modalOpen = isModalOpen;
app.caps = {};

app.pixelSelection = new PixelSelection(app, { writeClipboardImage });

// ---- tools ----------------------------------------------------------------------
app.registerTool('select', new ObjectTool(app, 'select', { hitMode: 'all' }));
for (const id of ['arrow', 'rect', 'oval', 'line', 'magnifier']) app.registerTool(id, new ObjectTool(app, id, { creates: id }));
for (const id of ['freehand', 'highlighter', 'conceal', 'spotlight']) app.registerTool(id, new ObjectTool(app, id, { creates: id, hitMode: 'selected' }));
app.registerTool('text', new TextTool(app));
app.registerTool('counter', new CounterTool(app));
app.registerTool('crop', new CropTool(app));
app.registerTool('picker', new PickerTool(app));
app.registerTool('ruler', new RulerTool(app));
app.registerTool('ocr', new OcrTool(app, (rect) => runOcr(rect)));
app.registerTool('wand', new WandTool(app));
app.registerTool('lasso', new LassoTool(app));

// ---- actions --------------------------------------------------------------------
let backdropPanel;
let closing = false;

async function runOcr(rect) {
  if (rect === undefined) {
    const o = app.selected;
    if (o && ['rect', 'oval', 'conceal', 'spotlight', 'image'].includes(o.type)) rect = { x: o.x, y: o.y, w: o.w, h: o.h };
    else return app.setTool('ocr');
  }
  toast(t('editor.ocr.working'));
  try {
    const res = await app.ocrRegion(rect);
    if (res) showOcrResult($('#props-right .ibtn') || dom.viewport, res);
  } catch (e) {
    console.warn('OCR failed', e);
    toast(t('editor.toast.ocrUnavailable'));
  }
}

async function copyAndClose() {
  if (closing) return;
  closing = true;
  try {
    if (await output.copy({ silent: true })) await kadr.invoke('win:close');
  } finally {
    closing = false;
  }
}

// Esc: close popovers → finish text editing → cancel the tool action → deselect the object →
// drop the pixel selection → copy & close.
function escape() {
  if (closePopovers()) return;
  if (app.textEditor.active) return app.textEditor.commit();
  if (app.tool?.cancel?.()) return;
  if (app.selected) return app.select(null);
  if (app.pixelSelection.deselect()) return;
  if (editingFile) return kadr.invoke('win:close'); // main asks about unsaved changes
  copyAndClose();
}

function moreItems() {
  const tr = (op) => () => output.transform(op);
  return [
    { header: t('editor.menu.export') },
    { label: t('editor.action.saveAsPng'), icon: 'save', shortcut: sc('S', true), onClick: () => output.save({ saveAs: true, format: 'png' }) },
    { label: t('editor.action.saveAsJpg'), onClick: () => output.save({ saveAs: true, format: 'jpg' }) },
    { label: t('editor.action.saveAsWebp'), onClick: () => output.save({ saveAs: true, format: 'webp' }) },
    { label: t('editor.action.gif'), icon: 'gif', onClick: () => output.exportGif() },
    { label: t('editor.action.openDefault'), icon: 'external', onClick: () => output.openDefault() },
    'sep',
    { header: t('editor.menu.image') },
    { label: t('editor.action.resize'), icon: 'resize', onClick: () => openResizeDialog(app, (width, height) => output.transform({ kind: 'resize', width, height })) },
    { label: t('editor.action.crop'), icon: 'crop', shortcut: 'X', onClick: () => app.setTool('crop') },
    { label: t('editor.action.rotateLeft'), icon: 'rotateLeft', onClick: tr({ kind: 'rotate', dir: 'ccw' }) },
    { label: t('editor.action.rotateRight'), icon: 'rotateRight', onClick: tr({ kind: 'rotate', dir: 'cw' }) },
    { label: t('editor.action.flipH'), icon: 'flipH', onClick: tr({ kind: 'flip', axis: 'h' }) },
    { label: t('editor.action.flipV'), icon: 'flipV', onClick: tr({ kind: 'flip', axis: 'v' }) },
    { label: t('editor.action.removeBg'), icon: 'removeBg', onClick: () => output.removeBackground() },
    { label: t('editor.action.translateImage'), icon: 'translate', onClick: runTranslateImage },
    { label: t('editor.sel.all'), icon: 'marqueeRect', shortcut: sc('A'), onClick: () => app.pixelSelection.selectAll() },
    'sep',
    { label: t('editor.action.copyClose'), shortcut: 'Esc', onClick: copyAndClose },
    { label: t('editor.action.closeNoCopy'), shortcut: sc('W'), onClick: () => kadr.invoke('win:close') },
  ];
}

function contextMenu(e, o) {
  const at = { x: e.clientX, y: e.clientY };
  if (!o) {
    openMenu(null, [
      { label: t('editor.action.paste'), icon: 'addCapture', shortcut: sc('V'), onClick: () => output.paste() },
      { label: t('editor.action.copy'), icon: 'copy', shortcut: sc('C'), onClick: () => output.copy() },
      { label: t('editor.action.save'), icon: 'save', shortcut: sc('S'), onClick: () => output.save() },
    ], { at });
    return;
  }
  const items = [];
  if (o.type === 'text' || o.type === 'counter') items.push({ label: t(o.type === 'text' ? 'editor.action.editText' : 'editor.action.editLabel'), onClick: () => app.textEditor.begin(o) }, 'sep');
  items.push(
    { label: t('editor.action.duplicate'), icon: 'duplicate', shortcut: sc('D'), onClick: () => app.duplicateSelected() },
    'sep',
    { label: t('editor.action.front'), shortcut: sc(']', true), onClick: () => app.arrangeSelected('front') },
    { label: t('editor.action.forward'), shortcut: sc(']'), onClick: () => app.arrangeSelected('forward') },
    { label: t('editor.action.backward'), shortcut: sc('['), onClick: () => app.arrangeSelected('backward') },
    { label: t('editor.action.back'), shortcut: sc('[', true), onClick: () => app.arrangeSelected('back') },
    'sep',
    { label: t('editor.action.delete'), icon: 'trash', shortcut: '⌫', danger: true, onClick: () => app.deleteSelected() },
  );
  openMenu(null, items, { at });
}

// Editing a file opened from disk (not a fresh screenshot).
const editingFile = !!params.meta?.filePath;

// ⌘C / Copy button: a pixel selection copies just that fragment and keeps editing;
// otherwise the whole image is copied and — like Shottr — the editor closes (setting).
// Opened files stay open: they are saved with ⌘S, not "copied and done".
function copy() {
  if (app.pixelSelection.active) return app.pixelSelection.copy();
  if (!editingFile && getSettings().editor?.closeOnCopy !== false) return copyAndClose();
  return output.copy();
}

// Translation languages are missing: macOS asks to download them, then we try again.
async function needLanguages(res) {
  const ok = await kadr.invoke('app:confirm', { message: t('editor.trImg.needLanguages'), detail: t('editor.ocr.needLanguages'), ok: t('editor.ocr.downloadLanguages') });
  return ok && (await kadr.invoke('native:prepare-translation', { from: res.from, to: res.to }));
}

let translating = false;
async function runTranslateImage() {
  if (translating) return;
  translating = true;
  try {
    app.textEditor?.commit();
    await translateImage(app, { onNeedLanguages: needLanguages });
  } finally {
    translating = false;
  }
}

const actions = {
  copy,
  translateImage: runTranslateImage,
  save: () => output.save(),
  saveAs: () => output.save({ saveAs: true }),
  pin: () => output.pin(),
  paste: () => output.paste(),
  close: () => kadr.invoke('win:close'),
  escape,
  ocr: () => runOcr(),
  addCapture: () => output.addCapture(),
  toggleBackdrop: () => backdropPanel.toggle(),
  contextMenu,
  moreItems,
};

// ---- UI -------------------------------------------------------------------------
installTooltips();
buildToolbar(app, actions, output);
new PropsBar(app, { colorInput: $('#color-input') });
buildStatusBar(app);
backdropPanel = new BackdropPanel(app);
attachInput(app, actions);

// Drop image files onto the canvas → image objects.
const vp = dom.viewport;
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
vp.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  vp.classList.add('drop-target');
});
vp.addEventListener('dragleave', () => vp.classList.remove('drop-target'));
vp.addEventListener('drop', (e) => {
  e.preventDefault();
  vp.classList.remove('drop-target');
  const r = vp.getBoundingClientRect();
  if (e.dataTransfer?.files?.length) output.dropFiles(e.dataTransfer.files, e.clientX - r.left, e.clientY - r.top);
});

new ResizeObserver(() => {
  app.view.resize();
  if (app.layout) app.frame();
}).observe(vp);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.invalidate(false));

// ---- start ----------------------------------------------------------------------
const wanted = params.options?.tool || settings.editor?.tool;
app.setTool(OBJECT_TOOLS.has(wanted) || ['select', 'wand', 'lasso'].includes(wanted) ? wanted : 'arrow');
app.view.resize();
app.frame();
app.emit('history');

const meta = params.meta || {};
document.title = [meta.fileName || meta.windowTitle || meta.appName, 'Kadr'].filter(Boolean).join(' — ');
document.documentElement.classList.toggle('mac', isMac);

if (app.backdrop.type === 'image' && params.backdropImageUrl) app.loadBackdropImage(params.backdropImageUrl);
kadr
  .invoke('native:capabilities')
  .then((c) => (app.caps = c || {}))
  .catch(() => {});
kadr.invoke('editor:ready').catch(() => {});

// Unsaved-changes state for the window (● in the close button, "Save changes?" on close).
app.on('dirty', (v) => kadr.invoke('editor:dirty', v).catch(() => {}));
kadr.on('editor:save-and-close', async () => {
  const saved = await output.save().catch((error) => {
    console.error('save failed:', error);
    return null;
  });
  await kadr.invoke('editor:close-save-finished', !!saved).catch(() => {});
});

if (params.dev) window.__editor = { app, output, actions };

} // The editor is bootstrapped only after its source image loaded successfully.
