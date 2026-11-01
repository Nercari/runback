'use strict';
// J1: coach or stay quiet. Code decides the clear cases, Jev only the middle ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../bridge/forever/modules/04-coach-gate');

// Local-time strings, as the addon writes them (no zone), so offsets stay consistent.
const L = (s) => { const d = new Date(2026, 9, 11, 20, 0, s); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function ctxText({ dur = 100, ended = true, deaths = 0, enc, ok, hp, meter, logging = true, base = 0 }) {
  const lines = [];
  if (deaths) lines.push('deaths=' + Array.from({ length: deaths }, (_, i) => `${L(base + 10 + i)}@Elwynn Forest`).join(';'));
  let f = `lastFight=start=${L(base)}`;
  if (ended) f += `,end=${L(base + dur)}`;
  if (enc) f += `,enc=${enc}`;
  if (ok !== undefined) f += `,ok=${ok}`;
  if (hp !== undefined) f += `,hp=${hp}`;
  lines.push(f);
  if (meter) lines.push(`meter=${meter}`);
  lines.push(`logging=${logging}`);
  return lines.join('\n');
}

function setup(mode, { jev, jevThrows } = {}) {
  G._state.dps.length = 0; G._state.seen.clear(); G._state.quieted.clear();
  const calls = [], logs = [], finished = [];
  const ctx = {
    cfg: { forever: { coachGate: { mode } } }, state: {}, log: (...a) => logs.push(a.join(' ')),
    finish: (job, status, text) => { job.finished = true; finished.push(text); },
    coachGateSend: async (url, headers, body) => {
      calls.push({ url, headers, body });
      if (jevThrows) throw new Error('down');
      return jev || { status: 200, json: { answers: { coach: { noul: 0.2 } } } };
    },
  };
  const job = (text, id = 1) => ({ id, cmd: 'review', ctx: text, chat: 'c' });
  return { ctx, calls, logs, finished, job };
}

test('during combat (no end time) the gate never evaluates and the mentor runs', async () => {
  const s = setup('on');
  assert.equal(await G.intercept(s.job(ctxText({ ended: false })), s.ctx), false);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.logs, []);
  assert.deepEqual(s.finished, []);
  assert.equal(await G.intercept({ id: 2, cmd: 'review', ctx: '', chat: 'c' }, s.ctx), false); // no fight line at all
  assert.deepEqual(s.logs, []);
});

test('trivial fight is quiet with no Jev call', async () => {
  const s = setup('on');
  assert.equal(await G.intercept(s.job(ctxText({ dur: 20 })), s.ctx), true);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.finished, [G.QUIET_LINE]);
  assert.match(s.logs[0], /quiet by code \(trivial\)/);
});

test('a wipe, a death, a boss and a long fight coach with no Jev call', async () => {
  for (const t of [{ ok: 0, enc: 'Boss' }, { deaths: 1 }, { enc: 'Boss', dur: 90, ok: 1 }, { dur: 400 }, { dur: 100, hp: 20 }]) {
    const s = setup('on');
    assert.equal(await G.intercept(s.job(ctxText(t)), s.ctx), false, JSON.stringify(t));
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.finished, []);
    assert.match(s.logs[0], /coach by code/);
  }
});

test('a big drop against the recent dps average coaches by code', async () => {
  const s = setup('on');
  for (let i = 0; i < 3; i++) await G.intercept(s.job(ctxText({ dur: 100, base: i * 1000, meter: 'dps 1000, dmg 100000, 100s' }), i + 1), s.ctx);
  s.calls.length = 0;
  assert.equal(await G.intercept(s.job(ctxText({ dur: 100, base: 9000, meter: 'dps 400, dmg 40000, 100s' }), 9), s.ctx), false);
  assert.equal(s.calls.length, 0);
  assert.match(s.logs.at(-1), /coach by code \(dps drop\)/);
});

test('a middle case asks Jev once; low probability is quiet, high coaches', async () => {
  const lo = setup('on');
  assert.equal(await G.intercept(lo.job(ctxText({ dur: 100 })), lo.ctx), true);
  assert.equal(lo.calls.length, 1);
  assert.equal(lo.calls[0].url, G.URL_ZEN);
  assert.equal(lo.calls[0].body.model, G.MODELS[0]);
  assert.equal(lo.calls[0].body.questions.coach.type, 'noul');
  assert.match(lo.logs[0], /quiet by jev/);
  const hi = setup('on', { jev: { status: 200, json: { answers: { coach: { noul: 0.9 } } } } });
  assert.equal(await G.intercept(hi.job(ctxText({ dur: 100 })), hi.ctx), false);
  assert.match(hi.logs[0], /coach by jev/);
});

test('Jev down (throws, bad status, bad answer): the mentor runs', async () => {
  for (const o of [{ jevThrows: true }, { jev: { status: 500, json: {} } }, { jev: { status: 200, json: { answers: {} } } }, { jev: { status: 200, json: { answers: { coach: { noul: 7 } } } } }]) {
    const s = setup('on', o);
    assert.equal(await G.intercept(s.job(ctxText({ dur: 100 })), s.ctx), false);
    assert.deepEqual(s.finished, []);
    assert.match(s.logs[0], /coach by fallback \(jev unavailable\)/);
  }
});

test('shadow never changes behaviour; off does nothing; default mode is shadow', async () => {
  const s = setup('shadow');
  assert.equal(await G.intercept(s.job(ctxText({ dur: 20 })), s.ctx), false);
  assert.deepEqual(s.finished, []);
  assert.match(s.logs[0], /\(shadow\): quiet by code/);
  const off = setup('off');
  assert.equal(await G.intercept(off.job(ctxText({ dur: 20 })), off.ctx), false);
  assert.deepEqual(off.logs, []);
  const d = setup('x'); d.ctx.cfg.forever = {};
  assert.equal(await G.intercept(d.job(ctxText({ dur: 20 })), d.ctx), false);
  assert.match(d.logs[0], /\(shadow\)/);
});

test('asking again for the same quiet fight runs the mentor', async () => {
  const s = setup('on');
  assert.equal(await G.intercept(s.job(ctxText({ dur: 20 })), s.ctx), true);
  assert.equal(await G.intercept(s.job(ctxText({ dur: 20 }), 2), s.ctx), false);
});

test('other commands and unlogged fights are not gated', async () => {
  const s = setup('on');
  assert.equal(await G.intercept({ id: 1, cmd: 'death', ctx: ctxText({ dur: 20 }) }, s.ctx), false);
  assert.equal(await G.intercept(s.job(ctxText({ dur: 20, logging: false })), s.ctx), false);
  assert.deepEqual(s.logs, []);
});

test('the Jev request body holds numbers only: no names, chat or notebook text', async () => {
  const s = setup('on');
  const text = ctxText({ dur: 100, enc: 'Secret Boss Name', meter: 'dps 500, dmg 50000, 100s' }).replace('hp=', '') +
    '\nHeroName-Realm said hello\nnotebook: my private note';
  await G.intercept(s.job(text.replace(/,enc=[^\n]*/, '')), s.ctx);
  assert.equal(s.calls.length, 1);
  const body = s.calls[0].body;
  for (const v of Object.values(body.state)) assert.equal(typeof v, 'number');
  assert.deepEqual(Object.keys(body.state).sort(), ['avg_dps', 'boss', 'damage', 'deaths', 'dps', 'duration_s', 'start_hp_pct', 'success']);
  const wire = JSON.stringify(body);
  for (const bad of ['HeroName', 'Realm', 'private', 'Elwynn', 'Secret']) assert.ok(!wire.includes(bad), bad);
  const boss = G.jevState(G.parseFight(ctxText({ enc: 'Secret Boss Name', dur: 50 })), -1);
  assert.equal(boss.boss, 1);
  assert.ok(!JSON.stringify(boss).includes('Secret'));
});

test('the request uses the bearer key only when OPENCODE_API_KEY is set', async () => {
  const had = process.env.OPENCODE_API_KEY;
  try {
    delete process.env.OPENCODE_API_KEY;
    let s = setup('on'); await G.intercept(s.job(ctxText({ dur: 100 })), s.ctx);
    assert.deepEqual(s.calls[0].headers, {});
    process.env.OPENCODE_API_KEY = 'k';
    s = setup('on'); await G.intercept(s.job(ctxText({ dur: 100 })), s.ctx);
    assert.equal(s.calls[0].headers.authorization, 'Bearer k');
  } finally { if (had === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = had; }
});

// ---------------------------------------------------------------------------
// Between-pull coach card (#140): the checks are counted from the synthetic fixture
// tests/fixtures/dryrun, and the bridge answers one card per fight.
// ---------------------------------------------------------------------------
const path = require('node:path');
const C = require('../../tools/coach-card');
const cardMod = require('../../bridge/forever/modules/07-coach-card');
const cardP = require('../../bridge/protocol');

const LOGS = path.join(__dirname, '..', 'fixtures', 'dryrun', 'Logs');
const PLAYER = 'Brakka-Testrealm';
const START = Date.parse('2026-09-25T20:00:10');
const END = Date.parse('2026-09-25T20:00:43');
const CTX = [
  'Game: World of Warcraft: Forever (client 1.60.1, interface 16001)',
  'Character: Brakka on Testrealm, level 12 Warrior (Alliance)',
  'Location: Westfall',
  'lastFight=start=2026-09-25T20:00:10,end=2026-09-25T20:00:43,hp=88',
  'logging=true',
].join('\n');

test('the player and the fight window come from the addon context', () => {
  assert.equal(C.playerName(CTX), PLAYER);
  assert.equal(C.playerName('Character: Brakka, level 12'), 'Brakka', 'no realm, no dash');
  assert.equal(C.playerName('Game: World of Warcraft'), '');
  const w = C.fightWindow(CTX);
  assert.equal(w.start, START);
  assert.equal(w.end, END);
  assert.equal(C.fightWindow('lastFight=start=2026-09-25T20:00:10'), null, 'no end time');
  assert.equal(C.fightWindow('lastFight=start=2026-09-25T20:00:43,end=2026-09-25T20:00:10'), null, 'end before start');
});

test('every count matches the synthetic fixture', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  assert.ok(lines.length > 0);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  assert.deepEqual(c, {
    duration_s: 33,
    deaths: 1,
    enemyCasts: 6,
    interrupts: 1,
    hits: 7,
    idle_s: 6,
    burst_hits: 2,
    burst_s: 1,
  });
});

test('the fixture fight picks the idle check, and its lines carry only counted numbers', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  const check = C.pick(c);
  assert.deepEqual(check, { rule: 'idle', n: 6 });
  assert.equal(C.change(check), 'keep attacking; the gaps cost you damage.');
  assert.equal(C.reason(check, c), 'you did nothing for 6 s of the 33 s pull.');
  assert.equal(C.countsLine(c), '33 s pull, 7 hits taken, 6 enemy casts, 1 interrupted, 1 deaths, 6 s longest gap.');
});

test('a sentence may use only the counted numbers', async () => {
  const lines = await C.readWindow(LOGS, START - 3000, END + 3000);
  const c = C.count(lines, { player: PLAYER, start: START, end: END });
  assert.equal(C.numbersOk('Keep attacking: you lost 6 s.', c), true);
  assert.equal(C.numbersOk('You lost 9 s in the pull.', c), false, 'an invented number');
  assert.equal(C.numbersOk('You took 7 hits.', c), true);
  assert.equal(C.numbersOk('', c), false);
  assert.equal(C.numbersOk('one line\ntwo lines', c), false);
  assert.equal(C.numbersOk('x'.repeat(200), c), false);
});

test('a check fires only when the file shows it', () => {
  const quiet = { duration_s: 20, deaths: 0, enemyCasts: 0, interrupts: 0, hits: 1, idle_s: 1, burst_hits: 1, burst_s: 0 };
  assert.equal(C.pick(quiet), null, 'a clean fight gets no card');
  assert.deepEqual(C.pick({ ...quiet, enemyCasts: 2 }), { rule: 'interrupt', n: 2 });
  assert.deepEqual(C.pick({ ...quiet, enemyCasts: 2, interrupts: 1 }), null, 'interrupted casts are not a note');
  assert.deepEqual(C.pick({ ...quiet, burst_hits: 4, burst_s: 2 }), { rule: 'burst', n: 4, s: 2 });
  assert.deepEqual(C.pick({ ...quiet, deaths: 1 }), { rule: 'death', n: 1 });
});

test('no usable log: no lines, and no card', async () => {
  assert.equal(await C.readWindow(path.join(__dirname, '..', 'no-such-logs'), START, END), null);
  const none = await C.readWindow(LOGS, Date.parse('2020-01-01T00:00:00'), Date.parse('2020-01-01T00:10:00'));
  assert.deepEqual(none, [], 'a window the log does not cover');
  const c = C.count([], { player: PLAYER, start: START, end: END });
  assert.equal(C.pick(c), null);
});

const MODEL_SAYS = 'Keep attacking: you lost 6 s.\n\nTL;DR: Keep attacking; you lost 6 s.';

function make({ text = MODEL_SAYS, logDir = LOGS, reply = CTX } = {}) {
  const state = { forever: { bulk: {} }, context: { text: reply } };
  const finished = [], calls = [];
  const ctx = {
    cfg: { agent: 'claude', forever: { combatLogDir: logDir, mentorDir: path.join(__dirname, 'tmp') } },
    REPO: path.join(__dirname, '..', '..'),
    state,
    log: () => {},
    saveState: () => {},
    finish: (job, status, body) => finished.push({ status, body }),
    runAgentOnce: async o => { calls.push(o); return { status: 'done', text }; },
  };
  return { ctx, state, finished, calls };
}

const job = (extra = {}) => ({ id: 7, session: 's1', chat: 'c1', card: true, ctx: CTX, ...extra });

test('a card request is answered from the fixture with the counted numbers', async () => {
  const { ctx, state, finished, calls } = make();
  const owned = await cardMod.intercept(job(), ctx);
  assert.equal(owned, true, 'the module owns the card request');
  const card = state.forever.card;
  assert.ok(card, 'a card was stored');
  assert.equal(card.key, '2026-09-25T20:00:10/2026-09-25T20:00:43');
  assert.equal(card.text, 'One change: Keep attacking; you lost 6 s.', 'the TL;DR line is the sentence');
  assert.equal(card.why, 'Why: you did nothing for 6 s of the 33 s pull.');
  assert.match(card.counts, /33 s pull, 7 hits taken, 6 enemy casts/);
  assert.equal(calls.length, 1, 'one model run');
  assert.equal(calls[0].model, 'haiku', 'the cheap coach model writes the note');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].body, '', 'no reply text: a card is not a chat reply');
});

test('a model sentence with a number the file did not count is dropped for the code sentence', async () => {
  const { ctx, state } = make({ text: 'You lost 9 s in that pull.\n\nTL;DR: You lost 9 s.' });
  await cardMod.intercept(job(), ctx);
  assert.equal(state.forever.card.text, 'One change: keep attacking; the gaps cost you damage.');
  assert.doesNotMatch(state.forever.card.text, /9/, 'the invented number never reaches the card');
});

test('the model failing still gives a card, from code', async () => {
  const { ctx, state } = make();
  ctx.runAgentOnce = async () => ({ status: 'error', text: 'agent not installed' });
  await cardMod.intercept(job(), ctx);
  assert.equal(state.forever.card.text, 'One change: keep attacking; the gaps cost you damage.');
});

test('the combat log off gives no card and no error', async () => {
  const { ctx, state, finished } = make();
  const owned = await cardMod.intercept(job({ ctx: CTX + '\nlogging=false' }), ctx);
  assert.equal(owned, true, 'the request is still answered');
  assert.equal(state.forever.card, undefined);
  assert.equal(finished.length, 1, 'the job finishes so the addon stops sending it');
});

test('no usable log gives no card and no error', async () => {
  const { ctx, state } = make({ logDir: path.join(__dirname, 'no-such-logs') });
  await cardMod.intercept(job(), ctx);
  assert.equal(state.forever.card, undefined);

  const empty = make({ logDir: path.join(__dirname, '..', 'fixtures', 'guides') });
  await cardMod.intercept(job({ ctx: CTX.replace('2026-09-25T20:00:10', '2020-01-01T00:00:00').replace('2026-09-25T20:00:43', '2020-01-01T00:10:00') }), empty.ctx);
  assert.equal(empty.state.forever.card, undefined, 'a log that does not cover the fight');
});

test('a fight with nothing to say gets no card', async () => {
  const { ctx, state, calls } = make();
  const quiet = CTX.replace('2026-09-25T20:00:10', '2026-09-25T19:59:52').replace('2026-09-25T20:00:43', '2026-09-25T19:59:53');
  await cardMod.intercept(job({ ctx: quiet }), ctx);
  assert.equal(state.forever.card, undefined);
  assert.equal(calls.length, 0, 'no model run for a quiet fight');
});

test('the same fight is answered once', async () => {
  const { ctx, state, calls } = make();
  await cardMod.intercept(job(), ctx);
  const card = state.forever.card;
  await cardMod.intercept(job({ id: 8 }), ctx);
  assert.equal(calls.length, 1, 'no second model run');
  assert.equal(state.forever.card, card, 'the card is kept');
});

test('an ordinary job is not a card request', async () => {
  const { ctx, finished } = make();
  assert.equal(await cardMod.intercept({ id: 9, session: 's1', chat: 'c1', text: 'hi' }, ctx), false);
  assert.equal(finished.length, 0);
});

// The card travels as flag "k" (no chat, no reply) and comes back as a `card` table
// in the slot files, like the guide set.
test('the card flag and the card table', () => {
  assert.equal(cardP.parseFlags('k;c').card, true);
  assert.equal(cardP.parseFlags('c').card, false);
  const body = cardP.luaTable('Runback_Inbox', [], { card: { key: 'a/1', text: 'One change: x.', why: 'Why: y.', counts: 'z' } });
  assert.match(body, /card = \{ key = "a\/1", text = "One change: x\.", why = "Why: y\.", counts = "z" \}/);
  assert.doesNotMatch(cardP.luaTable('Runback_Inbox', [], {}), /card =/);
  assert.doesNotMatch(cardP.luaTable('Runback_Inbox', [], { card: { key: 'a', text: '' } }), /card =/, 'no text, no card');
});
