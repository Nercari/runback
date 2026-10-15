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
