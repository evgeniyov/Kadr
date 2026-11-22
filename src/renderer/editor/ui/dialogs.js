// OCR result popover and the image resize dialog.
import { el, t, kadr, toast } from '../../../shared/ui.js';
import { iconNode } from '../icons.js';
import { openPopover, openDialog } from './popover.js';

async function copyText(text) {
  await kadr.invoke('clipboard:write-text', text);
  toast(t('editor.toast.textCopied'));
}

// res: { text, lines:[{text}], qr:[{text}] }
export function showOcrResult(anchor, res) {
  const text = (res?.text ?? (res?.lines || []).map((l) => l.text).join('\n')).trim();
  const qr = (res?.qr || []).filter((q) => q?.text);
  if (!text && !qr.length) {
    toast(t('editor.ocr.nothing'));
    return null;
  }
  const lines = text.split('\n').length;
  const area = el('textarea.input.ocr-text.selectable', { rows: Math.min(12, Math.max(3, lines)), spellcheck: 'false' });
  area.value = text;
  area.addEventListener('keydown', (e) => e.stopPropagation());
  let ref;
  const body = [
    el('div.pop-head', el('div.pop-title', t('editor.ocr.title')), el('button.ibtn.small', { onclick: () => ref.close(), 'aria-label': t('common.close') }, iconNode('close'))),
  ];
  if (text) {
    const translation = el('div.ocr-translation.hidden');
    // Compact on purpose: an icon button with a tooltip next to the copy actions.
    const translateBtn = el(
      'button.ibtn.translate-btn',
      { onclick: () => runTranslation(area.value, translation, translateBtn), dataset: { tip: t('editor.ocr.translate') }, 'aria-label': t('editor.ocr.translate') },
      iconNode('translate'),
    );
    body.push(
      area,
      el(
        'div.pop-row.end',
        translateBtn,
        el('div.spacer'),
        el('button.btn', { onclick: () => copyText(text.replace(/\s*\n\s*/g, ' ')) }, t('editor.ocr.copyOneLine')),
        el('button.btn.primary', { onclick: () => copyText(area.value) }, iconNode('copy'), t('editor.ocr.copy')),
      ),
      translation,
    );
  }
  if (qr.length) {
    body.push(el('div.pop-title', t('editor.ocr.qr')));
    for (const q of qr) {
      const isUrl = /^https?:\/\//i.test(q.text);
      body.push(
        el(
          'div.qr-row',
          el('span.qr-text.selectable', q.text),
          isUrl ? el('button.btn.small', { onclick: () => kadr.invoke('app:open-external', q.text) }, t('editor.ocr.open')) : null,
          el('button.btn.small', { onclick: () => copyText(q.text) }, t('editor.ocr.copy')),
        ),
      );
    }
  }
  ref = openPopover(anchor, el('div.ocr-pop', body), { className: 'ocr-popover', align: 'end' });
  return ref;
}

// Translate the recognised text into the popover (macOS: on-device, offline).
async function runTranslation(text, box, btn) {
  box.classList.remove('hidden');
  box.replaceChildren(el('div.faint', t('editor.ocr.translating')));
  btn.disabled = true;
  let res;
  try {
    res = await kadr.invoke('native:translate', { text });
  } catch (e) {
    res = { error: 'failed' };
  }
  btn.disabled = false;
  if (res.error === 'not-installed') {
    box.replaceChildren(
      el('div.faint', t('editor.ocr.needLanguages')),
      el(
        'div.pop-row.end',
        el(
          'button.btn.primary',
          {
            onclick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              try {
                if (await kadr.invoke('native:prepare-translation', { from: res.from, to: res.to })) await runTranslation(text, box, btn);
              } catch (error) {
                console.warn('translation language setup failed', error);
                toast(t('editor.ocr.setupFailed'), 4000);
              } finally { button.disabled = false; }
            },
          },
          t('editor.ocr.downloadLanguages'),
        ),
      ),
    );
    return;
  }
  if (res.error) {
    box.replaceChildren(
      el('div.faint', t(res.error === 'unsupported' ? 'editor.ocr.translateOnline' : 'editor.toast.failed')),
      el('div.pop-row.end', el('button.btn', { onclick: () => kadr.invoke('native:web-translate', { text, to: res.to }) }, t('editor.ocr.openWeb'))),
    );
    return;
  }
  const out = el('textarea.input.ocr-text.selectable', { rows: Math.min(10, Math.max(3, res.text.split('\n').length)), spellcheck: 'false', readOnly: true });
  out.value = res.text;
  out.addEventListener('keydown', (e) => e.stopPropagation());
  box.replaceChildren(
    el('div.pop-title', t('editor.ocr.translation', { from: (res.from || '').toUpperCase(), to: (res.to || '').toUpperCase() })),
    out,
    el('div.pop-row.end', el('button.btn.primary', { onclick: () => copyText(out.value) }, iconNode('copy'), t('editor.ocr.copyTranslation'))),
  );
}

// Resize dialog: pixels or percent, optional aspect lock. onApply(width, height).
export function openResizeDialog(app, onApply) {
  const W = app.doc.width;
  const H = app.doc.height;
  let unit = 'px';
  let keep = true;
  const w = el('input.input.num', { type: 'number', min: 1, value: W });
  const h = el('input.input.num', { type: 'number', min: 1, value: H });
  const px = () => (unit === 'px' ? [+w.value, +h.value] : [Math.round((W * +w.value) / 100), Math.round((H * +h.value) / 100)]);
  const info = el('div.faint.dialog-note');
  const updateInfo = () => {
    const [pw, ph] = px();
    info.textContent = t('editor.resize.result', { w: pw || 0, h: ph || 0, ow: W, oh: H });
  };
  w.addEventListener('input', () => {
    if (keep) h.value = unit === 'px' ? Math.round((+w.value * H) / W) : w.value;
    updateInfo();
  });
  h.addEventListener('input', () => {
    if (keep) w.value = unit === 'px' ? Math.round((+h.value * W) / H) : h.value;
    updateInfo();
  });
  const segBtns = ['px', '%'].map((u) =>
    el(
      'button',
      {
        'aria-pressed': String(u === unit),
        onclick: () => {
          const [pw, ph] = px();
          unit = u;
          segBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === u)));
          w.value = u === 'px' ? pw : Math.round((pw / W) * 1000) / 10;
          h.value = u === 'px' ? ph : Math.round((ph / H) * 1000) / 10;
          updateInfo();
        },
      },
      u,
    ),
  );
  const keepBox = el('input', { type: 'checkbox', checked: true, onchange: (e) => (keep = e.target.checked) });
  updateInfo();
  openDialog({
    title: t('editor.resize.title'),
    body: el(
      'div.resize-form',
      el('div.form-row', el('label', t('editor.resize.width')), w, el('label', t('editor.resize.height')), h, el('div.seg', segBtns)),
      el('label.check-row', keepBox, el('span', t('editor.resize.keep'))),
      info,
    ),
    buttons: [
      { label: t('common.cancel') },
      {
        label: t('editor.resize.apply'),
        primary: true,
        onClick: () => {
          const [pw, ph] = px();
          if (!(pw >= 1 && ph >= 1 && pw <= 20000 && ph <= 20000)) {
            toast(t('editor.resize.invalid'));
            return false;
          }
          if (pw !== W || ph !== H) onApply(pw, ph);
        },
      },
    ],
  });
}

// Background removal refinement: tolerance slider applied live; Cancel reverts.
export function openBgPopover(app, { value, onInput, onHoles, onCancel }) {
  const vp = app.dom.viewport.getBoundingClientRect();
  let timer = 0;
  const out = el('span.range-value', String(value));
  const input = el('input.range', { type: 'range', min: 0, max: 255, step: 1, value });
  input.addEventListener('input', () => {
    out.textContent = input.value;
    clearTimeout(timer);
    timer = setTimeout(() => onInput(+input.value), 90);
  });
  let ref;
  const body = el(
    'div.bg-pop',
    el('div.pop-title', t('editor.bg.title')),
    el('div.bg-hint', t('editor.bg.hint')),
    el('div.pop-row', el('span.prop-label', t('editor.bg.tolerance')), input, out),
    el('label.pop-row.check-row', el('input', { type: 'checkbox', onchange: (e) => onHoles?.(e.target.checked) }), el('span', t('editor.bg.holes'))),
    el(
      'div.pop-row.end',
      el('button.btn', { onclick: () => (ref.close(), onCancel?.()) }, t('common.cancel')),
      el('button.btn.primary', { onclick: () => ref.close() }, t('editor.bg.done')),
    ),
  );
  ref = openPopover(null, body, { className: 'bg-popover', at: { x: vp.left + vp.width / 2 - 160, y: vp.top + 4 } });
  return ref;
}
