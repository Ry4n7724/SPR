// Helpers for card content: tiny DOM builder, image tokens, text normalising.
// Card sides are plain strings. Images are embedded as [img:name] tokens,
// where name is a file from the imported zip or a full http(s) URL.

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(k));
  }
  return e;
}

export function parseSide(s) {
  const parts = [];
  const re = /\[img:([^\]]+)\]/gi;
  let last = 0, m;
  const text = (v) => { v = v.trim(); if (v) parts.push({ t: 'text', v }); };
  while ((m = re.exec(s))) {
    text(s.slice(last, m.index));
    parts.push({ t: 'img', v: m[1].trim() });
    last = re.lastIndex;
  }
  text(s.slice(last));
  return parts;
}

export const sideText = (s) => parseSide(s).filter((p) => p.t === 'text').map((p) => p.v).join(' ').trim();
export const hasText = (s) => sideText(s).length > 0;

export function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

// imgMap: Map(lowercase file name -> object URL)
export function renderSide(s, imgMap) {
  const box = h('div', { class: 'side' });
  for (const p of parseSide(s)) {
    if (p.t === 'text') { box.append(h('div', { class: 'txt' }, p.v)); continue; }
    const src = /^https?:\/\//i.test(p.v) ? p.v : imgMap && imgMap.get(p.v.toLowerCase());
    if (src) box.append(h('img', { class: 'zoomable', src, alt: '', loading: 'lazy' }));
    else box.append(h('div', { class: 'txt' }, p.v));
  }
  return box;
}
