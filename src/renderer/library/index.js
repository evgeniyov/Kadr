// Screenshot library: search, open, copy, pin, reveal, drag out, delete.
import { initPage, kadr, t, el, $, toast, getSettings, getLang, plural } from '../../shared/ui.js';

await initPage({ onSettings: (s, p, { langChanged }) => langChanged && load() });

const grid = $('#grid');
const search = $('#search');
let items = [];
const selected = new Set();
let searchTimer = 0;
let loadGeneration = 0;

const ICON = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z"/><path d="M12 14v6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('library.today');
  if (d.toDateString() === y.toDateString()) return t('library.yesterday');
  return d.toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' });
}

function toolButton(name, tip, fn) {
  return el('button', { 'data-tip': tip, html: `<svg viewBox="0 0 24 24">${ICON[name]}</svg>`, onclick: (e) => (e.stopPropagation(), fn()) });
}

function tile(it) {
  const node = el(
    'div.tile',
    {
      class: `tile${selected.has(it.id) ? ' selected' : ''}`,
      draggable: 'true',
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey) {
          selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id);
          node.classList.toggle('selected', selected.has(it.id));
        } else {
          selected.clear();
          selected.add(it.id);
          grid.querySelectorAll('.tile.selected').forEach((n) => n.classList.remove('selected'));
          node.classList.add('selected');
        }
      },
      ondblclick: () => kadr.invoke('library:open', it.id),
      ondragstart: (e) => {
        e.preventDefault();
        kadr.send('library:start-drag', it.id);
      },
    },
    el('div.thumb', el('img', { src: it.thumbUrl, loading: 'lazy', alt: '' })),
    el('div.meta', el('span.app', it.appName || it.windowTitle || `${it.width} × ${it.height}`), el('span', timeLabel(it.created))),
    el(
      'div.tools',
      toolButton('copy', t('library.copy'), async () => {
        await kadr.invoke('library:copy', it.id);
        toast(t('notify.copied'));
      }),
      toolButton('pin', t('library.pin'), () => kadr.invoke('library:pin', it.id)),
      toolButton('trash', t('library.delete'), () => kadr.invoke('library:delete', [it.id]))
    )
  );
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(it);
  });
  return node;
}

function showMenu(it) {
  // Lightweight inline menu using native confirm-less actions.
  const actions = [
    [t('library.open'), () => kadr.invoke('library:open', it.id)],
    [t('library.copy'), () => kadr.invoke('library:copy', it.id).then(() => toast(t('notify.copied')))],
    [t('library.pin'), () => kadr.invoke('library:pin', it.id)],
    [t('library.reveal'), () => kadr.invoke('library:reveal', it.id)],
    [t('library.delete'), () => kadr.invoke('library:delete', [it.id])],
  ];
  document.querySelector('.ctx-menu')?.remove();
  const menu = el(
    'div.ctx-menu.panel',
    { style: { position: 'fixed', left: `${lastPointer.x}px`, top: `${lastPointer.y}px`, padding: '5px', zIndex: 100, minWidth: '190px' } },
    actions.map(([label, fn]) =>
      el(
        'button.btn',
        {
          style: { display: 'flex', width: '100%', justifyContent: 'flex-start', border: 'none', boxShadow: 'none', background: 'transparent' },
          onclick: () => {
            menu.remove();
            fn();
          },
        },
        label
      )
    )
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 6}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 6}px`;
  setTimeout(() => addEventListener('pointerdown', (e) => !menu.contains(e.target) && menu.remove(), { once: true }), 0);
}

const lastPointer = { x: 0, y: 0 };
addEventListener('pointerdown', (e) => Object.assign(lastPointer, { x: e.clientX, y: e.clientY }), true);
addEventListener('contextmenu', (e) => Object.assign(lastPointer, { x: e.clientX, y: e.clientY }), true);

function render() {
  const groups = new Map();
  for (const it of items) {
    const k = new Date(it.created).toDateString();
    if (!groups.has(k)) groups.set(k, { label: dayLabel(it.created), items: [] });
    groups.get(k).items.push(it);
  }
  grid.replaceChildren(...[...groups.values()].flatMap((g) => [el('div.day', g.label), el('div.tiles', g.items.map(tile))]));
  $('#count').textContent = items.length ? t('library.count', { n: items.length, word: plural(items.length, [t('library.one'), t('library.few'), t('library.many')]) }) : '';
  const s = getSettings();
  $('#empty').classList.toggle('hidden', items.length > 0);
  $('#empty-text').textContent = !s.library.enabled ? t('library.disabled') : t('library.empty');
}

async function load() {
  const generation = ++loadGeneration;
  const query = search.value.trim();
  try {
    const result = await kadr.invoke('library:list', { query });
    if (generation !== loadGeneration || query !== search.value.trim()) return;
    items = result;
    for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);
    render();
  } catch (e) {
    if (generation === loadGeneration) toast(`${t('common.error')}: ${e.message}`);
  }
}

search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 180);
});

addEventListener('keydown', async (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.target === search) {
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      load();
    }
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selected.size) kadr.invoke('library:delete', [...selected]);
  else if (e.key === 'Enter' && selected.size) [...selected].forEach((id) => kadr.invoke('library:open', id));
  else if (mod && e.key.toLowerCase() === 'c' && selected.size === 1) {
    await kadr.invoke('library:copy', [...selected][0]);
    toast(t('notify.copied'));
  } else if (mod && e.key.toLowerCase() === 'f') search.focus();
  else if (mod && e.key.toLowerCase() === 'a') {
    items.forEach((i) => selected.add(i.id));
    render();
  } else if (e.key === 'Escape') kadr.invoke('win:close');
});

kadr.on('library:changed', load);
load();
search.focus();
