'use strict';
// Review waits for the combat log (backlog 47). The game writes the combat log in
// chunks, so right after a fight the file can still end before lastFight.end. A review
// started then ran the agent for minutes just to say "not saved yet". Before the agent
// starts, compare the log's last line time with the fight's end: if the log is behind,
// tell the player in one plain line and start the review once the file catches up, or
// after a timeout, saying so. Read-only: the log is only read, never changed.
const fs = require('fs');
const path = require('path');
const { firstLast } = require('../../../tools/slice-fight');

const SLACK_MS = 3000; // same padding the slicer uses around a fight
const POLL_MS = 2000;
const TIMEOUT_MS = 120000;
const WAITING = 'Waiting for the game to save the fight to the combat log. The review starts by itself when it has.';
const GAVE_UP = 'The game still has not saved the whole fight to the combat log. Starting the review anyway; it may miss the end of the fight.';

// "lastFight=start=2026-10-11T20:01:02,end=2026-10-11T20:03:40,..." in the addon's context.
function fightEnd(ctxText) {
  const m = /(?:^|\n)lastFight=[^\n]*?\bend=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(String(ctxText || ''));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Config first, else the "Combat logs:" line of the mentor workspace's LOCAL.md.
function logsDir(ctx) {
  const f = ctx.cfg.forever || {};
  if (f.combatLogDir) return f.combatLogDir;
  const root = f.mentorDir || path.join(ctx.REPO, '..', 'wow-mentor');
  try {
    const m = /Combat logs:\s*`([^`]+)`/i.exec(fs.readFileSync(path.join(root, 'LOCAL.md'), 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// Time of the newest line in the newest combat log, or null when there is no log.
async function logEnd(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  let newest = null;
  for (const n of names.filter(n => /^WoWCombatLog(?:-\d{6}_\d{6})?\.txt$/i.test(n))) {
    const p = path.join(dir, n);
    try {
      const st = await fs.promises.stat(p);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { p, mtimeMs: st.mtimeMs };
    } catch {}
  }
  if (!newest) return null;
  try { const r = await firstLast(newest.p); return Number.isFinite(r.last) ? r.last : null; } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  SLACK_MS, WAITING, GAVE_UP, fightEnd, logsDir, logEnd,
  // Resolves false so the bridge starts the review itself (after the wait, if any).
  intercept(job, ctx) {
    if (job.cmd !== 'review') return false;
    const text = job.ctx !== undefined ? job.ctx : (ctx.state.context && ctx.state.context.text);
    const end = fightEnd(text);
    if (end === null || /(?:^|\n)logging=false\b/.test(String(text))) return false; // no times, or logging was off: the mentor says so
    const dir = logsDir(ctx);
    if (!dir) return false;
    const opts = (ctx.cfg.forever || {}).reviewWait || {};
    const pollMs = opts.pollMs || POLL_MS, timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const behind = async () => { const last = await logEnd(dir); return last !== null && last < end - SLACK_MS; };
    const say = line => ctx.publish(ctx.chatKey(job), { chat: job.chat, id: job.id, status: 'working', text: line, cwd: job.cwd, session: '', agent: job.agent || '' }, true);
    return (async () => {
      if (!(await behind())) return false;
      say(WAITING);
      ctx.log(`#${job.id} review waits for the combat log (${dir})`);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        await sleep(pollMs);
        if (!(await behind())) { ctx.log(`#${job.id} combat log caught up`); return false; }
      }
      say(GAVE_UP);
      ctx.log(`#${job.id} combat log still behind after ${timeoutMs} ms; starting the review`);
      return false;
    })();
  },
};
