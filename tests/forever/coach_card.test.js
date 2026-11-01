'use strict';
// The between-pull coach card (#140), bridge side: a card request is answered from
// the log file (the synthetic dryrun fixture), the model's sentence may only use the
// counted numbers, and no card is made without a usable log or with the log off.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mod = require('../../bridge/forever/modules/07-coach-card');

const LOGS = path.join(__dirname, '..', 'fixtures', 'dryrun', 'Logs');
const CTX = [
  'Character: Brakka on Testrealm, level 12 Warrior (Alliance)',
  'lastFight=start=2026-09-25T20:00:10,end=2026-09-25T20:00:43,hp=88',
  'logging=true',
].join('\n');
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
  const owned = await mod.intercept(job(), ctx);
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
  await mod.intercept(job(), ctx);
  assert.equal(state.forever.card.text, 'One change: keep attacking; the gaps cost you damage.');
  assert.doesNotMatch(state.forever.card.text, /9/, 'the invented number never reaches the card');
});

test('the model failing still gives a card, from code', async () => {
  const { ctx, state } = make();
  ctx.runAgentOnce = async () => ({ status: 'error', text: 'agent not installed' });
  await mod.intercept(job(), ctx);
  assert.equal(state.forever.card.text, 'One change: keep attacking; the gaps cost you damage.');
});

test('the combat log off gives no card and no error', async () => {
  const { ctx, state, finished } = make();
  const owned = await mod.intercept(job({ ctx: CTX + '\nlogging=false' }), ctx);
  assert.equal(owned, true, 'the request is still answered');
  assert.equal(state.forever.card, undefined);
  assert.equal(finished.length, 1, 'the job finishes so the addon stops sending it');
});

test('no usable log gives no card and no error', async () => {
  const { ctx, state } = make({ logDir: path.join(__dirname, 'no-such-logs') });
  await mod.intercept(job(), ctx);
  assert.equal(state.forever.card, undefined);

  const empty = make({ logDir: path.join(__dirname, '..', 'fixtures', 'guides') });
  await mod.intercept(job({ ctx: CTX.replace('2026-09-25T20:00:10', '2020-01-01T00:00:00').replace('2026-09-25T20:00:43', '2020-01-01T00:10:00') }), empty.ctx);
  assert.equal(empty.state.forever.card, undefined, 'a log that does not cover the fight');
});

test('a fight with nothing to say gets no card', async () => {
  const { ctx, state, calls } = make();
  const quiet = CTX.replace('2026-09-25T20:00:10', '2026-09-25T19:59:52').replace('2026-09-25T20:00:43', '2026-09-25T19:59:53');
  await mod.intercept(job({ ctx: quiet }), ctx);
  assert.equal(state.forever.card, undefined);
  assert.equal(calls.length, 0, 'no model run for a quiet fight');
});

test('the same fight is answered once', async () => {
  const { ctx, state, calls } = make();
  await mod.intercept(job(), ctx);
  const card = state.forever.card;
  await mod.intercept(job({ id: 8 }), ctx);
  assert.equal(calls.length, 1, 'no second model run');
  assert.equal(state.forever.card, card, 'the card is kept');
});

test('an ordinary job is not a card request', async () => {
  const { ctx, finished } = make();
  assert.equal(await mod.intercept({ id: 9, session: 's1', chat: 'c1', text: 'hi' }, ctx), false);
  assert.equal(finished.length, 0);
});

// The card travels as flag "k" (no chat, no reply) and comes back as a `card` table
// in the slot files, like the guide set.
const P = require('../../bridge/protocol');
test('the card flag and the card table', () => {
  assert.equal(P.parseFlags('k;c').card, true);
  assert.equal(P.parseFlags('c').card, false);
  const body = P.luaTable('Runback_Inbox', [], { card: { key: 'a/1', text: 'One change: x.', why: 'Why: y.', counts: 'z' } });
  assert.match(body, /card = \{ key = "a\/1", text = "One change: x\.", why = "Why: y\.", counts = "z" \}/);
  assert.doesNotMatch(P.luaTable('Runback_Inbox', [], {}), /card =/);
  assert.doesNotMatch(P.luaTable('Runback_Inbox', [], { card: { key: 'a', text: '' } }), /card =/, 'no text, no card');
});
