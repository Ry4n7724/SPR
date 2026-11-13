import * as db from './db.js';
import { h, renderSide, sideText, hasText } from './content.js';
import { parseCards, readFiles, saveSet, exportBackup, restoreBackup, newCard, normalizeSide, imagesUsed } from './import.js';
import { Session, buildPool, isDue, dayNum, modesFor, shuffle, STAGES, STAGE_NAMES } from './learn.js';
import { icon } from './icons.js';

const app = document.getElementById('app');
const show = (...els) => { app.replaceChildren(...els); window.scrollTo(0, 0); };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
};
// Flashcard position per set and scope ('all' or 'starred').
const flashKey = (setId, scope) => `flash-${setId}-${scope}`;
let keyHandler = null;
document.addEventListener('keydown', (e) => keyHandler && keyHandler(e));

// Tap any image to see it fullscreen.
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img.zoomable');
  if (!img) return;
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

// Close button + progress bar + counter. Built once and updated in place so the width transition animates.
function progressHeader(onExit) {
  const bar = h('div', { style: 'width:0%' });
  const track = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar);
  const count = h('span', { class: 'muted count' });
  const header = h('header', { class: 'topbar' },
    h('button', { class: 'icon', 'aria-label': 'Close', onclick: onExit }, icon('close')), track, count);
  return {
    header,
    update(pct, text) { bar.style.width = `${pct}%`; track.setAttribute('aria-valuenow', pct); count.textContent = text; },
  };
}

function setStats(cards, today) {
  const total = cards.length;
  const learned = cards.filter((c) => c.state === 'review').length;
  const due = cards.filter((c) => isDue(c, today)).length;
  const fresh = cards.filter((c) => c.state === 'new').length;
  const starred = cards.filter((c) => c.starred).length;
  return { total, learned, due, fresh, starred, todo: due + Math.min(fresh, 15), pct: total ? Math.round((learned / total) * 100) : 0 };
}
const statsLine = (st) => `${st.total} cards · ${st.due} due · ${st.fresh} new${st.starred ? ` · ${st.starred} starred` : ''}`;
const progressBar = (pct) => h('div', {
  class: 'progress', role: 'progressbar', 'aria-label': 'Learned', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct,
}, h('div', { style: `width:${pct}%` }));

// ---------------------------------------------------------------- library
async function libraryView() {
  keyHandler = null;
  const sets = (await db.getSets()).sort((a, b) => b.created - a.created);
  const today = dayNum();
  const dirSel = h('select', { onchange: (e) => store.set('dir', e.target.value) },
    ...[['def', 'Definition'], ['term', 'Term'], ['mixed', 'Both']].map(([v, l]) =>
      h('option', { value: v, selected: store.get('dir', 'def') === v }, l)));

  const list = h('div', { class: 'list' });
  for (const s of sets) {
    const cards = await db.getCards(s.id);
    const st = setStats(cards, today);
    const saved = await db.getSession(s.id);
    const primary = saved
      ? h('button', { class: 'btn primary', onclick: () => study(s, saved.mode, true) },
        `Resume ${saved.mode === 'learn' ? 'learn' : saved.mode === 'starred' ? 'starred' : 'practice'} (${saved.mastered}/${saved.total})`)
      : h('button', { class: 'btn primary', disabled: st.todo === 0, onclick: () => study(s, 'learn') },
        st.todo ? `Learn (${st.todo})` : 'All done today');
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
      sets.length ? h('label', { class: 'inline' }, 'Answer with ', dirSel) : null,
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
  const saved = await db.getSession(set.id);
  const flash = store.json(flashKey(set.id, 'all'));
  const st = setStats(cards, dayNum());
  const back = () => setView(set);
  const tile = (name, title, sub, onclick, disabled = false) => h('button', { class: 'tile', disabled, onclick },
    icon(name), h('span', { class: 'tile-title' }, title), h('span', { class: 'tile-sub' }, sub));
  const modeLabel = modesFor(set).map((s) => ({ flash: 'Flash', mc: 'MC', write: 'Written' })[s]).join(' + ');

  show(
    topbarNav(libraryView, set.name),
    h('main', { class: 'page stack' },
      h('div', { class: 'hub-head' },
        h('h2', { class: 'hub-title' }, set.name),
        h('div', { class: 'row' }, h('div', { class: 'big-num' }, `${st.pct}%`), h('span', { class: 'muted' }, 'learned')),
        progressBar(st.pct),
        h('div', { class: 'muted' }, statsLine(st))),
      h('div', { class: 'tiles' },
        tile('cards', 'Flashcards', flash ? `Resume ${Math.min(flash.pos, flash.deck.length)}/${flash.deck.length}` : `${st.total} cards`,
          () => flashcardsView(set, cards, back, 'all')),
        saved
          ? tile('learn', 'Resume', `${saved.mastered}/${saved.total}`, () => study(set, saved.mode, true, back))
          : tile('learn', 'Learn', st.todo ? `${st.todo} to do` : 'All done today', () => study(set, 'learn', false, back), st.todo === 0),
        tile('play', 'Practice all', 'No scheduling', () => study(set, 'practice', false, back)),
        tile('book', 'Cards', `${st.total}`, () => cardsView(set)),
        tile('star', 'Starred', `${st.starred}`, () => cardsView(set, 'starred'), st.starred === 0),
        tile('gear', 'Settings', modeLabel, () => settingsView(set))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => editView(set) }, icon('pencil'), 'Edit'),
        h('button', { class: 'btn small', onclick: async () => {
          if (confirm(`Delete "${set.name}" and its progress?`)) { await db.deleteSet(set.id); libraryView(); }
        } }, icon('trash'), 'Delete'),
        saved || flash ? h('button', { class: 'btn small', onclick: async () => {
          if (!confirm(`Discard the saved progress for "${set.name}"?`)) return;
          await db.deleteSession(set.id);
          store.del(flashKey(set.id, 'all')); store.del(flashKey(set.id, 'starred'));
          setView(set);
        } }, icon('refresh'), 'Start over') : null)));
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
  const learnBtn = h('button', { class: 'btn primary', onclick: () => { revoke(imgs); study(set, 'starred', false, () => cardsView(set)); } });
  const flashBtn = h('button', { class: 'btn', onclick: () => {
    revoke(imgs); flashcardsView(set, cards.filter((c) => filter === 'all' || c.starred), () => cardsView(set), filter);
  } }, icon('cards'), 'Flashcards');
  const list = h('div', { class: 'stack' });

  const starCount = () => cards.filter((c) => c.starred).length;
  function counts() {
    const m = starCount();
    allBtn.textContent = `All (${cards.length})`;
    starBtn.textContent = `Starred (${m})`;
    allBtn.classList.toggle('on', filter === 'all');
    starBtn.classList.toggle('on', filter === 'starred');
    learnBtn.textContent = `Learn starred (${m})`;
    learnBtn.disabled = m === 0;
    flashBtn.disabled = filter === 'starred' ? m === 0 : cards.length === 0;
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

// --------------------------------------------------------------- settings
function settingsView(set) {
  keyHandler = null;
  const active = modesFor(set);
  const boxes = STAGES.map((s) => h('input', { type: 'checkbox', value: s, checked: active.includes(s), onchange: save }));
  async function save(e) {
    const stages = boxes.filter((b) => b.checked).map((b) => b.value);
    if (!stages.length) { e.target.checked = true; return toast('Pick at least one'); }
    set = { ...set, stages };
    await db.putMany('sets', [set]);
    toast('Saved');
  }
  show(
    topbarNav(() => setView(set), 'Settings'),
    h('main', { class: 'page stack' },
      h('div', { class: 'set-name' }, set.name),
      h('div', { class: 'field' }, 'Learn with',
        ...boxes.map((b) => h('label', { class: 'card check' }, b, STAGE_NAMES[b.value]))),
      h('p', { class: 'muted small-text' }, 'Cards go through the checked steps in this order. Applies to the next session; a saved session keeps the steps it started with.')));
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
    const map = imgMap();
    list.replaceChildren(...rows.filter((r) => !r.deleted).map((row) => {
      const field = (side, label) => {
        const prev = h('div', { class: 'edit-prev' }, renderSide(row[side], map));
        const ta = h('textarea', { rows: 2, spellcheck: 'false', 'aria-label': label, oninput: (e) => {
          row[side] = e.target.value; dirty = true; prev.replaceChildren(renderSide(row[side], imgMap()));
        } });
        ta.value = row[side];
        const hasImg = /\[img:[^\]]+\]/i.test(row[side]);
        const removeImage = () => {
          row[side] = row[side].replace(/\[img:[^\]]+\]/gi, '').replace(/\s{2,}/g, ' ').trim();
          dirty = true; draw();
        };
        return h('div', { class: 'edit-field' },
          h('div', { class: 'row edit-label' }, h('span', { class: 'label grow' }, label),
            h('button', { class: 'btn small', type: 'button', onclick: () => pickImage(row, side) }, icon('image'), hasImg ? 'Change image' : 'Image'),
            hasImg ? h('button', { class: 'btn small', type: 'button', onclick: removeImage }, icon('x'), 'Remove image') : null),
          ta, prev);
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

// Flip a card, then say whether you knew it. Doesn't change the review schedule.
// The position is saved after every answer so reopening continues where you left off.
async function flashcardsView(set, cards, back = libraryView, scope = 'all') {
  if (!cards.length) return toast('No cards to study');
  const imgs = await imageMap(set.id);
  const dirPref = store.get('dir', 'def');
  const key = flashKey(set.id, scope);
  let deck = [], pos = 0, missed = [];
  const exit = () => { keyHandler = null; revoke(imgs); back(); };
  const persist = () => store.set(key, JSON.stringify({
    deck: deck.map((it) => [it.card.id, it.dir]), pos, missed: missed.map((c) => c.id) }));

  const { header, update } = progressHeader(exit);
  const topbar = () => {
    update(Math.round((pos / deck.length) * 100), `${Math.min(pos + 1, deck.length)}/${deck.length}`);
    return header;
  };

  function start(list) {
    deck = shuffle(list).map((card) => ({ card, dir: dirPref === 'mixed' ? (Math.random() < 0.5 ? 'term' : 'def') : dirPref }));
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
    const answer = (knew) => { if (!knew) missed.push(it.card); pos++; persist(); showCard(); };
    const card = flipCard(frontLabel, front, backLabel, backSide, imgs, (flipped) => {
      if (flipped && !actions.querySelector('.knew')) actions.replaceChildren(knewButtons(answer));
    });

    actions.append(h('button', { class: 'btn primary', onclick: card.flip }, 'Flip'));
    keyHandler = flipKeys(card.flip, actions, answer);
    show(topbar(),
      h('main', { class: 'page stack flash-page' }, card.el, h('p', { class: 'muted small-text center' }, 'Tap the card to flip it')),
      actions);
  }

  function summary() {
    const knew = deck.length - missed.length;
    const again = missed;
    // All known: nothing left to continue. Otherwise keep the summary until Done.
    if (!again.length) store.del(key);
    const done = () => { store.del(key); exit(); };
    const primary = again.length
      ? h('button', { class: 'btn primary', onclick: () => start(again) }, `Review ${again.length} missed card${again.length === 1 ? '' : 's'}`)
      : h('button', { class: 'btn primary', onclick: done }, 'Done');
    keyHandler = (e) => e.key === 'Enter' && primary.click();
    show(topbar(),
      h('main', { class: 'page stack center' },
        h('div', { class: 'big-num' }, `${knew}/${deck.length}`),
        h('h2', {}, again.length ? 'Round complete' : 'You knew them all'),
        h('p', { class: 'muted' }, `Knew ${knew} of ${deck.length}${again.length ? ` · ${again.length} still learning` : ''}`)),
      h('div', { class: 'actions' }, primary,
        h('button', { class: 'btn', onclick: () => start(cards) }, `Restart all ${cards.length}`),
        again.length ? h('button', { class: 'btn ghost', onclick: done }, 'Done') : null));
  }

  if (restore()) {
    if (pos < deck.length) toast(`Continuing at ${pos + 1}/${deck.length}`);
    showCard();
  } else start(cards);
}

// ------------------------------------------------------------------ study
async function study(set, mode, resume = false, back = libraryView) {
  const cards = await db.getCards(set.id);
  const onCard = (c) => db.putMany('cards', [c]);
  let session = null;
  if (resume) {
    const saved = await db.getSession(set.id);
    session = saved && Session.restore(saved, cards, { onCard });
    if (!session) { await db.deleteSession(set.id); toast('Saved session is no longer available'); return back(); }
  }
  const imgs = await imageMap(set.id);
  if (!session) {
    const pool = buildPool(cards, mode, dayNum());
    if (!pool.length) { revoke(imgs); toast('Nothing to study'); return back(); }
    session = new Session(pool, cards, { mode, dir: store.get('dir', 'def'), modes: modesFor(set), onCard });
  }
  // Save after every step; a finished session has nothing to resume.
  const persist = () => (session.finished
    ? db.deleteSession(set.id)
    : db.saveSession({ setId: set.id, ...session.toJSON() })).catch(() => {});
  let closed = false;
  const exit = () => { closed = true; keyHandler = null; revoke(imgs); back(); };

  const { header, update } = progressHeader(exit);
  const topbar = () => {
    update(Math.round(session.progress * 100), `${session.mastered}/${session.total}`);
    return header;
  };

  // Fix a typo in the current card without leaving the session.
  function editCurrent(it) {
    keyHandler = null;
    const names = new Set(imgs.keys());
    const mk = (label, val) => {
      const ta = h('textarea', { rows: 3, spellcheck: 'false', 'aria-label': label });
      ta.value = val;
      return [h('label', { class: 'field' }, label, ta), ta];
    };
    const [termEl, termTa] = mk('Term', it.card.term);
    const [defEl, defTa] = mk('Definition', it.card.def);
    const close = () => { box.remove(); question(); };
    const save = async () => {
      const term = normalizeSide(termTa.value, names), def = normalizeSide(defTa.value, names);
      if (!term || !def) return toast('Term and definition cannot be empty');
      const card = { ...it.card, term, def };
      it.card = card;
      const i = cards.findIndex((c) => c.id === card.id);
      if (i >= 0) cards[i] = card;
      await db.putMany('cards', [card]);
      persist();
      toast('Card saved');
      close();
    };
    const box = h('div', { class: 'modal' },
      h('div', { class: 'card stack modal-body' }, h('div', { class: 'handle' }), h('h2', {}, 'Edit card'), termEl, defEl,
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: close }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: save }, 'Save'))));
    document.body.append(box);
    termTa.focus();
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
        h('div', { class: 'big-num' }, `${session.perfect}/${session.total}`), h('h2', {}, 'Session complete'),
        h('p', {}, `${session.total} cards studied · ${session.perfect} correct first time`),
        mode === 'learn' ? h('p', { class: 'muted' }, 'Your next reviews have been scheduled.') : null),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: exit }, 'Done')));
  }

  function question() {
    if (session.roundDone) return roundSummary();
    const it = session.current;
    const kind = session.kind(it);
    const label = it.dir === 'def' ? 'Term' : 'Definition';
    const answerLabel = it.dir === 'def' ? 'Definition' : 'Term';
    const answer = session.answer(it);
    const starBtn = h('button', { class: 'icon star-card', 'aria-label': 'Star card' }, icon(it.card.starred ? 'starFill' : 'star'));
    starBtn.onclick = async () => {
      const card = { ...it.card, starred: !it.card.starred };
      it.card = card;
      const i = cards.findIndex((c) => c.id === card.id);
      if (i >= 0) cards[i] = card;
      starBtn.replaceChildren(icon(card.starred ? 'starFill' : 'star'));
      starBtn.classList.toggle('on', !!card.starred);
      await db.putMany('cards', [card]);
      persist();
    };
    starBtn.classList.toggle('on', !!it.card.starred);
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
        // Wrong answers must be retyped correctly before moving on.
        const retype = h('input', { type: 'text', class: 'answer', placeholder: 'Type the correct answer',
          autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' });
        const cont = h('button', { class: 'btn primary', disabled: true, onclick: () => tryContinue() }, 'Continue');
        const tryContinue = () => {
          if (session.check(it, retype.value)) return proceed(false);
          retype.classList.add('bad');
          navigator.vibrate && navigator.vibrate(60);
        };
        retype.addEventListener('input', () => {
          const ok = session.check(it, retype.value);
          cont.disabled = !ok;
          retype.classList.toggle('ok', ok);
          retype.classList.remove('bad');
        });
        retype.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); tryContinue(); } });
        stage.append(h('div', { class: 'label' }, 'Retype the correct answer'), retype);
        actions.replaceChildren(...[cont, rightBtn].filter(Boolean));
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
