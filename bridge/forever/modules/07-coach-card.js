'use strict';
// Between-pull coach card (launch 10, #140). After a fight the addon asks for one
// card (a record with flag "k": no chat, no reply text). Code counts the checks
// from the game's combat log file; the coach model writes the one sentence, and
// every number in it is checked against the counts, so an invented number never
// reaches the player. The card goes back in the slot files and the addon shows it
// out of combat only. Read-only: the log is read, never changed, and this module
// never runs during a fight (the addon asks after the lockout ends).
const C = require('../../../tools/coach-card');
const P = require('../../protocol');
const A = require('../../agents');
const { logsDir } = require('./06-review-wait');

const TIMEOUT_MS = 20000;
const MAX_TEXT = 160;

// The model's one sentence, or '' when it failed or used a number the file did
// not count. The system prompt makes every reply end with "TL;DR:", so the last
// short line is the sentence; the card adds "One change:" itself.
async function sentence(ctx, counts, check) {
  const agentId = A.normalizeAgent((ctx.cfg.forever.card || {}).agent || ctx.cfg.agent) || 'claude';
  const acfg = A.agentConfig(ctx.cfg, agentId);
  const model = A.coachModel(acfg, agentId);
  const cwd = ctx.cfg.forever.mentorDir || ctx.REPO;
  const r = await ctx.runAgentOnce({ agentId, cwd, model, prompt: C.modelPrompt(counts, check), timeoutMs: TIMEOUT_MS });
  const cost = r && Number.isFinite(r.cost) ? r.cost : null;
  if (!r || r.status !== 'done') return { text: '', cost };
  const { text: body, summary } = P.splitSummary(String(r.text || ''));
  const line = (summary || body).split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
  const clean = line.replace(/^["'`]|["'`]$/g, '').replace(/^one change:\s*/i, '').trim();
  if (clean.length > MAX_TEXT) return { text: '', cost };
  return { text: C.numbersOk(clean, counts) ? clean : '', cost };
}

// One row per fight that the card looked at, kept in state.json for
// tools/card-report.js (#143): the counts, the sentence's source and what it cost.
const MAX_ROWS = 60;
function remember(ctx, row) {
  const rows = ctx.state.forever.cards = Array.isArray(ctx.state.forever.cards) ? ctx.state.forever.cards : [];
  rows.push(row);
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  if (ctx.saveState) ctx.saveState();
}

// Null means no card: the log was off, there is no usable log, the fight shows
// nothing worth a note, or this fight already had its card.
async function build(ctx, text) {
  if (/(?:^|\n)logging=false\b/.test(String(text || ''))) return null;
  const w = C.fightWindow(text), player = C.playerName(text);
  if (!w || !player) return null;
  const key = `${w.startISO}/${w.endISO}`;
  if (ctx.state.forever.cardKey === key) return null;
  const dir = logsDir(ctx);
  if (!dir) return null;
  const lines = await C.readWindow(dir, w.start - 3000, w.end + 3000);
  if (!lines || !lines.length) return null;
  const counts = C.count(lines, { player, start: w.start, end: w.end });
  const check = C.pick(counts);
  if (!check) {
    remember(ctx, { at: new Date().toISOString(), key, counts, check: null, source: 'none', text: '', cost: null });
    return null;
  }
  const said = await sentence(ctx, counts, check).catch(() => ({ text: '', cost: null }));
  const card = {
    key,
    text: 'One change: ' + (said.text || C.change(check)),
    why: 'Why: ' + C.reason(check, counts),
    counts: C.countsLine(counts),
  };
  remember(ctx, { at: new Date().toISOString(), key, counts, check: check.rule, source: said.text ? 'model' : 'code', text: card.text, cost: said.cost });
  return card;
}

async function handle(job, ctx) {
  let card = null, why = '';
  try { card = await build(ctx, job.ctx !== undefined ? job.ctx : (ctx.state.context && ctx.state.context.text)); }
  catch (e) { why = `failed: ${e && e.message}`; }
  if (card) {
    ctx.state.forever.card = card;
    ctx.state.forever.cardKey = card.key;
    ctx.saveState();
    ctx.log(`#${job.id} coach card: ${card.text}`);
  } else {
    ctx.log(`#${job.id} coach card: none${why ? ` (${why})` : ''}`);
  }
  // Never a chat reply: no bubble, no chat line and no transcript row for a card.
  // With no card, no sig flip either: the addon then reads no reply slot for it.
  job.chat = '';
  job.noSignal = !card;
  ctx.finish(job, 'done', '', job.session || '', []);
  return true;
}

module.exports = {
  TIMEOUT_MS,
  build,
  intercept(job, ctx) {
    if (!job.card) return false;
    return handle(job, ctx);
  },
};
