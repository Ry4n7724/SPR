// Parsing of Quizlet exports / CSV / zip files, and backup export/restore.
import * as db from './db.js';

const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);
const TXT = new Set(['txt', 'csv', 'tsv']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };
const ext = (n) => n.split('.').pop().toLowerCase();

// ---- text parsing ----------------------------------------------------------
export function parseRows(text, fs, rs) {
  text = text.replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], f = '', i = 0, q = false;
  while (i < text.length) {
    if (q) {
      if (text[i] === '"') {
        if (text[i + 1] === '"') { f += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      f += text[i++]; continue;
    }
    if (text[i] === '"' && f === '') { q = true; i++; continue; }
    if (text.startsWith(rs, i)) { row.push(f); f = ''; rows.push(row); row = []; i += rs.length; continue; }
    if (text.startsWith(fs, i)) { row.push(f); f = ''; i += fs.length; continue; }
    f += text[i++];
  }
  row.push(f); rows.push(row);
  return rows;
}

export function detectTermSep(text) {
  if (text.includes('\t')) return '\t';
  const lines = text.split('\n').filter((l) => l.trim());
  const count = (c) => lines.filter((l) => l.includes(c)).length;
  const c = count(','), s = count(';');
  return s > c ? ';' : ',';
}

const unescapeSep = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

// termSep / cardSep: 'auto' | literal separator (may contain \n, \t escapes)
export function parseCards(text, termSep = 'auto', cardSep = 'auto') {
  const fs = termSep === 'auto' ? detectTermSep(text) : unescapeSep(termSep);
  const rs = cardSep === 'auto' ? '\n' : unescapeSep(cardSep);
  if (!fs || !rs) return [];
  const out = [];
  for (const r of parseRows(text, fs, rs)) {
    if (r.length < 2) continue;
    const term = r[0].trim(), def = r.slice(1).join(fs).trim();
    if (term && def) out.push([term, def]);
  }
  return out;
}

// Turn bare image file names / image URLs into [img:...] tokens.
export function normalizeSide(s, imageNames) {
  s = s.trim();
  if (/^\[img:[^\]]+\]/i.test(s) || /\[img:[^\]]+\]/i.test(s)) return s;
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(s)) return `[img:${s}]`;
  if (imageNames.has(s.toLowerCase())) return `[img:${s}]`;
  return s;
}

export function imagesUsed(pairs) {
  const used = new Set();
  for (const [a, b] of pairs) for (const s of [a, b]) {
    for (const m of s.matchAll(/\[img:([^\]]+)\]/gi)) if (!/^https?:\/\//i.test(m[1])) used.add(m[1].trim().toLowerCase());
  }
  return used;
}

// ---- files -----------------------------------------------------------------
// Returns { text, textName, images: Map(lowercase name -> {name, blob}), backup: JSZip|null }
export async function readFiles(files) {
  const out = { text: null, textName: null, images: new Map(), backup: null };
  for (const f of files) {
    const e = ext(f.name);
    if (e === 'zip') {
      const z = await window.JSZip.loadAsync(f);
      if (z.file('backup.json')) { out.backup = z; continue; }
      for (const [path, entry] of Object.entries(z.files)) {
        if (entry.dir || path.includes('__MACOSX')) continue;
        const base = path.split('/').pop();
        if (base.startsWith('.')) continue;
        const be = ext(base);
        if (IMG.has(be)) {
          const buf = await entry.async('arraybuffer');
          out.images.set(base.toLowerCase(), { name: base, blob: new Blob([buf], { type: MIME[be] }) });
        } else if (TXT.has(be) && out.text == null) {
          out.text = await entry.async('string');
          out.textName = base;
        }
      }
    } else if (IMG.has(e)) {
      out.images.set(f.name.toLowerCase(), { name: f.name, blob: f.type ? f : new Blob([f], { type: MIME[e] }) });
    } else {
      out.text = await f.text();
      out.textName = f.name;
    }
  }
  return out;
}

export function newCard(setId, term, def) {
  return { id: db.uid(), setId, term, def, state: 'new', reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0 };
}

export async function saveSet(name, pairs, images) {
  const names = new Set(images.keys());
  const norm = pairs.map(([a, b]) => [normalizeSide(a, names), normalizeSide(b, names)]);
  const used = imagesUsed(norm);
  const set = { id: db.uid(), name, created: Date.now(), count: norm.length };
  await db.putMany('sets', [set]);
  await db.putMany('cards', norm.map(([a, b]) => newCard(set.id, a, b)));
  const imgs = [...images.entries()].filter(([k]) => used.has(k))
    .map(([k, v]) => ({ key: `${set.id}/${k}`, setId: set.id, name: v.name, blob: v.blob }));
  if (imgs.length) await db.putMany('images', imgs);
  return set;
}

// ---- backup ----------------------------------------------------------------
export async function exportBackup() {
  const zip = new window.JSZip();
  const sets = await db.getSets();
  const data = { version: 1, sets: [] };
  for (const set of sets) {
    data.sets.push({ set, cards: await db.getCards(set.id) });
    for (const im of await db.getImages(set.id)) zip.file(`images/${set.id}/${im.name}`, im.blob);
  }
  zip.file('backup.json', JSON.stringify(data));
  return zip.generateAsync({ type: 'blob' });
}

export async function restoreBackup(zip) {
  const data = JSON.parse(await zip.file('backup.json').async('string'));
  let n = 0;
  for (const { set, cards } of data.sets) {
    await db.putMany('sets', [set]);
    await db.putMany('cards', cards);
    const imgs = [];
    for (const [path, entry] of Object.entries(zip.files)) {
      const pre = `images/${set.id}/`;
      if (entry.dir || !path.startsWith(pre)) continue;
      const name = path.slice(pre.length);
      const buf = await entry.async('arraybuffer');
      imgs.push({ key: `${set.id}/${name.toLowerCase()}`, setId: set.id, name, blob: new Blob([buf], { type: MIME[ext(name)] || '' }) });
    }
    if (imgs.length) await db.putMany('images', imgs);
    n++;
  }
  return n;
}
