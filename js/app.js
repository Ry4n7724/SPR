import * as db from './db.js';
import { h, renderSide, sideText, hasText } from './content.js';
import { parseCards, readFiles, saveSet, exportBackup, restoreBackup, newCard, normalizeSide, imagesUsed } from './import.js';
import { Session, learnPool, modesFor, shuffle, STAGES, STAGE_NAMES,
  buildTest, gradeTest, TEST_TYPES, TEST_TYPE_NAMES } from './learn.js';
import { icon } from './icons.js';

const app = document.getElementById('app');
const show = (...els) => { app.replaceChildren(...els); window.scrollTo(0, 0); };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
};
// Saved flashcard deck and position, one per set.
const flashKey = (setId) => `flash-${setId}`;
// Before per-set settings there was one global answer direction; it is the default for older sets.
const DIRS = [['def', 'Definition'], ['term', 'Term'], ['mixed', 'Both']];
const learnDirOf = (set) => set.learnDir || store.get('dir', 'def');
const FLASH_DEFAULTS = { shuffle: true, track: true, starred: false };
// front = what the card shows first: 'term', 'def' or 'mixed'.
const flashOpts = (set) => {
  const old = store.get('dir', 'def');
  return { ...FLASH_DEFAULTS, front: old === 'def' ? 'term' : old === 'term' ? 'def' : 'mixed', ...(set.flash || {}) };
};
// Only Learn keeps a saved session; older versions also saved practice ones, which are dropped.
async function learnSession(setId) {
  const saved = await db.getSession(setId);
  if (saved && saved.mode !== 'learn') { await db.deleteSession(setId); return null; }
  return saved;
}
let keyHandler = null;
document.addEventListener('keydown', (e) => keyHandler && keyHandler(e));

// Tap any image to see it fullscreen.
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img.zoomable');
  if (!img || img.closest('.side-prev')) return;
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() }, h('img', { src: img.src, alt: '' }));
  document.body.append(box);
});

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function imageMap(setId) {
  const map = new Map();
  for (const im of await db.getImages(setId)) map.set(im.name.toLowerCase(), URL.createObjectURL(im.blob));
  return map;
}
const revoke = (map) => map && map.forEach((u) => URL.revokeObjectURL(u));

// ---------------------------------------------------------------- helpers
// Back/close button + title + spacer, used by every plain view.
const topbarNav = (onBack, title, iconName = 'back') => h('header', { class: 'topbar' },
  h('button', { class: 'icon', 'aria-label': iconName === 'back' ? 'Back' : 'Close', onclick: onBack }, icon(iconName)),
  h('h1', {}, title), h('span'));

// Close button + progress bar + counter (+ optional options gear). Built once and updated in place so the width transition animates.
function progressHeader(onExit, onSettings) {
  const bar = h('div', { style: 'width:0%' });
  const track = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar);
  const count = h('span', { class: 'muted count' });
  const header = h('header', { class: 'topbar' },
    h('button', { class: 'icon', 'aria-label': 'Close', onclick: onExit }, icon('close')), track, count,
    onSettings ? h('button', { class: 'icon', 'aria-label': 'Options', onclick: onSettings }, icon('gear')) : null);
  return {
    header,
    update(pct, text) { bar.style.width = `${pct}%`; track.setAttribute('aria-valuenow', pct); count.textContent = text; },
  };
}

// Bottom sheet for a mode's options. Keys go to the sheet while it is open; onClose runs after it closes.
function optionsSheet(title, body, onClose = () => {}) {
  const prevKeys = keyHandler;
  const close = () => { box.remove(); keyHandler = prevKeys; onClose(); };
  keyHandler = (e) => e.key === 'Escape' && close();
  const box = h('div', { class: 'modal', onclick: (e) => { if (e.target === box) close(); } },
    h('div', { class: 'card stack modal-body' }, h('div', { class: 'handle' }), h('h2', {}, title), ...body,
      h('button', { class: 'btn primary', onclick: close }, 'Done')));
  document.body.append(box);
  return { close, remove: () => box.remove() };
}

// Select for the answer direction.
const dirSelect = (value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
  ...DIRS.map(([v, l]) => h('option', { value: v, selected: value === v }, l)));

async function saveSetRecord(set) { await db.putMany('sets', [set]); return set; }

// Set overview from its cards and its saved Learn session. state: 'none', 'active' or 'done'.
function setStats(cards, saved) {
  const total = cards.length;
  const starred = cards.filter((c) => c.starred).length;
  const state = !saved ? 'none' : saved.done ? 'done' : 'active';
  const pct = state === 'done' ? 100 : state === 'active' && saved.stepsTotal ? Math.round((saved.steps / saved.stepsTotal) * 100) : 0;
  return { total, starred, state, pct, mastered: saved ? saved.mastered : 0, of: saved ? saved.total : 0 };
}
const statsLine = (st) => `${st.total} cards${st.state === 'none' ? '' : ` · ${st.mastered}/${st.of} mastered`}${st.starred ? ` · ${st.starred} starred` : ''}`;
const progressBar = (pct) => h('div', {
  class: 'progress', role: 'progressbar', 'aria-label': 'Learned', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct,
}, h('div', { style: `width:${pct}%` }));

// ---------------------------------------------------------------- library
async function libraryView() {
  keyHandler = null;
  const sets = (await db.getSets()).sort((a, b) => b.created - a.created);

  const list = h('div', { class: 'list' });
  for (const s of sets) {
    const cards = await db.getCards(s.id);
    const saved = await learnSession(s.id);
    const st = setStats(cards, saved);
    const primary = st.state === 'active'
      ? h('button', { class: 'btn primary', onclick: () => study(s, true) }, `Continue learn (${st.mastered}/${st.of})`)
      : h('button', { class: 'btn primary', disabled: st.total === 0, onclick: () => study(s) }, st.state === 'done' ? 'Learn again' : 'Learn');
    // The whole card opens the set page; the button inside must not.
    primary.addEventListener('click', (e) => e.stopPropagation());
    list.append(h('div', { class: 'card set clickable', onclick: () => setView(s) },
      h('div', { class: 'set-head' },
        h('div', { class: 'grow' },
          h('div', { class: 'set-name' }, s.name),
          h('div', { class: 'muted' }, statsLine(st))),
        icon('chevron', 'chev')),
      progressBar(st.pct),
      h('div', { class: 'row' }, primary)));
  }

  const backupIn = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await readFiles([f]);
      if (!r.backup) return toast('That zip is not a backup file');
      const n = await restoreBackup(r.backup);
      toast(`Restored ${n} set${n === 1 ? '' : 's'}`); libraryView();
    } catch (err) { toast('Restore failed: ' + err.message); }
  } });

  show(
    h('header', { class: 'topbar' }, h('h1', {}, h('span', { class: 'dot' }), ' Spaced Cards'),
      h('button', { class: 'btn primary small', onclick: importView }, icon('plus'), 'Import')),
    h('main', { class: 'page' },
      sets.length ? list : h('div', { class: 'empty' },
        h('p', {}, h('span', { class: 'dot' }), ' No sets yet.'),
        h('p', { class: 'muted' }, 'Import a Quizlet export (text file) or a .zip with images. Tap Import to start.'),
        h('button', { class: 'btn primary', onclick: importView }, 'Import a set')),
      sets.length ? h('div', { class: 'row footer-row' },
        h('button', { class: 'btn small', onclick: async () => {
          const blob = await exportBackup();
          const a = h('a', { href: URL.createObjectURL(blob), download: `spaced-cards-backup-${new Date().toISOString().slice(0, 10)}.zip` });
          document.body.append(a); a.click(); a.remove();
        } }, 'Save backup'),
        h('button', { class: 'btn small', onclick: () => backupIn.click() }, 'Restore backup')) : null,
      !sets.length ? h('div', { class: 'row footer-row' }, h('button', { class: 'btn small', onclick: () => backupIn.click() }, 'Restore backup')) : null,
      backupIn));
}

// -------------------------------------------------------------------- hub
// One page per set: progress overview plus every mode and action for it.
async function setView(set) {
  keyHandler = null;
  // Re-read so a rename or settings change shows up without passing objects around.
  set = (await db.getSets()).find((x) => x.id === set.id) || set;
  const cards = await db.getCards(set.id);
  const saved = await learnSession(set.id);
  const flash = store.json(flashKey(set.id));
  const st = setStats(cards, saved);
  const back = () => setView(set);
  const tile = (name, title, sub, onclick, disabled = false, cls = '') => h('button', { class: `tile ${cls}`, disabled, onclick },
    icon(name), h('span', { class: 'tile-title' }, title), h('span', { class: 'tile-sub' }, sub));

  show(
    topbarNav(libraryView, set.name),
    h('main', { class: 'page stack' },
      h('div', { class: 'hub-head' },
        h('h2', { class: 'hub-title' }, set.name),
        h('div', { class: 'row' }, h('div', { class: 'big-num' }, `${st.pct}%`), h('span', { class: 'muted' }, 'learned')),
        progressBar(st.pct),
        h('div', { class: 'muted' }, statsLine(st))),
      h('div', { class: 'tiles' },
        st.state === 'active'
          ? tile('learn', 'Continue learning', `${st.mastered}/${st.of} mastered`, () => study(set, true, back), false, 'wide')
          : tile('learn', 'Learn', st.state === 'done' ? 'All mastered · learn again' : `${st.total} cards`, () => study(set, false, back), st.total === 0, 'wide'),
        tile('cards', 'Flashcards', flash ? `Resume ${Math.min(flash.pos, flash.deck.length)}/${flash.deck.length}` : `${st.total} cards`,
          () => flashcardsView(set, cards, back)),
        tile('flag', 'Test', `${st.total} cards`, () => testSetupView(set, cards, cards, back), st.total === 0),
        tile('book', 'Cards', `${st.total}`, () => cardsView(set)),
        tile('star', 'Starred', `${st.starred}`, () => cardsView(set, 'starred'), st.starred === 0)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => editView(set) }, icon('pencil'), 'Edit'),
        h('button', { class: 'btn small', onclick: async () => {
          if (confirm(`Delete "${set.name}" and its progress?`)) { await db.deleteSet(set.id); store.del(flashKey(set.id)); libraryView(); }
        } }, icon('trash'), 'Delete'))));
}

// ------------------------------------------------------------------ cards
async function cardsView(set, initialFilter) {
  keyHandler = null;
  const cards = await db.getCards(set.id);
  const imgs = await imageMap(set.id);
  const key = `filter-${set.id}`;
  if (initialFilter) store.set(key, initialFilter);
  let filter = initialFilter || store.get(key, 'all');
  const back = () => { revoke(imgs); setView(set); };

  const allBtn = h('button', { class: 'seg-btn', onclick: () => setFilter('all') });
  const starBtn = h('button', { class: 'seg-btn', onclick: () => setFilter('starred') });
  const flashBtn = h('button', { class: 'btn', onclick: () => {
    revoke(imgs); flashcardsView(set, cards, () => cardsView(set));
  } }, icon('cards'), 'Flashcards');
  // Starts a new Learn session with the cards shown (all or only the starred ones).
  // There is one saved Learn session per set, so an unfinished one gets replaced (after asking).
  const active = Session.restore(await learnSession(set.id), cards) !== null;
  const learnBtn = h('button', { class: 'btn', onclick: () => {
    if (active && !confirm('Start a new Learn session? Your current Learn progress will be replaced.')) return;
    revoke(imgs); study(set, false, () => cardsView(set), { starred: filter === 'starred' });
  } }, icon('learn'), 'Learn');
  const list = h('div', { class: 'stack' });

  const starCount = () => cards.filter((c) => c.starred).length;
  function counts() {
    const m = starCount();
    allBtn.textContent = `All (${cards.length})`;
    starBtn.textContent = `Starred (${m})`;
    allBtn.classList.toggle('on', filter === 'all');
    starBtn.classList.toggle('on', filter === 'starred');
    flashBtn.disabled = cards.length === 0;
    learnBtn.disabled = filter === 'starred' ? m === 0 : cards.length === 0;
  }
  function setFilter(f) { filter = f; store.set(key, f); counts(); draw(); }

  function draw() {
    const shown = cards.filter((c) => filter === 'all' || c.starred);
    list.replaceChildren(...(shown.length ? shown.map((c) => {
      const star = h('button', { class: 'icon star', 'aria-label': 'Star card' });
      const paint = () => { star.replaceChildren(icon(c.starred ? 'starFill' : 'star')); star.classList.toggle('on', !!c.starred); };
      star.onclick = async () => {
        c.starred = !c.starred;
        paint(); counts();
        await db.putMany('cards', [c]);
      };
      paint();
      return h('div', { class: 'card term-row' },
        h('div', { class: 'grow' }, renderSide(c.term, imgs), h('hr'), h('div', { class: 'def' }, renderSide(c.def, imgs))),
        star);
    }) : [h('p', { class: 'muted' }, 'No starred cards yet. Tap the star on a card to star it.')]));
  }

  counts(); draw();
  show(
    topbarNav(back, set.name),
    h('main', { class: 'page stack' }, h('div', { class: 'seg' }, allBtn, starBtn), h('div', { class: 'row' }, flashBtn, learnBtn), list));
}

// ----------------------------------------------------------------- import
function importView() {
  keyHandler = null;
  const st = { images: new Map(), previewUrls: new Map() };
  const name = h('input', { type: 'text', placeholder: 'Set name', autocomplete: 'off' });
  const text = h('textarea', { rows: 6, placeholder: 'Paste your Quizlet export here, or choose a file…', spellcheck: 'false' });
  const preview = h('div', { class: 'preview' });
  const saveBtn = h('button', { class: 'btn primary', disabled: true }, 'Save set');
  const info = h('div', { class: 'muted' });

  const termSel = sepSelect('Between term and definition', [['auto', 'Auto'], ['\\t', 'Tab'], [',', 'Comma'], [';', 'Semicolon'], [' - ', 'Dash ( - )']]);
  const cardSel = sepSelect('Between cards', [['auto', 'New line'], [';', 'Semicolon'], ['\\n\\n', 'Blank line']]);

  function sepSelect(label, opts) {
    const sel = h('select', { onchange: refresh }, ...opts.map(([v, l]) => h('option', { value: v }, l)),
      h('option', { value: 'custom' }, 'Custom…'));
    const custom = h('input', { type: 'text', placeholder: 'separator', hidden: true, oninput: refresh });
    sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; });
    return { el: h('label', { class: 'field' }, label, sel, custom), value: () => (sel.value === 'custom' ? custom.value : sel.value) };
  }

  function refresh() {
    st.previewUrls.forEach((u) => URL.revokeObjectURL(u));
    st.previewUrls = new Map([...st.images].map(([k, v]) => [k, URL.createObjectURL(v.blob)]));
    const pairs = parseCards(text.value, termSel.value(), cardSel.value());
    st.pairs = pairs;
    preview.replaceChildren();
    saveBtn.disabled = !pairs.length || !name.value.trim();
    info.textContent = text.value.trim()
      ? `${pairs.length} cards found${st.images.size ? ` · ${st.images.size} images` : ''}`
      : (st.images.size ? `${st.images.size} images loaded` : '');
    for (const [a, b] of pairs.slice(0, 4)) {
      const n = (s) => (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(s.trim()) || st.images.has(s.trim().toLowerCase())) ? `[img:${s.trim()}]` : s;
      preview.append(h('div', { class: 'card prev-card' }, renderSide(n(a), st.previewUrls), h('hr'), renderSide(n(b), st.previewUrls)));
    }
  }

  const fileIn = h('input', { type: 'file', accept: '.txt,.csv,.tsv,.zip,image/*', multiple: true, hidden: true, onchange: async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      const r = await readFiles(files);
      if (r.backup) {
        const n = await restoreBackup(r.backup);
        toast(`Restored ${n} set${n === 1 ? '' : 's'}`); return libraryView();
      }
      r.images.forEach((v, k) => st.images.set(k, v));
      if (r.text != null) {
        text.value = r.text;
        if (!name.value) name.value = (r.textName || files[0].name).replace(/\.[^.]+$/, '');
      }
      refresh();
    } catch (err) { toast('Could not read file: ' + err.message); }
    e.target.value = '';
  } });

  text.addEventListener('input', refresh);
  name.addEventListener('input', refresh);
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    await saveSet(name.value.trim(), st.pairs, st.images);
    st.previewUrls.forEach((u) => URL.revokeObjectURL(u));
    toast('Set saved'); libraryView();
  });

  show(
    topbarNav(libraryView, 'Import set'),
    h('main', { class: 'page stack' },
      h('button', { class: 'btn primary', onclick: () => fileIn.click() }, icon('folder'), 'Choose file(s)'),
      h('p', { class: 'muted small-text' }, 'Pick a .txt/.csv export, a .zip (text file + images), or a text file together with image files.'),
      fileIn, text, name, termSel.el, cardSel.el, info, preview, saveBtn));
}

// One side of a card: shows the rendered preview; tap it to edit the text, click away to preview again.
// imgs() returns the current image map; onInput(text) runs as the text changes.
function sideEditor(value, label, imgs, onInput = () => {}) {
  const ta = h('textarea', { rows: 2, spellcheck: 'false', 'aria-label': label, hidden: true });
  ta.value = value;
  const prev = h('div', { class: 'side-prev', role: 'button', tabindex: 0, 'aria-label': `Edit ${label.toLowerCase()}` });
  const paint = () => {
    const shown = ta.value.trim();
    prev.classList.toggle('empty', !shown);
    prev.replaceChildren(shown ? renderSide(ta.value, imgs()) : `Tap to add ${label.toLowerCase()}`);
  };
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  const edit = () => {
    prev.hidden = true; ta.hidden = false; fit();
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  prev.onclick = edit;
  prev.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(); } };
  ta.oninput = () => { fit(); onInput(ta.value); };
  ta.onblur = () => { paint(); ta.hidden = true; prev.hidden = false; };
  ta.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); } };
  paint();
  return { el: h('div', { class: 'side-edit' }, prev, ta), ta, edit };
}

// ------------------------------------------------------------------- edit
async function editView(set) {
  keyHandler = null;
  const storedImgs = await db.getImages(set.id);
  const blobs = new Map(storedImgs.map((im) => [im.name.toLowerCase(), { name: im.name, blob: im.blob }]));
  const urls = new Map();
  const urlFor = (k) => { if (!urls.has(k)) urls.set(k, URL.createObjectURL(blobs.get(k).blob)); return urls.get(k); };
  const imgMap = () => new Map([...blobs.keys()].map((k) => [k, urlFor(k)]));
  const cleanup = () => urls.forEach((u) => URL.revokeObjectURL(u));

  const rows = (await db.getCards(set.id)).map((c) => ({ card: c, term: c.term, def: c.def, deleted: false }));
  const originalIds = new Set(rows.map((r) => r.card.id));
  let dirty = false;

  const name = h('input', { type: 'text', value: set.name, placeholder: 'Set name', autocomplete: 'off', oninput: () => { dirty = true; } });
  const list = h('div', { class: 'stack' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });

  function pickImage(row, side) {
    fileIn.onchange = () => {
      const f = fileIn.files[0]; fileIn.value = '';
      if (!f) return;
      let nm = f.name, k = nm.toLowerCase();
      const clash = blobs.has(k) && blobs.get(k).blob.size !== f.size;
      if (clash) { nm = `${db.uid().slice(-5)}-${nm}`; k = nm.toLowerCase(); }
      blobs.set(k, { name: nm, blob: f });
      const tok = `[img:${nm}]`;
      const cur = row[side];
      row[side] = /\[img:[^\]]+\]/i.test(cur) ? cur.replace(/\[img:[^\]]+\]/i, tok) : (cur.trim() ? `${cur.trim()} ${tok}` : tok);
      dirty = true; draw();
    };
    fileIn.click();
  }

  function draw() {
    list.replaceChildren(...rows.filter((r) => !r.deleted).map((row) => {
      const field = (side, label) => {
        const ed = sideEditor(row[side], label, imgMap, (v) => { row[side] = v; dirty = true; });
        const hasImg = /\[img:[^\]]+\]/i.test(row[side]);
        const removeImage = () => {
          row[side] = row[side].replace(/\[img:[^\]]+\]/gi, '').replace(/\s{2,}/g, ' ').trim();
          dirty = true; draw();
        };
        return h('div', { class: 'edit-field' },
          h('div', { class: 'row edit-label' }, h('span', { class: 'label grow' }, label),
            h('button', { class: 'btn small', type: 'button', onclick: () => pickImage(row, side) }, icon('image'), hasImg ? 'Change image' : 'Image'),
            hasImg ? h('button', { class: 'btn small', type: 'button', onclick: removeImage }, icon('x'), 'Remove image') : null),
          ed.el);
      };
      return h('div', { class: 'card stack' },
        field('term', 'Term'), field('def', 'Definition'),
        h('button', { class: 'btn small', onclick: () => { row.deleted = true; dirty = true; draw(); } }, icon('trash'), 'Delete card'));
    }));
  }

  const back = () => { if (!dirty || confirm('Discard your changes?')) { cleanup(); setView(set); } };

  const save = async () => {
    const live = rows.filter((r) => !r.deleted && (r.term.trim() || r.def.trim()));
    if (!name.value.trim()) return toast('Give the set a name');
    if (live.some((r) => !r.term.trim() || !r.def.trim())) return toast('Every card needs a term and a definition');
    saveBtn.disabled = true;
    const names = new Set(blobs.keys());
    const upd = [], fresh = [];
    // Renumber so the order on screen is the order that gets saved.
    live.forEach((r, pos) => {
      const term = normalizeSide(r.term, names), def = normalizeSide(r.def, names);
      if (r.card) upd.push({ ...r.card, term, def, pos });
      else fresh.push(newCard(set.id, term, def, pos));
    });
    const kept = new Set([...upd, ...fresh].map((c) => c.id));
    const removed = [...originalIds].filter((id) => !kept.has(id));
    const used = imagesUsed([...upd, ...fresh].map((c) => [c.term, c.def]));
    if (removed.length) await db.deleteMany('cards', removed);
    await db.putMany('cards', [...upd, ...fresh]);
    const updated = { ...set, name: name.value.trim(), count: upd.length + fresh.length };
    await db.putMany('sets', [updated]);
    const keep = [...blobs].filter(([k]) => used.has(k));
    if (keep.length) await db.putMany('images', keep.map(([k, v]) => ({ key: `${set.id}/${k}`, setId: set.id, name: v.name, blob: v.blob })));
    const drop = storedImgs.map((im) => `${set.id}/${im.name.toLowerCase()}`).filter((key) => !used.has(key.slice(set.id.length + 1)));
    if (drop.length) await db.deleteMany('images', drop);
    cleanup(); toast('Set saved'); setView(updated);
  };

  const saveBtn = h('button', { class: 'btn primary', onclick: save }, 'Save');
  draw();
  show(
    topbarNav(back, 'Edit set'),
    h('main', { class: 'page stack' }, name, list,
      h('button', { class: 'btn', onclick: () => { rows.push({ card: null, term: '', def: '', deleted: false }); dirty = true; draw(); } }, icon('plus'), 'Add card'),
      saveBtn, fileIn));
}

// ------------------------------------------------------------- flashcards
// Two-sided card that turns over on tap. onFlip(flipped) runs after every turn.
function flipCard(frontLabel, front, backLabel, back, imgs, onFlip = () => {}) {
  const face = (cls, label, side) => h('div', { class: `card face ${cls}` }, h('div', { class: 'label' }, label), renderSide(side, imgs));
  let flipped = false;
  const el = h('div', { class: 'flip', role: 'button', tabindex: 0, 'aria-label': 'Flip card', onclick: (e) => {
    if (!e.target.closest('img.zoomable')) flip();
  } }, h('div', { class: 'flip-inner' }, face('front', frontLabel, front), face('back', backLabel, back)));
  function flip() {
    flipped = !flipped;
    el.classList.toggle('flipped', flipped);
    onFlip(flipped);
  }
  return { el, flip };
}

// Star toggle for the card in getCard(). Saves it, then calls onChange(updatedCard).
function starButton(getCard, onChange) {
  const btn = h('button', { class: 'icon star-card', 'aria-label': 'Star card' });
  const paint = (c) => { btn.replaceChildren(icon(c.starred ? 'starFill' : 'star')); btn.classList.toggle('on', !!c.starred); };
  btn.onclick = async () => {
    const card = { ...getCard(), starred: !getCard().starred };
    paint(card);
    onChange(card);
    await db.putMany('cards', [card]);
  };
  paint(getCard());
  return btn;
}

// Modal to fix a card's term/definition. Saves it, calls onSave(updatedCard), then onClose().
function editCardModal(card, imgs, onSave, onClose) {
  const names = new Set(imgs.keys());
  const mk = (label, val) => {
    const ed = sideEditor(val, label, () => imgs);
    return [h('div', { class: 'field' }, label, ed.el), ed.ta];
  };
  const [termEl, termTa] = mk('Term', card.term);
  const [defEl, defTa] = mk('Definition', card.def);
  const close = () => { box.remove(); onClose(); };
  const save = async () => {
    const term = normalizeSide(termTa.value, names), def = normalizeSide(defTa.value, names);
    if (!term || !def) return toast('Term and definition cannot be empty');
    const updated = { ...card, term, def };
    await db.putMany('cards', [updated]);
    onSave(updated);
    toast('Card saved');
    close();
  };
  const box = h('div', { class: 'modal' },
    h('div', { class: 'card stack modal-body' }, h('div', { class: 'handle' }), h('h2', {}, 'Edit card'), termEl, defEl,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: save }, 'Save'))));
  document.body.append(box);
}

const knewButtons = (answer) => h('div', { class: 'row' },
  h('button', { class: 'btn missed', onclick: () => answer(false) }, icon('x'), "Didn't know"),
  h('button', { class: 'btn knew', onclick: () => answer(true) }, icon('check'), 'Knew it'));

// Space/Enter flips; once the answer buttons are shown, 1/← = didn't know, 2/→ = knew it.
const flipKeys = (flip, actions, answer) => (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); return; }
  if (!actions.querySelector('.knew')) return;
  if (e.key === 'ArrowRight' || e.key === '2') answer(true);
  else if (e.key === 'ArrowLeft' || e.key === '1') answer(false);
};

// Flip through the cards. Per-set options: front side, shuffle, track progress, starred only.
// With progress tracking you say whether you knew each card and can review the missed ones afterwards.
// The deck and position are saved after every card so reopening continues where you left off.
// Doesn't change Learn progress.
async function flashcardsView(set, cards, back = libraryView) {
  if (!cards.length) return toast('No cards to study');
  const imgs = await imageMap(set.id);
  const key = flashKey(set.id);
  // Older versions kept one deck per scope ('all' / 'starred'); carry the 'all' one over.
  const legacy = `flash-${set.id}-all`;
  if (!store.get(key) && store.get(legacy)) store.set(key, store.get(legacy));
  store.del(legacy); store.del(`flash-${set.id}-starred`);

  let opts = flashOpts(set);
  let deck = [], pos = 0, missed = [];
  // 'def' direction = term on the front.
  const dirFor = () => (opts.front === 'mixed' ? (Math.random() < 0.5 ? 'term' : 'def') : opts.front === 'term' ? 'def' : 'term');
  const exit = () => { keyHandler = null; revoke(imgs); back(); };
  const persist = () => store.set(key, JSON.stringify({
    deck: deck.map((it) => [it.card.id, it.dir]), pos, missed: missed.map((c) => c.id) }));

  const { header, update } = progressHeader(exit, openOptions);
  const topbar = () => {
    update(Math.round((pos / deck.length) * 100), `${Math.min(pos + 1, deck.length)}/${deck.length}`);
    return header;
  };

  // Cards the options select, in study order (cards come sorted by their position in the set).
  function pool() {
    let list = opts.starred ? cards.filter((c) => c.starred) : cards;
    if (!list.length) { toast('No starred cards yet, showing all'); list = cards; }
    return opts.shuffle ? shuffle(list) : list;
  }

  function start(list = pool()) {
    deck = list.map((card) => ({ card, dir: dirFor() }));
    pos = 0; missed = [];
    persist();
    showCard();
  }

  // Rebuild a saved deck. Cards deleted since are dropped. Returns false if nothing is left.
  function restore() {
    const saved = store.json(key);
    if (!saved || !Array.isArray(saved.deck)) return false;
    const byId = new Map(cards.map((c) => [c.id, c]));
    // Count dropped cards before the saved position so it still points at the same card.
    const before = saved.deck.slice(0, saved.pos).filter(([id]) => !byId.has(id)).length;
    deck = saved.deck.filter(([id]) => byId.has(id)).map(([id, dir]) => ({ card: byId.get(id), dir }));
    if (!deck.length) return false;
    pos = Math.min(Math.max(0, saved.pos - before), deck.length);
    missed = (saved.missed || []).filter((id) => byId.has(id)).map((id) => byId.get(id));
    return true;
  }

  function showCard() {
    if (pos >= deck.length) return summary();
    const it = deck[pos];
    const [frontLabel, backLabel] = it.dir === 'def' ? ['Term', 'Definition'] : ['Definition', 'Term'];
    const [front, backSide] = it.dir === 'def' ? [it.card.term, it.card.def] : [it.card.def, it.card.term];
    const actions = h('div', { class: 'actions' });
    const go = (step) => { pos = Math.max(0, pos + step); persist(); showCard(); };
    const answer = (knew) => { if (!knew) missed.push(it.card); go(1); };
    const card = flipCard(frontLabel, front, backLabel, backSide, imgs, (flipped) => {
      if (opts.track && flipped && !actions.querySelector('.knew')) actions.replaceChildren(knewButtons(answer));
    });
    const starBtn = starButton(() => it.card, replaceCard);
    const editBtn = h('button', { class: 'icon edit-card', 'aria-label': 'Edit card', onclick: () => {
      keyHandler = null;
      editCardModal(it.card, imgs, replaceCard, showCard);
    } }, icon('pencil'));

    if (opts.track) {
      actions.append(h('button', { class: 'btn primary', onclick: card.flip }, 'Flip'));
      keyHandler = flipKeys(card.flip, actions, answer);
    } else {
      // Just browsing: flip and move back and forth.
      actions.append(h('div', { class: 'row' },
        h('button', { class: 'btn', disabled: pos === 0, 'aria-label': 'Previous card', onclick: () => go(-1) }, icon('back')),
        h('button', { class: 'btn primary grow', onclick: card.flip }, 'Flip'),
        h('button', { class: 'btn', 'aria-label': 'Next card', onclick: () => go(1) }, icon('chevron'))));
      keyHandler = (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); card.flip(); }
        else if (e.key === 'ArrowRight') go(1);
        else if (e.key === 'ArrowLeft' && pos > 0) go(-1);
      };
    }
    show(topbar(),
      h('main', { class: 'page stack flash-page' }, h('div', { class: 'flip-tools' }, starBtn, editBtn), card.el,
        h('p', { class: 'muted small-text center' }, 'Tap the card to flip it')),
      actions);
  }

  // Swap in an edited/starred card everywhere this view holds it.
  function replaceCard(card) {
    const swap = (c) => (c.id === card.id ? card : c);
    deck.forEach((it) => { it.card = swap(it.card); });
    missed = missed.map(swap);
    cards = cards.map(swap);
  }

  function summary() {
    const done = () => { store.del(key); exit(); };
    if (!opts.track) {
      // Nothing to continue once every card has been seen.
      store.del(key);
      const restart = h('button', { class: 'btn primary', onclick: () => start() }, 'Restart');
      keyHandler = (e) => e.key === 'Enter' && restart.click();
      show(topbar(),
        h('main', { class: 'page stack center' },
          h('div', { class: 'big-num' }, `${deck.length}`),
          h('h2', {}, 'End of the deck'),
          h('p', { class: 'muted' }, `You went through all ${deck.length} card${deck.length === 1 ? '' : 's'}`)),
        h('div', { class: 'actions' }, restart, h('button', { class: 'btn ghost', onclick: done }, 'Done')));
      return;
    }
    const knew = deck.length - missed.length;
    const again = missed;
    // All known: nothing left to continue. Otherwise keep the summary until Done.
    if (!again.length) store.del(key);
    const primary = again.length
      ? h('button', { class: 'btn primary', onclick: () => start(opts.shuffle ? shuffle(again) : again) }, `Review ${again.length} missed card${again.length === 1 ? '' : 's'}`)
      : h('button', { class: 'btn primary', onclick: done }, 'Done');
    keyHandler = (e) => e.key === 'Enter' && primary.click();
    show(topbar(),
      h('main', { class: 'page stack center' },
        h('div', { class: 'big-num' }, `${knew}/${deck.length}`),
        h('h2', {}, again.length ? 'Round complete' : 'You knew them all'),
        h('p', { class: 'muted' }, `Knew ${knew} of ${deck.length}${again.length ? ` · ${again.length} still learning` : ''}`)),
      h('div', { class: 'actions' }, primary,
        h('button', { class: 'btn', onclick: () => start() }, 'Restart'),
        again.length ? h('button', { class: 'btn ghost', onclick: done }, 'Done') : null));
  }

  function openOptions() {
    const before = { ...opts };
    const save = () => { set = { ...set, flash: { ...opts } }; saveSetRecord(set).catch(() => toast('Could not save options')); };
    const box = (label, k) => h('label', { class: 'card check' },
      h('input', { type: 'checkbox', checked: opts[k], onchange: (e) => { opts[k] = e.target.checked; save(); } }), label);
    const frontSel = h('select', { onchange: (e) => { opts.front = e.target.value; save(); } },
      ...[['term', 'Term'], ['def', 'Definition'], ['mixed', 'Both']].map(([v, l]) => h('option', { value: v, selected: opts.front === v }, l)));
    const starred = cards.filter((c) => c.starred).length;
    const sheet = optionsSheet('Flashcard options', [
      h('label', { class: 'field' }, 'Front of the card', frontSel),
      h('div', { class: 'field' }, 'Options',
        box('Shuffle', 'shuffle'),
        box("Track progress (Knew it / Didn't know)", 'track'),
        box(`Starred only (${starred})`, 'starred')),
      h('p', { class: 'muted small-text' }, 'Changing Shuffle or Starred only starts the deck over.'),
      h('button', { class: 'btn', onclick: () => {
        if (!confirm('Start over from the first card?')) return;
        sheet.remove(); start();
      } }, icon('refresh'), 'Start over'),
    ], () => applyOptions(before));
  }

  function applyOptions(before) {
    const rebuild = before.shuffle !== opts.shuffle || before.starred !== opts.starred;
    if (rebuild && (pos === 0 || pos >= deck.length || confirm('Start the deck over with the new options?'))) return start();
    // Front side: re-pick the cards that are still to come.
    if (before.front !== opts.front) { deck.slice(pos).forEach((it) => { it.dir = dirFor(); }); persist(); }
    if (before.front !== opts.front || before.track !== opts.track) showCard();
  }

  if (restore()) {
    if (pos < deck.length) toast(`Continuing at ${pos + 1}/${deck.length}`);
    showCard();
  } else start();
}

// ------------------------------------------------------------------- test
// Options first: how many questions and which kinds. Remembered for next time.
function testSetupView(set, cards, allCards, back = () => setView(set)) {
  keyHandler = null;
  if (!cards.length) return toast('No cards to test');
  const saved = store.json('test-opts') || {};
  const types = Array.isArray(saved.types) && saved.types.some((t) => TEST_TYPES.includes(t)) ? saved.types : TEST_TYPES;
  const count = h('input', { type: 'number', min: 1, max: cards.length, inputmode: 'numeric',
    value: Math.min(cards.length, saved.count || 20) });
  const boxes = TEST_TYPES.map((t) => h('input', { type: 'checkbox', value: t, checked: types.includes(t), onchange: (e) => {
    if (!boxes.some((b) => b.checked)) { e.target.checked = true; toast('Pick at least one'); }
  } }));
  const start = () => {
    const n = Math.max(1, Math.min(cards.length, parseInt(count.value, 10) || cards.length));
    const opts = { count: n, types: boxes.filter((b) => b.checked).map((b) => b.value) };
    store.set('test-opts', JSON.stringify(opts));
    testView(set, cards, allCards, opts, back);
  };
  keyHandler = (e) => e.key === 'Enter' && start();
  show(
    topbarNav(back, 'Test'),
    h('main', { class: 'page stack' },
      h('div', { class: 'set-name' }, set.name),
      h('label', { class: 'field' }, `Questions (max ${cards.length})`, count),
      h('div', { class: 'field' }, 'Question types',
        ...boxes.map((b) => h('label', { class: 'card check' }, b, TEST_TYPE_NAMES[b.value]))),
      h('p', { class: 'muted small-text' }, 'Each card is asked once and graded at the end. Tests don\'t change your Learn progress.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: start }, 'Start test')));
}

// All questions on one page; nothing is marked until the test is submitted.
async function testView(set, cards, allCards, opts, back) {
  keyHandler = null;
  const qs = buildTest(cards, allCards, { ...opts, dir: learnDirOf(set) });
  if (!qs.length) return toast('Not enough cards for these question types');
  const imgs = await imageMap(set.id);
  const answers = new Array(qs.length).fill(null);
  const answered = () => answers.filter((a) => a != null && a !== '').length;
  const exit = () => { keyHandler = null; revoke(imgs); back(); };
  const close = () => { if (!answered() || confirm('Leave the test? Your answers will be lost.')) exit(); };
  const { header, update } = progressHeader(close);
  const refresh = () => update(Math.round((answered() / qs.length) * 100), `${answered()}/${qs.length}`);
  const labels = (q) => (q.dir === 'def' ? ['Term', 'Definition'] : ['Definition', 'Term']);

  const blocks = qs.map((q, i) => {
    const [promptLabel, answerLabel] = labels(q);
    const box = h('div', { class: 'card stack test-q' },
      h('div', { class: 'q-num' }, `${i + 1} of ${qs.length} · ${TEST_TYPE_NAMES[q.type]}`),
      h('div', { class: 'label' }, promptLabel), renderSide(q.prompt, imgs));
    const choose = (buttons, values) => buttons.forEach((b, j) => b.addEventListener('click', () => {
      answers[i] = values[j];
      buttons.forEach((x, k) => x.classList.toggle('sel', k === j));
      refresh();
    }));
    if (q.type === 'tf') {
      box.append(h('hr'), h('div', { class: 'label' }, answerLabel), renderSide(q.shown, imgs));
      const buttons = [h('button', { class: 'opt' }, 'True'), h('button', { class: 'opt' }, 'False')];
      choose(buttons, [true, false]);
      box.append(h('div', { class: 'tf' }, ...buttons));
    } else if (q.type === 'mc') {
      const buttons = q.options.map((o, j) => h('button', { class: 'opt' }, h('span', { class: 'num' }, j + 1), renderSide(o, imgs)));
      choose(buttons, q.options);
      box.append(h('div', { class: 'label' }, `Choose the ${answerLabel.toLowerCase()}`), h('div', { class: 'opts' }, ...buttons));
    } else {
      const input = h('input', { type: 'text', class: 'answer', placeholder: `Type the ${answerLabel.toLowerCase()}`,
        autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'next',
        oninput: (e) => { answers[i] = e.target.value; refresh(); } });
      // Enter jumps to the next written answer instead of submitting.
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const all = [...document.querySelectorAll('.test-q input.answer')];
        const next = all[all.indexOf(input) + 1];
        if (next) next.focus(); else input.blur();
      });
      box.append(h('div', { class: 'label' }, answerLabel), input);
    }
    return box;
  });

  const submit = () => {
    const left = qs.length - answered();
    if (left && !confirm(`${left} question${left === 1 ? '' : 's'} unanswered. Submit anyway?`)) return;
    results();
  };

  function results() {
    keyHandler = null;
    const ok = qs.map((q, i) => gradeTest(q, answers[i]));
    const score = h('div', { class: 'big-num' });
    const pct = h('p', { class: 'muted' });
    const retake = h('button', { class: 'btn primary' });
    const paint = () => {
      const n = ok.filter(Boolean).length;
      score.textContent = `${n}/${qs.length}`;
      pct.textContent = `${Math.round((n / qs.length) * 100)}% correct`;
      const missed = qs.length - n;
      retake.textContent = `Retake ${missed} missed`;
      retake.hidden = missed === 0;
    };
    retake.onclick = () => {
      const missed = qs.filter((_, i) => !ok[i]).map((q) => q.card);
      revoke(imgs);
      testView(set, missed, allCards, { ...opts, count: missed.length }, back);
    };
    const yours = (q, a) => {
      if (a == null || a === '') return h('div', { class: 'txt muted' }, 'No answer');
      if (q.type === 'tf') return h('div', { class: 'txt' }, a ? 'True' : 'False');
      if (q.type === 'mc') return renderSide(a, imgs);
      return h('div', { class: 'txt' }, a);
    };
    const rows = qs.map((q, i) => {
      const [promptLabel, answerLabel] = labels(q);
      const row = h('div', { class: 'card stack test-q' });
      const draw = () => {
        const a = answers[i];
        row.replaceChildren(
          h('div', { class: 'row' },
            h('div', { class: 'q-num grow' }, `${i + 1} · ${TEST_TYPE_NAMES[q.type]}`),
            h('span', { class: ok[i] ? 'ok-pill' : 'bad-pill' }, ok[i] ? icon('check') : icon('x'))),
          h('div', { class: 'label' }, promptLabel), renderSide(q.prompt, imgs),
          q.type === 'tf' ? h('div', {}, h('div', { class: 'label' }, `Shown ${answerLabel.toLowerCase()}`), renderSide(q.shown, imgs)) : null,
          h('div', { class: `feedback${ok[i] ? ' good' : ''}` }, h('div', { class: 'label' }, 'Your answer'), yours(q, a)),
          ok[i] ? null : h('div', { class: 'feedback good' }, h('div', { class: 'label' }, `Correct ${answerLabel.toLowerCase()}`),
            q.type === 'tf' ? h('div', { class: 'txt' }, q.truth ? 'True' : `False — ${answerLabel.toLowerCase()} is:`) : null,
            q.type === 'tf' && q.truth ? null : renderSide(q.answer, imgs)),
          !ok[i] && q.type === 'write' && a ? h('button', { class: 'btn small', onclick: () => { ok[i] = true; draw(); paint(); } }, 'I was right') : null);
      };
      draw();
      return row;
    });
    paint();
    show(topbarNav(exit, 'Test results', 'close'),
      h('main', { class: 'page stack' },
        h('div', { class: 'center stack' }, score, pct), ...rows),
      h('div', { class: 'actions' }, retake,
        h('button', { class: 'btn', onclick: () => { revoke(imgs); testView(set, cards, allCards, opts, back); } }, 'New test'),
        h('button', { class: 'btn ghost', onclick: exit }, 'Done')));
  }

  refresh();
  show(header, h('main', { class: 'page stack' }, ...blocks),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: submit }, 'Submit test')));
}

// ------------------------------------------------------------------ study
// Learn: every card of the set (or the starred ones) goes through the chosen steps until it is mastered.
// Progress is saved after every step; resume = continue the saved session.
// starred: learn only the starred cards (default: the set's "Starred only" option).
async function study(set, resume = false, back = libraryView, opts = {}) {
  let starred = opts.starred ?? !!set.learnStarred;
  const cards = await db.getCards(set.id);
  let session = null;
  if (resume) {
    const saved = await learnSession(set.id);
    session = Session.restore(saved, cards);
    if (saved && typeof saved.starred === 'boolean') starred = saved.starred;
    if (!session) { await db.deleteSession(set.id); toast('Saved session is no longer available'); return back(); }
  }
  const imgs = await imageMap(set.id);
  if (!session) {
    let pool = learnPool(cards, starred);
    if (!pool.length && starred) { toast('No starred cards yet, learning all'); pool = learnPool(cards); }
    if (!pool.length) { revoke(imgs); toast('No cards to learn'); return back(); }
    session = new Session(pool, cards, { dir: learnDirOf(set), modes: modesFor(set) });
  }
  // A finished session is kept as a small "done" record so the set shows it as mastered.
  const persist = () => db.saveSession(session.finished
    ? { setId: set.id, mode: 'learn', done: true, total: session.total, mastered: session.mastered, steps: session.steps, stepsTotal: session.stepsTotal }
    : { setId: set.id, starred, ...session.toJSON() }).catch(() => {});
  let closed = false;
  const leave = () => { closed = true; keyHandler = null; revoke(imgs); };
  const exit = () => { leave(); back(); };
  const restart = () => { leave(); study(set, false, back, { starred }); };

  const { header, update } = progressHeader(exit, learnOptions);
  const topbar = () => {
    update(Math.round(session.progress * 100), `${session.mastered}/${session.total}`);
    return header;
  };

  // Learn options for this set: answer direction, steps, starred only, plus Start over.
  // Changes are saved to the set right away and used when Learn starts over.
  function learnOptions() {
    const active = modesFor(set);
    const save = (patch) => { set = { ...set, ...patch }; saveSetRecord(set).catch(() => toast('Could not save options')); };
    let changed = false;
    const boxes = STAGES.map((st) => h('input', { type: 'checkbox', value: st, checked: active.includes(st), onchange: (e) => {
      const stages = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!stages.length) { e.target.checked = true; return toast('Pick at least one'); }
      save({ stages });
      // Apply to the running session too, so e.g. a newly ticked Flashcards step shows up right away.
      if (session.setModes(modesFor(set))) { changed = true; persist(); }
    } }));
    const starredCount = cards.filter((c) => c.starred).length;
    const rerender = () => {
      if (!changed || closed || session.finished) return;
      if (session.roundDone) roundSummary(); else question();
    };
    const sheet = optionsSheet('Learn options', [
      h('label', { class: 'field' }, 'Answer with', dirSelect(learnDirOf(set), (learnDir) => {
        save({ learnDir });
        session.dir = learnDir;
        persist();
      })),
      h('div', { class: 'field' }, 'Steps',
        ...boxes.map((b) => h('label', { class: 'card check' }, b, STAGE_NAMES[b.value]))),
      h('div', { class: 'field' }, 'Cards',
        h('label', { class: 'card check' },
          h('input', { type: 'checkbox', checked: starred, onchange: (e) => { starred = e.target.checked; save({ learnStarred: starred }); } }),
          `Starred only (${starredCount})`)),
      h('p', { class: 'muted small-text' },
        'Cards go through the checked steps in this order. Steps apply right away, the answer direction from the next round, Starred only when you start over.'),
      h('button', { class: 'btn', onclick: async () => {
        if (!confirm('Start over? Your progress in Learn will be lost.')) return;
        sheet.remove();
        await db.deleteSession(set.id);
        restart();
      } }, icon('refresh'), 'Start over'),
    ], rerender);
  }

  // Swap in an edited/starred card for the current item and the set's card list.
  function updateCard(it, card) {
    it.card = card;
    const i = cards.findIndex((c) => c.id === card.id);
    if (i >= 0) cards[i] = card;
    persist();
  }

  // Fix a typo in the current card without leaving the session.
  function editCurrent(it) {
    keyHandler = null;
    editCardModal(it.card, imgs, (card) => updateCard(it, card), question);
  }

  function nextRound() {
    if (!session.startRound()) return finish();
    persist();
    question();
  }

  function roundSummary() {
    keyHandler = (e) => e.key === 'Enter' && nextRound();
    const rows = session.items.map((it) => h('div', { class: 'card sum-row' },
      h('div', { class: 'grow' }, renderSide(session.prompt(it), imgs)),
      h('span', { class: it.misses ? 'bad-pill' : 'ok-pill' }, it.misses ? `${it.misses} miss${it.misses > 1 ? 'es' : ''}` : icon('check'))));
    show(topbar(),
      h('main', { class: 'page stack' }, h('h2', {}, h('span', { class: 'dot' }), ` Round ${session.round} complete`), ...rows),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: nextRound }, session.pending.length ? 'Next round' : 'Finish')));
  }

  function finish() {
    keyHandler = null;
    persist();
    show(topbar(),
      h('main', { class: 'page stack center' },
        h('div', { class: 'big-num' }, `${session.perfect}/${session.total}`), h('h2', {}, 'All cards mastered'),
        h('p', {}, `${session.total} cards learned · ${session.perfect} correct first time`)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: exit }, 'Done'),
        h('button', { class: 'btn', onclick: restart }, icon('refresh'), 'Learn again')));
  }

  function question() {
    if (session.roundDone) return roundSummary();
    const it = session.current;
    const kind = session.kind(it);
    const label = it.dir === 'def' ? 'Term' : 'Definition';
    const answerLabel = it.dir === 'def' ? 'Definition' : 'Term';
    const answer = session.answer(it);
    const starBtn = starButton(() => it.card, (card) => updateCard(it, card));
    const editBtn = h('button', { class: 'icon edit-card', 'aria-label': 'Edit card', onclick: () => editCurrent(it) }, icon('pencil'));
    const stage = h('div', { class: 'stage' });
    const actions = h('div', { class: 'actions' });

    const proceed = (ok, delay) => {
      session.submit(ok);
      persist();
      keyHandler = null;
      // Leaving during the short "correct" pause must not re-render the question over the next view.
      if (delay) setTimeout(() => { if (!closed) question(); }, delay); else question();
    };
    const waitContinue = (ok) => {
      actions.replaceChildren(h('button', { class: 'btn primary', onclick: () => proceed(ok) }, 'Continue'));
      keyHandler = (e) => e.key === 'Enter' && proceed(ok);
    };

    // Flashcard stage: flip, then grade yourself.
    if (kind === 'flash') {
      const card = flipCard(label, session.prompt(it), answerLabel, answer, imgs, (flipped) => {
        if (flipped && !actions.querySelector('.knew')) actions.replaceChildren(knewButtons(proceed));
      });
      actions.append(h('button', { class: 'btn primary', onclick: card.flip }, 'Flip'));
      show(topbar(),
        h('main', { class: 'page stack study-flip' }, h('div', { class: 'flip-tools' }, starBtn, editBtn), card.el,
          h('p', { class: 'muted small-text center' }, 'Tap the card to flip it')),
        actions);
      keyHandler = flipKeys(card.flip, actions, proceed);
      return;
    }

    const promptBox = h('div', { class: 'card prompt' },
      starBtn, editBtn, h('div', { class: 'label' }, label), renderSide(session.prompt(it), imgs));
    const stack = h('main', { class: 'page stack' }, promptBox, stage);
    show(topbar(), stack, actions);

    if (kind === 'mc') {
      stage.append(h('div', { class: 'label' }, `Choose the ${answerLabel.toLowerCase()}`));
      const opts = session.options(it);
      let locked = false;
      const buttons = opts.map((o, i) => {
        const b = h('button', { class: 'opt', onclick: () => pick(i) }, h('span', { class: 'num' }, i + 1), renderSide(o, imgs));
        return b;
      });
      const pick = (i) => {
        if (locked) return; locked = true;
        const ok = opts[i] === answer.trim();
        buttons.forEach((b, j) => { b.disabled = true; if (opts[j] === answer.trim()) b.classList.add('ok'); });
        if (ok) return proceed(true, 750);
        buttons[i].classList.add('bad');
        navigator.vibrate && navigator.vibrate(120);
        waitContinue(false);
      };
      stage.append(h('div', { class: 'opts' }, ...buttons));
      keyHandler = (e) => { const n = parseInt(e.key, 10); if (n >= 1 && n <= opts.length) pick(n - 1); };
    } else if (kind === 'write') {
      const input = h('input', { type: 'text', class: 'answer', placeholder: `Type the ${answerLabel.toLowerCase()}`,
        autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' });
      stage.append(h('div', { class: 'label' }, answerLabel), input);
      const grade = (typed) => {
        input.disabled = true;
        const ok = typed !== null && session.check(it, typed);
        if (ok) { input.classList.add('ok'); return proceed(true, 750); }
        navigator.vibrate && navigator.vibrate(120);
        input.classList.add('bad');
        // append() would turn null into the text "null", so only pass real nodes.
        stage.append(...[
          typed ? h('div', { class: 'feedback' }, h('div', { class: 'label' }, 'Your answer'), h('div', { class: 'txt' }, typed)) : null,
          h('div', { class: 'feedback good' }, h('div', { class: 'label' }, 'Correct answer'), renderSide(answer, imgs))].filter(Boolean));
        const rightBtn = typed ? h('button', { class: 'btn', onclick: () => proceed(true) }, 'I was right') : null;
        // Image-only answers can't be typed, so those skip the retype step.
        if (!hasText(answer)) {
          actions.replaceChildren(...[h('button', { class: 'btn primary', onclick: () => proceed(false) }, 'Continue'), rightBtn].filter(Boolean));
          keyHandler = (e) => e.key === 'Enter' && proceed(false);
          window.scrollTo(0, document.body.scrollHeight);
          return;
        }
        // Wrong answers must be retyped correctly; it moves on by itself once the retype matches.
        const retype = h('input', { type: 'text', class: 'answer', placeholder: 'Type the correct answer',
          autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' });
        let done = false;
        retype.addEventListener('input', () => {
          if (done) return;
          retype.classList.remove('bad');
          if (!session.check(it, retype.value)) return;
          done = true;
          retype.disabled = true;
          retype.classList.add('ok');
          proceed(false);
        });
        retype.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault(); e.stopPropagation();
          retype.classList.add('bad');
          navigator.vibrate && navigator.vibrate(60);
        });
        stage.append(h('div', { class: 'label' }, 'Retype the correct answer'), retype);
        actions.replaceChildren(...[rightBtn].filter(Boolean));
        keyHandler = null;
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => retype.focus({ preventScroll: true }), 50);
      };
      const submit = h('button', { class: 'btn primary', onclick: () => grade(input.value) }, 'Answer');
      actions.append(submit, h('button', { class: 'btn ghost', onclick: () => grade(null) }, "Don't know"));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); grade(input.value); } });
      keyHandler = null;
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    } else {
      actions.append(h('button', { class: 'btn primary', onclick: () => {
        stage.append(h('div', { class: 'feedback good' }, h('div', { class: 'label' }, answerLabel), renderSide(answer, imgs)));
        actions.replaceChildren(
          h('button', { class: 'btn primary', onclick: () => proceed(true) }, 'Got it'),
          h('button', { class: 'btn', onclick: () => proceed(false) }, 'Missed'));
      } }, 'Show answer'));
    }
  }

  if (!resume) nextRound();
  else if (session.queue.length) question();
  else if (session.items.length) roundSummary();
  else nextRound();
}

// ------------------------------------------------------------------- boot
libraryView();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
