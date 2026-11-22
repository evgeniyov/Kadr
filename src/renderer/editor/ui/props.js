// Property bar: contextual controls for the current tool or the selected object.
import { el, $, t, getSettings, setSettings } from '../../../shared/ui.js';
import { PRESET_COLORS, ARROW_STYLES, LINE_STYLES, TEXT_STYLES, CONCEAL_MODES, RECT_RADII, MAGNIFIER_ZOOMS, COLOR_FORMATS, LASSO_SHAPES } from '../consts.js';
import { icon, iconNode } from '../icons.js';
import { typeOf } from '../objects/index.js';
import { normalizeHex, isValidHex } from '../color.js';
import { openPopover, openMenu } from './popover.js';
import { sc } from './toolbar.js';

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const WAND_SAMPLES = [1, 3, 5, 11, 31]; // Photoshop "Sample Size" options (n×n average)

function seg(options, value, onPick, cls = '') {
  return el(
    `div.seg${cls}`,
    options.map((o) =>
      el(
        'button',
        {
          'aria-pressed': String(o.value === value),
          dataset: o.tip ? { tip: o.tip } : null,
          onclick: () => onPick(o.value),
          html: o.icon ? icon(o.icon) : null,
        },
        o.icon ? null : o.label,
      ),
    ),
  );
}

function label(text) {
  return el('span.prop-label', text);
}

function sizeSeg(value, onPick) {
  return el(
    'div.seg.sizes',
    [1, 2, 3, 4, 5, 6].map((n) =>
      el(
        'button',
        { 'aria-pressed': String(n === value), dataset: { tip: t('editor.prop.sizeN', { n }) }, onclick: () => onPick(n) },
        el('i', { style: { width: `${2 + n * 2}px`, height: `${2 + n * 2}px` } }),
      ),
    ),
  );
}

function percent(v) {
  return `${Math.round(v * 100)}%`;
}

export class PropsBar {
  constructor(app, { colorInput }) {
    this.app = app;
    this.host = $('#props');
    this.colorInput = colorInput;
    for (const ev of ['tool', 'selection', 'props', 'crop', 'history', 'textedit', 'pixelselection']) {
      app.on(ev, () => this.render());
    }
    colorInput.addEventListener('input', () => app.setProp('color', normalizeHex(colorInput.value)));
    colorInput.addEventListener('change', () => app.addCustomColor(colorInput.value));
    this.render();
  }

  render() {
    const a = document.activeElement;
    if (a && this.host.contains(a) && (a.type === 'range' || a.type === 'number')) return;
    const app = this.app;
    const parts = [];
    const tool = app.toolId;
    const type = app.contextType();
    const sel = app.pixelSelection;
    if (tool === 'crop') parts.push(...this.#crop());
    else if (tool === 'picker') parts.push(...this.#picker());
    else if (tool === 'wand' || tool === 'lasso') parts.push(...this.#selectionTool(tool));
    else if (type) parts.push(...this.#objectProps(type));
    else if (!sel?.active) parts.push(el('span.prop-hint', t(tool === 'select' ? 'editor.hint.select' : 'editor.hint.generic')));
    const o = app.selected;
    if (o) parts.push(el('div.sep'), ...this.#selectionActions(o));
    else if (sel?.active && tool !== 'crop') parts.push(el('div.sep'), ...this.#pixelActions());
    while (parts[0]?.classList?.contains('sep')) parts.shift();
    this.host.replaceChildren(...parts);
  }

  #objectProps(type) {
    const app = this.app;
    const T = typeOf({ type });
    const has = (p) => T?.props.includes(p);
    const set = (name) => (v) => app.setProp(name, v);
    const out = [];
    if (has('color')) out.push(this.#palette());
    if (has('size')) {
      if (out.length) out.push(el('div.sep'));
      if (type === 'conceal') out.push(label(t('editor.prop.strength')));
      out.push(sizeSeg(app.propValue('size'), set('size')));
    }
    const styleOut = [];
    if (type === 'arrow') {
      styleOut.push(seg(ARROW_STYLES.map((s) => ({ value: s, icon: `arrow${cap(s)}`, tip: t(`editor.arrow.${s}`) })), app.propValue('arrowStyle'), set('arrowStyle'), '.icons'));
    } else if (type === 'rect' || type === 'oval') {
      const pre = type === 'rect' ? 'fill' : 'oval';
      styleOut.push(seg(['outline', 'semi', 'solid'].map((s) => ({ value: s, icon: `${pre}${cap(s)}`, tip: t(`editor.fill.${s}`) })), app.propValue('fill'), set('fill'), '.icons'));
      if (type === 'rect') {
        styleOut.push(seg(RECT_RADII.map((r, i) => ({ value: r, icon: `radius${i}`, tip: t(`editor.radius.${i}`) })), app.propValue('rectRadius'), set('rectRadius'), '.icons'));
      }
    } else if (type === 'line') {
      styleOut.push(seg(LINE_STYLES.map((s) => ({ value: s, icon: `line${cap(s)}`, tip: t(`editor.line.${s}`) })), app.propValue('lineStyle'), set('lineStyle'), '.icons'));
    } else if (type === 'text') {
      styleOut.push(
        el(
          'div.seg.text-styles',
          TEXT_STYLES.map((s) =>
            el('button', { 'aria-pressed': String(app.propValue('textStyle') === s), dataset: { tip: t(`editor.textStyle.${s}`) }, onclick: () => app.setProp('textStyle', s) }, el(`span.ts.ts-${s}`, 'Aa')),
          ),
        ),
      );
    } else if (type === 'conceal') {
      const cur = app.propValue('concealType') || 'pixelate';
      const [mode, suffix] = cur.split('-');
      const textOnly = suffix === 'text';
      styleOut.push(
        seg(CONCEAL_MODES.map((m) => ({ value: m, icon: { pixelate: 'pixelMode', blur: 'blurMode', erase: 'eraser' }[m], tip: t(`editor.conceal.${m}`) })), mode, (m) => app.setProp('concealType', textOnly ? `${m}-text` : m), '.icons'),
        el(
          'button.ibtn.toggle',
          { 'aria-pressed': String(textOnly), dataset: { tip: t('editor.conceal.textOnly') }, onclick: () => app.setProp('concealType', textOnly ? mode : `${mode}-text`), html: icon('textOnly') },
        ),
        el('span.prop-label', t(textOnly ? 'editor.conceal.textOnlyOn' : `editor.conceal.${mode}`)),
      );
    } else if (type === 'spotlight') {
      styleOut.push(
        seg([{ value: 'rect', icon: 'fillOutline', tip: t('editor.spotlight.rect') }, { value: 'oval', icon: 'ovalOutline', tip: t('editor.spotlight.oval') }], app.propValue('spotlightShape'), set('spotlightShape'), '.icons'),
        label(t('editor.prop.dim')),
        this.#range(app.propValue('spotlightDim') ?? 0.55, 0.15, 0.9, 0.05, set('spotlightDim')),
      );
    } else if (type === 'magnifier') {
      styleOut.push(label(t('editor.prop.zoom')), seg(MAGNIFIER_ZOOMS.map((z) => ({ value: z, label: `${z}×` })), app.propValue('magnifierZoom'), set('magnifierZoom')));
    } else if (type === 'ruler') {
      if (!app.selected) {
        styleOut.push(
          seg([{ value: 'h', icon: 'rulerH', tip: t('editor.ruler.h') }, { value: 'v', icon: 'rulerV', tip: t('editor.ruler.v') }], app.props.rulerAxis, set('rulerAxis'), '.icons'),
        );
      }
      styleOut.push(seg([{ value: 'px', label: 'px' }, { value: 'pt', label: 'pt' }], app.propValue('rulerUnit'), set('rulerUnit')));
      if (!app.selected) styleOut.push(el('span.prop-hint', t('editor.hint.ruler')));
    }
    if (styleOut.length) out.push(el('div.sep'), ...styleOut);
    if (has('shadow')) {
      out.push(el('button.ibtn.toggle', { 'aria-pressed': String(!!app.propValue('shadow')), dataset: { tip: t('editor.prop.shadow') }, onclick: () => app.setProp('shadow', !app.propValue('shadow')), html: icon('shadow') }));
    }
    if (has('opacity') && !has('color')) {
      out.push(label(t('editor.prop.opacity')), this.#range(app.propValue('opacity') ?? 1, 0.1, 1, 0.05, (v) => app.setProp('opacity', v)));
    }
    return out;
  }

  // Photoshop-style tolerance: 0..255 slider plus an exact number field, kept in sync.
  #tolerance(value, onSet) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(+v || 0)));
    const slider = el('input.range.tolerance-range', { type: 'range', min: 0, max: 255, step: 1, value });
    const num = el('input.input.tolerance-num', { type: 'number', min: 0, max: 255, step: 1, value });
    slider.addEventListener('input', () => {
      num.value = slider.value;
      onSet(+slider.value);
    });
    slider.addEventListener('change', () => slider.blur());
    num.addEventListener('change', () => {
      const v = clamp(num.value);
      num.value = slider.value = v;
      onSet(v);
      num.blur();
    });
    num.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing digits must not switch tools
      if (e.key === 'Enter' || e.key === 'Escape') num.blur();
    });
    return [slider, num];
  }

  #range(value, min, max, step, onInput, fmt = percent) {
    const input = el('input.range', { type: 'range', min, max, step, value });
    const out = el('span.range-value', fmt(value));
    input.addEventListener('input', () => {
      out.textContent = fmt(+input.value);
      onInput(+input.value);
    });
    input.addEventListener('change', () => {
      input.blur();
      this.render();
    });
    return el('span.range-wrap', input, out);
  }

  #palette() {
    const app = this.app;
    const cur = normalizeHex(app.propValue('color') || '#FF3B30');
    const wrap = el('div.palette');
    for (const c of PRESET_COLORS) {
      wrap.append(
        el('button.swatch', {
          style: `--c:${c}`,
          'aria-pressed': String(cur === c),
          dataset: { tip: t(`editor.color.${PRESET_COLORS.indexOf(c)}`) },
          onclick: () => app.setProp('color', c),
        }),
      );
    }
    const isCustom = !PRESET_COLORS.includes(cur);
    const opacity = app.propValue('opacity') ?? 1;
    const more = el(
      'button.swatch.more',
      {
        style: `--c:${cur}`,
        'aria-pressed': String(isCustom),
        dataset: { tip: t('editor.color.more') },
        onclick: () => this.#colorPopover(more),
      },
      isCustom ? el('i.cur') : null,
    );
    wrap.append(more);
    if (opacity < 0.999) wrap.append(el('span.opacity-tag', percent(opacity)));
    return wrap;
  }

  #colorPopover(anchor) {
    const app = this.app;
    const cur = normalizeHex(app.propValue('color') || '#FF3B30');
    const customs = el('div.custom-grid');
    const renderCustoms = () => {
      customs.replaceChildren(
        ...(app.customColors.length
          ? app.customColors.map((c) =>
              el(
                'div.custom-swatch',
                el('button.swatch', { style: `--c:${c}`, 'aria-pressed': String(c === normalizeHex(app.propValue('color'))), onclick: () => app.setProp('color', c) }),
                el('button.remove', { html: icon('close'), dataset: { tip: t('editor.color.remove') }, onclick: () => (app.removeCustomColor(c), renderCustoms()) }),
              ),
            )
          : [el('span.faint', t('editor.color.noCustom'))]),
      );
    };
    renderCustoms();
    const hex = el('input.input.hex', { value: cur, spellcheck: 'false', maxLength: 7 });
    hex.addEventListener('change', () => {
      if (isValidHex(hex.value)) app.addCustomColor(hex.value.startsWith('#') ? hex.value : `#${hex.value}`);
      renderCustoms();
    });
    const pick = el(
      'button.btn',
      {
        onclick: () => {
          this.colorInput.value = normalizeHex(app.propValue('color')).toLowerCase();
          this.colorInput.click();
        },
      },
      iconNode('palette'),
      t('editor.color.system'),
    );
    const opacity = app.propValue('opacity') ?? 1;
    const opInput = el('input.range', { type: 'range', min: 0.1, max: 1, step: 0.05, value: opacity });
    const opValue = el('span.range-value', percent(opacity));
    opInput.addEventListener('input', () => {
      opValue.textContent = percent(+opInput.value);
      app.setProp('opacity', +opInput.value);
    });
    const content = el(
      'div.color-pop',
      el('div.pop-title', t('editor.color.custom')),
      customs,
      el('div.pop-row', pick, hex, el('button.btn', { onclick: () => (app.addCustomColor(isValidHex(hex.value) ? hex.value : cur), renderCustoms()), dataset: { tip: t('editor.color.addCurrent') } }, iconNode('plus'))),
      el('div.pop-title', t('editor.prop.opacity')),
      el('div.pop-row', opInput, opValue),
    );
    openPopover(anchor, content, { className: 'color-popover' });
  }

  #selectionActions(o) {
    const app = this.app;
    const b = (name, tipText, fn) => el('button.ibtn', { html: icon(name), dataset: { tip: tipText }, onclick: fn });
    const arrange = b('forward', t('editor.action.arrange'), () =>
      openMenu(arrange, [
        { label: t('editor.action.front'), shortcut: sc(']', true), onClick: () => app.arrangeSelected('front') },
        { label: t('editor.action.forward'), shortcut: sc(']'), onClick: () => app.arrangeSelected('forward') },
        { label: t('editor.action.backward'), shortcut: sc('['), onClick: () => app.arrangeSelected('backward') },
        { label: t('editor.action.back'), shortcut: sc('[', true), onClick: () => app.arrangeSelected('back') },
      ]),
    );
    const out = [b('duplicate', `${t('editor.action.duplicate')}  ${sc('D')}`, () => app.duplicateSelected()), arrange, b('trash', `${t('editor.action.delete')}  ⌫`, () => app.deleteSelected())];
    if (o.type === 'text' || o.type === 'counter') {
      out.unshift(el('button.btn.small', { onclick: () => app.textEditor.begin(o) }, t(o.type === 'text' ? 'editor.action.editText' : 'editor.action.editLabel')));
    }
    return out;
  }

  #selectionTool(tool) {
    const app = this.app;
    const set = (name) => (v) => app.setProp(name, v);
    const out = [];
    if (tool === 'wand') {
      out.push(
        label(t('editor.wand.tolerance')),
        ...this.#tolerance(app.props.wandTolerance, set('wandTolerance')),
        label(t('editor.wand.sample')),
        el(
          'select.input.prop-select',
          { dataset: { tip: t('editor.wand.sampleTip') }, onchange: (e) => app.setProp('wandSample', +e.target.value) },
          WAND_SAMPLES.map((n) => el('option', { value: String(n), selected: (app.props.wandSample || 1) === n }, n === 1 ? t('editor.wand.samplePoint') : `${n}×${n}`)),
        ),
        el('button.ibtn.toggle', { 'aria-pressed': String(!!app.props.wandContiguous), dataset: { tip: t('editor.wand.contiguous') }, onclick: () => app.setProp('wandContiguous', !app.props.wandContiguous), html: icon('contiguous') }),
        el('button.ibtn.toggle', { 'aria-pressed': String(!!app.props.wandAntialias), dataset: { tip: t('editor.wand.antialias') }, onclick: () => app.setProp('wandAntialias', !app.props.wandAntialias), html: icon('antialias') }),
      );
    } else {
      const icons = { free: 'lasso', polygon: 'lassoPoly', rect: 'marqueeRect', ellipse: 'marqueeEllipse' };
      out.push(seg(LASSO_SHAPES.map((s) => ({ value: s, icon: icons[s], tip: t(`editor.lasso.${s}`) })), app.props.lassoShape, set('lassoShape'), '.icons'));
    }
    if (!app.pixelSelection.active) out.push(el('span.prop-hint', t(tool === 'wand' ? 'editor.hint.wand' : app.props.lassoShape === 'polygon' ? 'editor.hint.polygon' : 'editor.hint.lasso')));
    return out;
  }

  #pixelActions() {
    const app = this.app;
    const sel = app.pixelSelection;
    const b = (name, tipText, fn, cls = '') => el(`button.ibtn${cls}`, { html: icon(name), dataset: { tip: tipText }, onclick: fn });
    const k = app.doc.scale || 1;
    const refine = b('sparkle', t('editor.sel.refine'), () =>
      openMenu(refine, [
        { label: t('editor.sel.expand', { n: 2 }), onClick: () => sel.refine('expand', 2 * k) },
        { label: t('editor.sel.contract', { n: 2 }), onClick: () => sel.refine('contract', 2 * k) },
        { label: t('editor.sel.feather', { n: 2 }), onClick: () => sel.refine('feather', 2 * k) },
        { label: t('editor.sel.feather', { n: 6 }), onClick: () => sel.refine('feather', 6 * k) },
      ]),
    );
    return [
      label(t('editor.sel.label')),
      b('eraser', `${t('editor.sel.erase')}  ⌫`, () => sel.erase()),
      b('selKeep', t('editor.sel.keep'), () => sel.keepOnly()),
      b('crop', t('editor.sel.crop'), () => sel.cropTo()),
      b('bucket', t('editor.sel.fill'), () => sel.fill(app.props.color)),
      b('copy', `${t('editor.sel.copy')}  ${sc('C')}`, () => sel.copy()),
      el('div.sep'),
      b('selInvert', `${t('editor.sel.invert')}  ${sc('I', true)}`, () => sel.invert()),
      refine,
      b('close', `${t('editor.sel.deselect')}  Esc`, () => sel.deselect()),
    ];
  }

  #crop() {
    const app = this.app;
    const tool = app.tools.crop;
    const r = tool.rect || { w: 0, h: 0 };
    const num = (v, fn) => {
      const i = el('input.input.num', { type: 'number', min: 1, max: 20000, value: Math.round(v) });
      i.addEventListener('change', () => fn(Math.max(1, +i.value || 1)));
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          i.blur();
          fn(Math.max(1, +i.value || 1));
        }
        e.stopPropagation();
      });
      return i;
    };
    const ratios = ['free', '1:1', '4:3', '3:2', '16:9'];
    return [
      label(t('editor.crop.ratio')),
      seg(ratios.map((id) => ({ value: id, label: id === 'free' ? t('editor.crop.free') : id })), tool.ratio, (v) => tool.setRatio(v)),
      el('div.sep'),
      num(r.w, (w) => tool.setSize(w, tool.rect.h)),
      el('span.faint', '×'),
      num(r.h, (h) => tool.setSize(tool.rect.w, h)),
      el('span.faint', 'px'),
      el('div.sep'),
      el('button.btn.small', { onclick: () => tool.reset() }, t('editor.crop.reset')),
      el('button.btn.small', { onclick: () => tool.cancel() }, t('common.cancel')),
      el('button.btn.small.primary', { onclick: () => tool.apply() }, t('editor.crop.apply')),
      el('span.prop-hint', t('editor.hint.crop')),
    ];
  }

  #picker() {
    const fmt = getSettings()?.colorFormat || 'hex';
    const sel = el(
      'select.input.small',
      {
        onchange: (e) => {
          setSettings({ colorFormat: e.target.value });
        },
      },
      COLOR_FORMATS.map((f) => el('option', { value: f, selected: f === fmt }, t(`editor.colorFormat.${f}`))),
    );
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    return [label(t('editor.picker.format')), sel, el('span.prop-hint', t('editor.hint.picker'))];
  }
}

