'use strict';
// Backlog 47: a review waits for the combat log to reach the fight's end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../../bridge/forever/modules/06-review-wait');

const line = (s) => `10/11 20:03:${String(s).padStart(2, '0')}.000  SPELL_DAMAGE,Creature-0-1,"Mob",0x511,0x0,Player-1,"Hero-Realm",0x511,0x0`;
const year = new Date().getFullYear();
// Fight ends 20:03:40 local; the log is written as lines of "10/11 hh:mm:ss.mmm  EVENT".
const CTX = `lastFight=start=${year}-10-11T20:03:00,end=${year}-10-11T20:03:40,ok=1\nlogging=true`;

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'WoWCombatLog-101126_200000.txt');
  fs.writeFileSync(file, ['COMBAT_LOG_VERSION,12,0', line(1), line(20)].join('\n') + '\n'); // behind: stops at 20:03:20
  const published = [];
  const ctx = {
    cfg: { forever: { combatLogDir: dir, reviewWait: { pollMs: 20, timeoutMs: 300, ...extra } } },
    REPO: dir, state: {}, log() {}, chatKey: () => 'chat',
    publish: (key, rec) => published.push(rec.text),
  };
  const job = { id: 7, cmd: 'review', ctx: CTX, chat: 'chat' };
  return { dir, file, ctx, job, published };
}
const settled = (p, ms = 150) => Promise.race([p.then(v => ({ v })), new Promise(r => setTimeout(() => r(null), ms))]);

test('log behind the fight: one plain line, no start; starts once the log catches up', async (t) => {
  const { file, ctx, job, published } = setup(t, { timeoutMs: 5000 });
  const p = M.intercept(job, ctx);
  assert.equal(await settled(p), null, 'the review must not start while the log is behind');
  assert.deepEqual(published, [M.WAITING]);
  assert.match(M.WAITING, /waiting for the game to save the fight to the combat log/i);
  fs.appendFileSync(file, line(38) + '\n'); // 20:03:38 is within 3 s of the end 20:03:40
  const r = await settled(p, 1000);
  assert.deepEqual(r, { v: false }, 'false hands the job to the bridge, which starts the agent');
  assert.equal(published.length, 1, 'only one line is sent');
});

test('log never catches up: starts after the timeout and says so plainly', async (t) => {
  const { ctx, job, published } = setup(t);
  const r = await settled(M.intercept(job, ctx), 2000);
  assert.deepEqual(r, { v: false });
  assert.deepEqual(published, [M.WAITING, M.GAVE_UP]);
});

test('log already has the fight, or nothing to compare: no wait, no line', async (t) => {
  const { file, ctx, job, published } = setup(t);
  fs.appendFileSync(file, line(40) + '\n');
  assert.deepEqual(await settled(M.intercept(job, ctx)), { v: false });
  const off = setup(t);
  assert.equal(M.intercept({ ...off.job, ctx: CTX.replace('logging=true', 'logging=false') }, off.ctx), false);
  assert.equal(M.intercept({ ...off.job, cmd: 'death' }, off.ctx), false);
  assert.equal(M.intercept({ ...off.job, ctx: 'logging=true' }, off.ctx), false);
  fs.rmSync(off.file);
  assert.deepEqual(await settled(M.intercept(off.job, off.ctx)), { v: false }); // no log file at all: the mentor reports it
  assert.deepEqual(published, []);
  assert.deepEqual(off.published, []);
});

test('logsDir falls back to the Combat logs line of LOCAL.md', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-wait-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'LOCAL.md'), '- Combat logs: `/games/wow/Logs`\n');
  assert.equal(M.logsDir({ cfg: { forever: { mentorDir: dir } }, REPO: dir }), '/games/wow/Logs');
  assert.equal(M.logsDir({ cfg: {}, REPO: path.join(dir, 'x', 'y') }), '');
});
