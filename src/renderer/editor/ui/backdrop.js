// Backdrop sidebar: background type, gradients, padding, radii, shadow, aspect ratio, auto-crop.
import { el, $, t, kadr, toast } from '../../../shared/ui.js';
import { GRADIENTS, RATIOS } from '../consts.js';
import { iconNode } from '../icons.js';
import { randomColor, normalizeHex } from '../color.js';

const SOLIDS = ['#FFFFFF', '#E9E9EF', '#C7C7CC', '#1C1C1E', '#000000', '#FDE68A', '#BFDBFE', '#FBCFE8'];

const cssGradient = ({ stops, angle }) => `linear-gradient(${angle}deg, ${stops.join(', ')})`;

export class BackdropPanel {
  constructor(app) {
    this.app = app;
    this.host = $('#backdrop-panel');
    this.visible = !!app.backdrop.enabled;
    app.on('backdrop', () => this.render());
    this.render();
  }

  // Toolbar button / K: off → on (+panel); on with hidden panel → show panel; otherwise → off.
  toggle() {
    const app = this.app;
    if (!app.backdrop.enabled) {
      this.visible = true;
      app.setBackdrop({ enabled: true });
    } else if (!this.visible) {
      this.visible = true;
      this.render();
    } else {
      this.visible = false;
      app.setBackdrop({ enabled: false });
    }
  }

  hide() {
    this.visible = false;
    this.render();
  }

  render() {
    const a = document.activeElement;
    if (a && this.host.contains(a) && a.type === 'range') return;
    const app = this.app;
    const bd = app.backdrop;
    const show = this.visible && bd.enabled;
    this.host.classList.toggle('hidden', !show);
    if (!show) return;
    const set = (patch) => app.setBackdrop(patch);

    const header = el(
      'div.bd-head',
      el('div.bd-title', t('editor.backdrop.title')),
      el('label.switch', { dataset: { tip: t('editor.backdrop.enabled') } }, el('input', { type: 'checkbox', checked: !!bd.enabled, onchange: (e) => set({ enabled: e.target.checked }) }), el('span')),
      el('button.ibtn.small', { dataset: { tip: t('editor.backdrop.hide'), tipAlign: 'right' }, onclick: () => this.hide() }, iconNode('close')),
    );

    const typeSeg = el(
      'div.seg.full',
      ['gradient', 'solid', 'image', 'transparent'].map((ty) =>
        el('button', { 'aria-pressed': String((bd.type || 'gradient') === ty), onclick: () => this.#setType(ty) }, t(`editor.backdrop.type.${ty}`)),
      ),
    );

    const body = [typeSeg];
    const type = bd.type || 'gradient';
    if (type === 'gradient') body.push(...this.#gradient());
    else if (type === 'solid') body.push(...this.#solid());
    else if (type === 'image') body.push(...this.#image());

    body.push(
      el('div.bd-sep'),
      this.#slider('padding', t('editor.backdrop.padding'), bd.padding ?? 64, 0, 240, 2, (v) => `${v}`),
      this.#slider('innerRadius', t('editor.backdrop.innerRadius'), bd.innerRadius ?? 12, 0, 48, 1, (v) => `${v}`),
      this.#slider('outerRadius', t('editor.backdrop.outerRadius'), bd.outerRadius ?? 0, 0, 48, 1, (v) => `${v}`),
      this.#slider('shadow', t('editor.backdrop.shadow'), bd.shadow ?? 0.5, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      el('div.bd-sep'),
      el(
        'label.bd-row',
        el('span', t('editor.backdrop.ratio')),
        el(
          'select.input.small',
          { onchange: (e) => set({ ratio: e.target.value }), onkeydown: (e) => e.stopPropagation() },
          RATIOS.map((r) => el('option', { value: r.id, selected: (bd.ratio || 'auto') === r.id }, t(`editor.ratio.${r.id}`) + (r.px ? ` · ${r.px}` : ''))),
        ),
      ),
      el(
        'label.bd-row',
        el('span', { dataset: { tip: t('editor.backdrop.autocropTip') } }, t('editor.backdrop.autocrop')),
        el('span.switch', el('input', { type: 'checkbox', checked: !!bd.autocrop, onchange: (e) => set({ autocrop: e.target.checked }) }), el('span')),
      ),
      el('button.btn.full', { onclick: () => this.#randomize() }, iconNode('shuffle'), t('editor.backdrop.randomize')),
    );
    this.host.replaceChildren(header, el('div.bd-body', body));
  }

  #setType(type) {
    const app = this.app;
    if (type === 'image' && !app.renderer.bgImage) return this.#chooseImage();
    app.setBackdrop({ type });
  }

  #gradient() {
    const app = this.app;
    const bd = app.backdrop;
    const cur = bd.gradient ?? 3;
    const grid = el(
      'div.bd-grid',
      GRADIENTS.map((g, i) =>
        el('button.bd-tile', {
          style: `background:${cssGradient(g)}`,
          'aria-pressed': String(cur === i),
          onclick: () => app.setBackdrop({ gradient: i, type: 'gradient' }),
        }),
      ),
      el(
        'button.bd-tile.custom',
        {
          style: `background:${cssGradient({ stops: [bd.gradientFrom || '#7F7FD5', bd.gradientTo || '#91EAE4'], angle: bd.gradientAngle ?? 135 })}`,
          'aria-pressed': String(cur < 0),
          dataset: { tip: t('editor.backdrop.custom') },
          onclick: () => app.setBackdrop({ gradient: -1, type: 'gradient' }),
        },
        iconNode('palette'),
      ),
    );
    const out = [grid];
    if (cur < 0) {
      const color = (key, value) => {
        const i = el('input.color-well', { type: 'color', value: normalizeHex(value).toLowerCase() });
        i.addEventListener('input', () => app.setBackdrop({ [key]: i.value.toUpperCase() }));
        return i;
      };
      out.push(
        el('div.bd-row', el('span', t('editor.backdrop.colors')), el('span.bd-colors', color('gradientFrom', bd.gradientFrom || '#7F7FD5'), color('gradientTo', bd.gradientTo || '#91EAE4'))),
        this.#slider('gradientAngle', t('editor.backdrop.angle'), bd.gradientAngle ?? 135, 0, 360, 5, (v) => `${v}°`),
      );
    }
    return out;
  }

  #solid() {
    const app = this.app;
    const cur = normalizeHex(app.backdrop.solid || '#E9E9EF');
    const well = el('input.color-well', { type: 'color', value: cur.toLowerCase() });
    well.addEventListener('input', () => app.setBackdrop({ solid: well.value.toUpperCase() }));
    return [
      el(
        'div.bd-grid.solids',
        SOLIDS.map((c) => el('button.bd-tile.small', { style: `background:${c}`, 'aria-pressed': String(cur === c), onclick: () => app.setBackdrop({ solid: c }) })),
      ),
      el('div.bd-row', el('span', t('editor.backdrop.color')), well),
    ];
  }

  #image() {
    const app = this.app;
    const img = app.renderer.bgImage;
    const preview = el('div.bd-image');
    if (img && app.backdropImageUrl) preview.style.backgroundImage = `url("${app.backdropImageUrl}")`;
    return [preview, el('button.btn.full', { onclick: () => this.#chooseImage() }, iconNode('image'), t('editor.backdrop.chooseImage'))];
  }

  async #chooseImage() {
    const app = this.app;
    try {
      const file = await kadr.invoke('app:choose-file', { filters: [{ name: t('editor.backdrop.images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (!file) return;
      const res = await kadr.invoke('editor:import-image', { path: file });
      await app.loadBackdropImage(res.url);
      if (!app.renderer.bgImage) throw new Error('image failed to load');
      app.setBackdrop({ type: 'image', imagePath: res.path });
    } catch (e) {
      console.warn('backdrop image', e);
      toast(t('editor.toast.notAnImage'));
    }
  }

  #slider(key, label, value, min, max, step, fmt) {
    const app = this.app;
    const input = el('input.range', { type: 'range', min, max, step, value });
    const out = el('span.range-value', fmt(value));
    input.addEventListener('input', () => {
      out.textContent = fmt(+input.value);
      app.setBackdrop({ [key]: +input.value });
    });
    input.addEventListener('change', () => input.blur());
    return el('label.bd-slider', el('span.bd-slider-label', label, out), input);
  }

  #randomize() {
    const app = this.app;
    if (Math.random() < 0.5) {
      app.setBackdrop({ type: 'gradient', gradient: Math.floor(Math.random() * GRADIENTS.length) });
    } else {
      app.setBackdrop({ type: 'gradient', gradient: -1, gradientFrom: randomColor(50, 80), gradientTo: randomColor(35, 70), gradientAngle: Math.round((Math.random() * 360) / 5) * 5 });
    }
  }
}
