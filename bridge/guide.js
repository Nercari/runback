'use strict';
// Leveling-guide files: validation and sanitising, the way protocol.js does for
// map layers. Pure code: no I/O, no game, no config. A guide is a read-only step
// list the player follows by hand; nothing here describes a game action.
// Format: docs/GUIDE.md.

const { cleanText } = require('./protocol');

const GUIDE_LIMITS = {
  guides: 12, steps: 600, pointsPerStep: 8, title: 80, source: 120, text: 200, quest: 80,
  label: 60, listItems: 12, listItem: 24, level: { min: 1, max: 70 }, radius: { min: 0.5, max: 25 },
  questIds: 12, factionId: 99999, skill: { min: 1, max: 450 },
};
const GUIDE_ID = /^[A-Za-z0-9_.-]{1,32}$/;
const GUIDE_KINDS = new Set(['accept', 'do', 'turnin', 'travel', 'train', 'buy', 'note']);
const FACTIONS = { alliance: 'Alliance', horde: 'Horde' };
const NAME_TOKEN = /^[A-Za-z][A-Za-z '-]*$/;
// Reputation standings as the game numbers them (1 Hated to 8 Exalted).
const STANDINGS = ['hated', 'hostile', 'unfriendly', 'neutral', 'friendly', 'honored', 'revered', 'exalted'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Strings only: a number or object is never turned into text.
const clean = (v, max) => (typeof v === 'string' ? cleanText(v, max) : '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;
const posInt = v => (Number.isInteger(v) && v > 0 && v <= 0x7fffffff ? v : null);

function faction(v) {
  return typeof v === 'string' ? FACTIONS[v.trim().toLowerCase()] || null : null;
}

function level(v) {
  const n = num(v);
  return n === null ? null : clamp(Math.round(n), GUIDE_LIMITS.level.min, GUIDE_LIMITS.level.max);
}

// {min,max} or null. One bound alone is fine; min is never above max.
function levelRange(v) {
  if (!isObj(v)) return null;
  let min = level(own(v, 'min')), max = level(own(v, 'max'));
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  const out = {};
  if (min !== null) out.min = min;
  if (max !== null) out.max = max;
  return out;
}

// Short list of class or race names, or null.
function nameList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v.slice(0, GUIDE_LIMITS.listItems * 2)) {
    if (typeof item !== 'string') continue;
    const t = clean(item, GUIDE_LIMITS.listItem);
    if (NAME_TOKEN.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= GUIDE_LIMITS.listItems) break;
  }
  return out.length ? out : null;
}

// Short list of quest ids, or null: positive integers, no repeats.
function questIdList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v.slice(0, GUIDE_LIMITS.questIds * 2)) {
    const id = posInt(item);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= GUIDE_LIMITS.questIds) break;
  }
  return out.length ? out : null;
}

// { faction: id, standing: 1..8 } or null. standing may be written as a number or a name.
function rep(v) {
  if (!isObj(v)) return null;
  const id = posInt(own(v, 'faction'));
  if (!id || id > GUIDE_LIMITS.factionId) return null;
  const raw = own(v, 'standing');
  const n = typeof raw === 'string' ? STANDINGS.indexOf(raw.trim().toLowerCase()) + 1 : num(raw);
  if (!n) return null;
  return { faction: id, standing: clamp(Math.round(n), 1, STANDINGS.length) };
}

// { name, skill } or null: a profession name and the rank needed (1 when not given).
function profession(v) {
  if (!isObj(v)) return null;
  const name = clean(own(v, 'name'), GUIDE_LIMITS.listItem);
  if (!NAME_TOKEN.test(name)) return null;
  const n = num(own(v, 'skill'));
  return { name, skill: n === null ? 1 : clamp(Math.round(n), GUIDE_LIMITS.skill.min, GUIDE_LIMITS.skill.max) };
}

function point(p) {
  if (!isObj(p)) return null;
  const m = own(p, 'm'), x = num(own(p, 'x')), y = num(own(p, 'y'));
  if (!Number.isInteger(m) || m < 1 || m > 99999 || x === null || y === null) return null;
  const out = { m, x: round2(clamp(x, 0, 100)), y: round2(clamp(y, 0, 100)) };
  const r = num(own(p, 'radius'));
  if (r !== null) out.radius = round2(clamp(r, GUIDE_LIMITS.radius.min, GUIDE_LIMITS.radius.max));
  const label = clean(own(p, 'label'), GUIDE_LIMITS.label);
  if (label) out.label = label;
  return out;
}

// One step without its completewith (that needs the whole list), or null.
function step(s, n, why) {
  if (!isObj(s)) { why.push(`step ${n}: not an object`); return null; }
  const kind = own(s, 'kind');
  if (typeof kind !== 'string' || !GUIDE_KINDS.has(kind)) { why.push(`step ${n}: unknown kind`); return null; }
  const text = clean(own(s, 'text'), GUIDE_LIMITS.text);
  if (!text) { why.push(`step ${n}: no text`); return null; }
  const out = { kind, text };
  const quest = clean(own(s, 'quest'), GUIDE_LIMITS.quest);
  if (quest) out.quest = quest;
  const questId = posInt(own(s, 'questId'));
  if (questId) out.questId = questId;
  const rawPoints = own(s, 'points');
  if (Array.isArray(rawPoints)) {
    const points = [];
    for (const p of rawPoints.slice(0, GUIDE_LIMITS.pointsPerStep)) {
      const c = point(p);
      if (c) points.push(c); else why.push(`step ${n}: dropped invalid point`);
    }
    if (rawPoints.length > GUIDE_LIMITS.pointsPerStep) why.push(`step ${n}: kept first ${GUIDE_LIMITS.pointsPerStep} points`);
    if (points.length) out.points = points;
  }
  const lv = levelRange(own(s, 'level'));
  if (lv) out.level = lv;
  const classes = nameList(own(s, 'class'));
  if (classes) out.class = classes;
  const races = nameList(own(s, 'race'));
  if (races) out.race = races;
  const f = faction(own(s, 'faction'));
  if (f) out.faction = f;
  for (const key of ['requires', 'exclusive']) {
    const ids = questIdList(own(s, key));
    if (ids) out[key] = ids;
  }
  const r = rep(own(s, 'rep'));
  if (r) out.rep = r; else if (own(s, 'rep') !== undefined) why.push(`step ${n}: dropped invalid rep`);
  const prof = profession(own(s, 'profession'));
  if (prof) out.profession = prof; else if (own(s, 'profession') !== undefined) why.push(`step ${n}: dropped invalid profession`);
  for (const flag of ['optional', 'sticky']) if (own(s, flag) === true) out[flag] = true;
  return out;
}

// One guide, sanitised, or null (with the reasons in `why`). Never throws.
function validateGuide(g, why = []) {
  try {
    if (!isObj(g)) { why.push('guide: not an object'); return null; }
    const id = own(g, 'id');
    if (typeof id !== 'string' || !GUIDE_ID.test(id)) { why.push('guide: bad id'); return null; }
    const rawSteps = own(g, 'steps');
    if (!Array.isArray(rawSteps) || !rawSteps.length) { why.push(`guide ${id}: no steps`); return null; }
    if (rawSteps.length > GUIDE_LIMITS.steps) why.push(`guide ${id}: kept first ${GUIDE_LIMITS.steps} of ${rawSteps.length} steps`);
    const steps = [], newIndex = new Map(); // original 1-based position -> position after dropping
    const wanted = [];                      // completewith as written, per kept step
    rawSteps.slice(0, GUIDE_LIMITS.steps).forEach((raw, i) => {
      const s = step(raw, i + 1, why);
      if (!s) return;
      newIndex.set(i + 1, steps.length + 1);
      wanted.push(isObj(raw) ? own(raw, 'completewith') : undefined);
      steps.push(s);
    });
    if (!steps.length) { why.push(`guide ${id}: no valid steps`); return null; }
    // completewith: the 1-based position of a LATER step in the list as written.
    // It follows that step if it survived, and is dropped otherwise.
    const orig = [...newIndex.keys()];
    steps.forEach((s, i) => {
      const target = posInt(wanted[i]);
      if (target === null) return;
      if (target <= orig[i] || !newIndex.has(target)) { why.push(`step ${orig[i]}: dropped completewith`); return; }
      s.completewith = newIndex.get(target);
    });
    const out = { id, title: clean(own(g, 'title'), GUIDE_LIMITS.title) || id };
    const minLevel = level(own(g, 'minLevel')), maxLevel = level(own(g, 'maxLevel'));
    if (minLevel !== null) out.minLevel = minLevel;
    if (maxLevel !== null) out.maxLevel = maxLevel;
    if (minLevel !== null && maxLevel !== null && minLevel > maxLevel) { out.minLevel = maxLevel; out.maxLevel = minLevel; }
    const f = faction(own(g, 'faction'));
    if (f) out.faction = f;
    const source = clean(own(g, 'source'), GUIDE_LIMITS.source);
    if (source) out.source = source;
    out.steps = steps;
    return out;
  } catch (e) {
    why.push('guide: unreadable');
    return null;
  }
}

// A list of guides, sanitised: invalid ones dropped, a repeated id replaced by
// its later copy, and only the newest (last) 12 kept. Returns { guides, why }.
function validateGuideSet(list, why = []) {
  const byId = new Map();
  try {
    if (!Array.isArray(list)) { why.push('guides: not a list'); return { guides: [], why }; }
    for (const raw of list.slice(0, GUIDE_LIMITS.guides * 4)) {
      const g = validateGuide(raw, why);
      if (!g) continue;
      byId.delete(g.id); // re-insert so the newest copy counts as newest
      byId.set(g.id, g);
    }
  } catch (e) {
    why.push('guides: unreadable');
  }
  let guides = [...byId.values()];
  if (guides.length > GUIDE_LIMITS.guides) {
    why.push(`kept the newest ${GUIDE_LIMITS.guides} of ${guides.length} guides`);
    guides = guides.slice(-GUIDE_LIMITS.guides);
  }
  return { guides, why };
}

// Text of a guide file (one guide, or a JSON list of guides) -> { guides, why }.
function parseGuideText(text) {
  const why = [];
  let data;
  try { data = JSON.parse(String(text ?? '')); } catch (e) { return { guides: [], why: ['guide file is not valid JSON'] }; }
  return validateGuideSet(Array.isArray(data) ? data : [data], why);
}

// ---------------------------------------------------------------------------
// Guide channel (docs/GUIDE.md, "Channel to the addon")
// ---------------------------------------------------------------------------
//
// Same route as map layers: the agent writes guides to the file named by
// WOW_AI_GUIDE_FILE, or in a ```wowguide block in its reply. The bridge validates
// them above, keeps them in state.json (state.guides) and ships the whole set,
// versioned, in the slot files. The addon only stores what arrives.

// Guides kept in the bridge's state: at most GUIDE_LIMITS.guides, and at most this
// many steps in all (the oldest guides go first), so a slot file stays small.
const GUIDE_STATE_STEPS = 1500;

function newGuides(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, guides: [] };
}

const sameGuide = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Merge raw guides (as the agent wrote them) into `store`. A guide with an id
// already held replaces it and counts as newest. Mutates `store`; bumps its
// version only when something changed. Returns { changed, stored, titles, notes }.
function applyGuides(store, rawList) {
  const why = [];
  const { guides } = validateGuideSet(rawList, why);
  const notes = [...why];
  let changed = false;
  const titles = [];
  for (const g of guides) {
    const i = store.guides.findIndex(x => x.id === g.id);
    if (i >= 0 && sameGuide(store.guides[i], g)) continue;
    if (i >= 0) store.guides.splice(i, 1);
    store.guides.push(g);
    changed = true;
    titles.push(g.title);
    notes.push(`guide ${g.id}: ${g.steps.length} step(s)`);
  }
  const steps = () => store.guides.reduce((n, g) => n + g.steps.length, 0);
  while (store.guides.length > GUIDE_LIMITS.guides || (store.guides.length > 1 && steps() > GUIDE_STATE_STEPS)) {
    notes.push(`dropped old guide ${store.guides.shift().id} (guides full)`);
    changed = true;
  }
  if (changed) store.version = (store.version || 0) + 1;
  return { changed, stored: guides.length, titles, notes };
}

// Pull ```wowguide blocks out of a reply: a JSON guide or a JSON list of guides.
function extractGuideBlocks(text) {
  const raw = [], errors = [];
  const stripped = String(text ?? '').replace(/```wowguide[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    try {
      const v = JSON.parse(body.trim());
      raw.push(...(Array.isArray(v) ? v : [v]));
    } catch {
      errors.push('unreadable wowguide block');
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, raw, errors };
}

// Text of the run's guide file -> { raw, errors } (one guide, or a JSON list).
function readGuideFile(src) {
  const text = String(src ?? '').trim();
  if (!text) return { raw: [], errors: [] };
  try {
    const v = JSON.parse(text);
    return { raw: Array.isArray(v) ? v : [v], errors: [] };
  } catch {
    return { raw: [], errors: ['guide file is not valid JSON'] };
  }
}

// The one line the player reads after the agent wrote a guide.
function guideNote({ titles = [], failed = false } = {}) {
  if (titles.length === 1) return `I saved the guide "${titles[0]}".`;
  if (titles.length > 1) return `I saved ${titles.length} guides.`;
  return failed ? 'I could not save that guide.' : '';
}

module.exports = {
  GUIDE_LIMITS,
  GUIDE_KINDS,
  GUIDE_STATE_STEPS,
  validateGuide,
  validateGuideSet,
  parseGuideText,
  newGuides,
  applyGuides,
  extractGuideBlocks,
  readGuideFile,
  guideNote,
};
