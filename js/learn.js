// Learn session (multiple choice -> written) + simplified SM-2 scheduling.
import { sideText, hasText } from './content.js';

export const NEW_PER_SESSION = 15;

export const dayNum = (d = new Date()) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 864e5);

export function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// set.learnMode -> list of question stages. Default: multiple choice, then written.
export const LEARN_MODES = { both: ['mc', 'write'], mc: ['mc'], write: ['write'] };
export const modesFor = (learnMode) => LEARN_MODES[learnMode] || LEARN_MODES.both;

export const isDue = (c, today) => c.state === 'review' && c.due <= today;

// Update a card's schedule after a session. misses = wrong answers this session.
export function schedule(card, misses, today) {
  const c = { ...card };
  if (misses === 0) {
    c.reps += 1;
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(Math.max(c.interval, 1) * c.ease);
    c.ease = Math.min(3, c.ease + 0.05);
  } else if (misses === 1) {
    c.reps += 1;
    c.interval = Math.max(1, Math.round(c.interval * 1.2));
    c.ease = Math.max(1.3, c.ease - 0.05);
  } else {
    c.reps = 0;
    c.lapses += 1;
    c.interval = 1;
    c.ease = Math.max(1.3, c.ease - 0.2);
  }
  c.state = 'review';
  c.due = today + c.interval;
  return c;
}

// mode 'learn': due cards first, then a few new ones. mode 'practice': everything.
export function buildPool(cards, mode, today) {
  if (mode === 'practice') return shuffle(cards);
  if (mode === 'starred') return shuffle(cards.filter((c) => c.starred));
  const due = cards.filter((c) => isDue(c, today)).sort((a, b) => a.due - b.due);
  const fresh = shuffle(cards.filter((c) => c.state === 'new')).slice(0, NEW_PER_SESSION);
  return [...shuffle(due), ...fresh];
}

export class Session {
  // allCards: whole set (used for distractors). pool: cards to study.
  constructor(pool, allCards, { mode = 'learn', dir = 'def', size = 7, modes = LEARN_MODES.both, onCard = () => {} } = {}) {
    this.pending = [...pool];
    this.allCards = allCards;
    this.mode = mode; this.dir = dir; this.size = size; this.onCard = onCard;
    this.modes = modes;
    this.total = pool.length; this.mastered = 0; this.perfect = 0;
    this.steps = 0;
    this.stepsTotal = pool.reduce((n, c) => n + (mode === 'learn' && c.state === 'review' ? 1 : modes.length), 0);
    this.items = []; this.queue = [];
    this.today = dayNum();
    this.round = 0;
  }

  startRound() {
    if (!this.pending.length) return false;
    this.round++;
    this.items = this.pending.splice(0, this.size).map((card) => ({
      card, misses: 0, done: false,
      stage: this.mode === 'learn' && card.state === 'review' ? this.modes.length - 1 : 0,
      dir: this.dir === 'mixed' ? (Math.random() < 0.5 ? 'term' : 'def') : this.dir,
    }));
    this.queue = shuffle(this.items);
    return true;
  }

  get progress() { return this.stepsTotal ? Math.min(1, this.steps / this.stepsTotal) : 0; }
  get current() { return this.queue[0]; }
  get roundDone() { return this.queue.length === 0; }
  get finished() { return this.roundDone && this.pending.length === 0; }

  // 'def' direction: prompt = term, answer = definition.
  prompt(it) { return it.dir === 'def' ? it.card.term : it.card.def; }
  answer(it) { return it.dir === 'def' ? it.card.def : it.card.term; }

  distractors(it, n = 3) {
    const correct = this.answer(it).trim();
    const seen = new Set([correct]);
    const out = [];
    for (const c of shuffle(this.allCards)) {
      if (c.id === it.card.id) continue;
      const a = (it.dir === 'def' ? c.def : c.term).trim();
      if (seen.has(a)) continue;
      seen.add(a); out.push(a);
      if (out.length >= n) break;
    }
    return out;
  }

  // 'mc' | 'write' | 'reveal'
  kind(it) {
    const textual = hasText(this.answer(it));
    if (this.modes[it.stage] === 'write' && textual) return 'write';
    if (this.distractors(it, 1).length) return 'mc';
    return textual ? 'write' : 'reveal';
  }

  options(it) {
    return shuffle([this.answer(it).trim(), ...this.distractors(it)]);
  }

  check(it, typed) {
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    return norm(typed) === norm(sideText(this.answer(it))) && norm(typed) !== '';
  }

  // Record a result for the current item.
  submit(ok) {
    const it = this.queue.shift();
    if (ok) {
      this.steps++;
      it.stage++;
      if (it.stage >= this.modes.length) {
        it.done = true;
        this.mastered++;
        if (it.misses === 0) this.perfect++;
        if (this.mode === 'learn') {
          it.card = schedule(it.card, it.misses, this.today);
          this.onCard(it.card);
        }
      } else {
        this.queue.splice(Math.min(this.queue.length, 3), 0, it);
      }
    } else {
      it.misses++;
      this.queue.splice(Math.min(this.queue.length, 2), 0, it);
    }
    return it;
  }

  // Plain-data snapshot so a session can be saved and continued later.
  toJSON() {
    const slim = (it) => ({ id: it.card.id, misses: it.misses, done: it.done, stage: it.stage, dir: it.dir });
    return {
      mode: this.mode, dir: this.dir, size: this.size, modes: this.modes,
      round: this.round, total: this.total, mastered: this.mastered, perfect: this.perfect,
      steps: this.steps, stepsTotal: this.stepsTotal,
      pending: this.pending.map((c) => c.id),
      items: this.items.map(slim),
      queue: this.queue.map((it) => it.card.id),
    };
  }

  // Rebuild a saved session. Cards that no longer exist are dropped. Returns null if nothing is left.
  static restore(data, allCards, { onCard } = {}) {
    const byId = new Map(allCards.map((c) => [c.id, c]));
    const s = new Session([], allCards, { mode: data.mode, dir: data.dir, size: data.size, modes: data.modes, onCard });
    s.pending = data.pending.map((id) => byId.get(id)).filter(Boolean);
    s.items = data.items.filter((i) => byId.has(i.id)).map((i) => ({ ...i, card: byId.get(i.id) }));
    const live = new Map(s.items.map((it) => [it.card.id, it]));
    s.queue = data.queue.map((id) => live.get(id)).filter(Boolean);
    Object.assign(s, { round: data.round, total: data.total, mastered: data.mastered,
      perfect: data.perfect, steps: data.steps, stepsTotal: data.stepsTotal });
    return s.finished ? null : s;
  }
}
