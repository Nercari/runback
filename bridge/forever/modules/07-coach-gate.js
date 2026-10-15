'use strict';
// Coach or stay quiet (J1). A fight review (cmd=review) is only ever sent once combat
// has ended: the addon blocks sends in combat, and this gate refuses to look at a fight
// that has no end time yet. It decides whether the fight deserves a coaching message:
//   1. Code first, from the numbers the addon already sends (deaths, wipe, boss, length,
//      starting health, damage per second against the recent average).
//   2. Only the middle cases ask Jev one noul question, with numbers and no text.
//   3. Any Jev failure runs the mentor, as before the gate existed.
// forever.coachGate.mode: off (no gate) | shadow (default: log the decision, run the
// mentor as today) | on (a quiet fight gets one plain line instead of an agent run).
// The gate decides whether the mentor speaks. It never acts in the game, sends no input
// and gives no live help.
const https = require('https');

const URL_ZEN = 'https://opencode.ai/zen/v1/systemone';
const MODELS = ['jev-1.13-free', 'jev-1.13'];
const TIMEOUT_MS = 8000;
const DEFAULTS = { mode: 'shadow', trivialSec: 45, longSec: 180, lowHpPct: 30, dropRatio: 0.6, askAbove: 0.5, historyMax: 5 };
const INSTRUCTIONS = 'A player just finished one fight in a fantasy online game. The state holds only numbers: duration_s (length of the fight), deaths (times the player died), boss (1 if an encounter, else 0), success (1 won, 0 lost, -1 unknown), start_hp_pct (the player\'s health when it began, -1 unknown), dps and damage (-1 unknown), avg_dps (their recent average, -1 unknown). Decide one thing: would a short coaching message about this fight help the player improve? Longer, harder fights and clear underperformance against avg_dps raise it; short, easy fights with no deaths lower it. Every other field is only a tie-breaker.';
const QUIET_LINE = 'Nothing in that fight needs coaching (short fight, no deaths, nothing unusual). Send review again within 10 minutes if you want the full review anyway.';

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

// Numbers out of the context lines the addon writes (Forever_Context.lua). The text is
// read here and only the numbers below ever leave this function.
function parseFight(ctxText) {
  const t = String(ctxText || '');
  const line = /(?:^|\n)lastFight=([^\n]*)/.exec(t);
  if (!line) return null;
  const f = line[1];
  const start = /\bstart=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(f);
  const end = /\bend=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(f);
  const okm = /\bok=([01])/.exec(f);
  const dl = /(?:^|\n)deaths=([^\n]*)/.exec(t);
  const meter = /(?:^|\n)meter=([^\n]*)/.exec(t);
  const endMs = end ? Date.parse(end[1]) : NaN;
  const startMs = start ? Date.parse(start[1]) : NaN;
  const inFight = ms => Number.isFinite(ms) && ms >= startMs - 3000 && ms <= endMs + 3000;
  let deaths = 0;
  if (dl) for (const d of dl[1].split(';')) { const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(d); if (m && inFight(Date.parse(m[1]))) deaths++; }
  return {
    key: start ? start[1] : '', ended: Number.isFinite(endMs) && Number.isFinite(startMs),
    duration: Number.isFinite(endMs - startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : -1,
    deaths, boss: /\benc=/.test(f) ? 1 : 0, success: okm ? Number(okm[1]) : -1,
    hp: num(/\bhp=(\d+)/, f) ?? -1,
    dps: meter ? (num(/\bdps (\d+)/, meter[1]) ?? -1) : -1,
    damage: meter ? (num(/\bdmg (\d+)/, meter[1]) ?? -1) : -1,
    logging: !/(?:^|\n)logging=false\b/.test(t),
  };
}

function average(history) {
  const v = history.filter(x => x > 0);
  return v.length >= 3 ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : -1;
}

// { action: 'coach'|'quiet'|'ask', why } from numbers only.
function decide(f, avgDps, o) {
  if (f.deaths > 0) return { action: 'coach', why: 'death' };
  if (f.success === 0) return { action: 'coach', why: 'wipe' };
  if (f.boss && f.duration >= 30) return { action: 'coach', why: 'boss' };
  if (f.duration >= o.longSec) return { action: 'coach', why: 'long' };
  if (f.hp >= 0 && f.hp < o.lowHpPct) return { action: 'coach', why: 'low-health start' };
  if (f.dps > 0 && avgDps > 0 && f.dps < avgDps * o.dropRatio) return { action: 'coach', why: 'dps drop' };
  if (f.duration >= 0 && f.duration < o.trivialSec) return { action: 'quiet', why: 'trivial' };
  return { action: 'ask', why: 'middle' };
}

// The only thing that leaves the machine: numbers, no names, chat or notebook text.
function jevState(f, avgDps) {
  return { duration_s: f.duration, deaths: f.deaths, boss: f.boss, success: f.success, start_hp_pct: f.hp, dps: f.dps, damage: f.damage, avg_dps: avgDps };
}
function jevBody(model, f, avgDps) {
  return { model, state: jevState(f, avgDps), questions: { coach: { type: 'noul', instructions: INSTRUCTIONS } } };
}

function send(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }, timeout: timeoutMs }, res => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => { s += c; if (s.length > 1e6) req.destroy(new Error('too large')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

// Probability the fight deserves coaching, or null on any failure. Models are tried in
// order inside one overall 8 s budget.
async function askJev(f, avgDps, ctx) {
  const sender = ctx.coachGateSend || send;
  const headers = process.env.OPENCODE_API_KEY ? { authorization: `Bearer ${process.env.OPENCODE_API_KEY}` } : {};
  const until = Date.now() + TIMEOUT_MS;
  for (const model of MODELS) {
    const left = until - Date.now();
    if (left <= 0) break;
    try {
      const r = await sender(URL_ZEN, headers, jevBody(model, f, avgDps), left);
      const p = r && r.json && r.json.answers && r.json.answers.coach && r.json.answers.coach.noul;
      if (r && r.status >= 200 && r.status < 300 && typeof p === 'number' && p >= 0 && p <= 1) return p;
    } catch { /* try the next model, then fall back to the mentor */ }
  }
  return null;
}

const state = { dps: [], quieted: new Set() };
function options(ctx) {
  const o = Object.assign({}, DEFAULTS, (ctx.cfg.forever || {}).coachGate || {});
  if (!['off', 'shadow', 'on'].includes(o.mode)) o.mode = 'shadow';
  return o;
}

// Resolves true when the gate answered the job itself (quiet, mode on); false hands it
// to the mentor. Never throws into the bridge: any failure means the mentor runs.
async function gate(job, ctx) {
  const o = options(ctx);
  if (o.mode === 'off' || job.cmd !== 'review') return false;
  const text = job.ctx !== undefined ? job.ctx : (ctx.state.context && ctx.state.context.text);
  const f = parseFight(text);
  if (!f || !f.ended || !f.logging) return false; // no finished fight to judge: the mentor says what is missing
  const avg = average(state.dps);
  if (f.dps > 0 && !state.dps.includes(f.dps + 0.5)) { state.dps.push(f.dps); if (state.dps.length > o.historyMax) state.dps.shift(); }
  let d = decide(f, avg, o);
  let p = null;
  if (d.action === 'ask') {
    p = await askJev(f, avg, ctx);
    d = p === null ? { action: 'coach', why: 'jev unavailable' } : p >= o.askAbove ? { action: 'coach', why: `jev ${p.toFixed(2)}` } : { action: 'quiet', why: `jev ${p.toFixed(2)}` };
  }
  const by = d.why.startsWith('jev ') ? 'jev' : 'code';
  const asked = state.quieted.has(f.key);
  ctx.log(`#${job.id} coach gate (${o.mode}): ${d.action} by ${by} (${d.why}); ${f.duration}s, deaths ${f.deaths}`);
  if (o.mode !== 'on' || d.action === 'coach') return false;
  if (asked) return false; // the player asked again for the same fight: run the mentor
  state.quieted.add(f.key);
  ctx.finish(job, 'done', QUIET_LINE, job.session || '', []);
  return true;
}

module.exports = {
  URL_ZEN, MODELS, TIMEOUT_MS, DEFAULTS, QUIET_LINE, parseFight, decide, average, jevState, jevBody, askJev, gate,
  _state: state,
  intercept(job, ctx) { return gate(job, ctx).catch(e => { ctx.log('coach gate failed:', e && e.message); return false; }); },
};
