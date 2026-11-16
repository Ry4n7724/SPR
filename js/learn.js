// Learn session (multiple choice -> written) + simplified SM-2 scheduling.
import { sideText, hasText, norm } from './content.js';

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

// Question stages, always asked in this order. set.stages picks which ones a set uses.
export const STAGES = ['flash', 'mc', 'write'];
export const STAGE_NAMES = { flash: 'Flashcards', mc: 'Multiple choice', write: 'Written' };
// Older sets store a combination name in set.learnMode instead. Default: multiple choice, then written.
export const LEARN_MODES = { both: ['mc', 'write'], mc: ['mc'], write: ['write'], all: ['flash', 'mc', 'write'] };
export function modesFor(set) {
  const picked = Array.isArray(set.stages) ? STAGES.filter((s) => set.stages.includes(s)) : [];
  return picked.length ? picked : LEARN_MODES[set.learnMode] || LEARN_MODES.both;
}

// 'def' direction: prompt = term, answer = definition.
export const promptOf = (card, dir) => (dir === 'def' ? card.term : card.def);
export const answerOf = (card, dir) => (dir === 'def' ? card.def : card.term);
export const pickDir = (dir) => (dir === 'mixed' ? (Math.random() < 0.5 ? 'term' : 'def') : dir);

// Up to n distinct wrong answers taken from other cards of the set.
export function pickDistractors(card, dir, allCards, n = 3) {
  const seen = new Set([answerOf(card, dir).trim()]);
  const out = [];
  for (const c of shuffle(allCards)) {
    if (c.id === card.id) continue;
    const a = answerOf(c, dir).trim();
    if (seen.has(a)) continue;
    seen.add(a); out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

// Typed answer matches, ignoring case, accents, punctuation and extra spaces.
export const matches = (typed, answer) => norm(typed) !== '' && norm(typed) === norm(sideText(answer));

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
      dir: pickDir(this.dir),
    }));
    this.queue = shuffle(this.items);
    return true;
  }

  get progress() { return this.stepsTotal ? Math.min(1, this.steps / this.stepsTotal) : 0; }
  get current() { return this.queue[0]; }
  get roundDone() { return this.queue.length === 0; }
  get finished() { return this.roundDone && this.pending.length === 0; }

  prompt(it) { return promptOf(it.card, it.dir); }
  answer(it) { return answerOf(it.card, it.dir); }
  distractors(it, n = 3) { return pickDistractors(it.card, it.dir, this.allCards, n); }

  // 'flash' | 'mc' | 'write' | 'reveal'
  kind(it) {
    if (this.modes[it.stage] === 'flash') return 'flash';
    const textual = hasText(this.answer(it));
    if (this.modes[it.stage] === 'write' && textual) return 'write';
    if (this.distractors(it, 1).length) return 'mc';
    return textual ? 'write' : 'reveal';
  }

  options(it) {
    return shuffle([this.answer(it).trim(), ...this.distractors(it)]);
  }

  check(it, typed) { return matches(typed, this.answer(it)); }

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

// ------------------------------------------------------------------ test
// One-shot test: each card is asked once, graded at the end, schedule untouched.
export const TEST_TYPES = ['tf', 'mc', 'write'];
export const TEST_TYPE_NAMES = { tf: 'True / False', mc: 'Multiple choice', write: 'Written' };

// cards: cards to ask about. allCards: whole set (for distractors).
// Types are spread evenly; a type a card can't support falls back to another one.
export function buildTest(cards, allCards, { count = cards.length, types = TEST_TYPES, dir = 'def' } = {}) {
  const picked = TEST_TYPES.filter((t) => types.includes(t));
  const order = shuffle(picked.length ? picked : TEST_TYPES);
  const out = [];
  for (const card of shuffle(cards)) {
    if (out.length >= count) break;
    const d = pickDir(dir);
    const answer = answerOf(card, d);
    const textual = hasText(answer);
    const wrong = pickDistractors(card, d, allCards, 3);
    const can = (t) => (t === 'write' ? textual : wrong.length > 0);
    const want = order[out.length % order.length];
    const type = [want, ...order, ...TEST_TYPES].find(can);
    if (!type) continue;
    const q = { card, dir: d, type, prompt: promptOf(card, d), answer };
    if (type === 'mc') q.options = shuffle([answer.trim(), ...wrong]);
    if (type === 'tf') { q.truth = Math.random() < 0.5; q.shown = q.truth ? answer.trim() : wrong[0]; }
    out.push(q);
  }
  return out;
}

// response: tf -> boolean, mc -> option string, write -> typed text. null/undefined = unanswered.
export function gradeTest(q, response) {
  if (response == null) return false;
  if (q.type === 'tf') return response === q.truth;
  if (q.type === 'mc') return response === q.answer.trim();
  return matches(response, q.answer);
}
