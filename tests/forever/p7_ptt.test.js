'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ptt = require('../../bridge/forever/modules/70-ptt');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-ptt-'));
  const ctx = {
    HERE: root, REPO: root, state: {}, submitted: [], logs: [],
    lastStripSeenAt: () => Date.now(),
    submit(job) { this.submitted.push(job); },
    log(...args) { this.logs.push(args.join(' ')); },
  };
  ptt.init(ctx);
  // Close the watcher even when an assertion fails: an open fs.watch handle keeps
  // the test process alive, so a failure showed up as a 10-minute CI hang.
  t.after(() => { ptt.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  ptt.onRun({ job: { session: 'game-session', chat: 'chat-1', cwd: root, agent: 'claude' } });
  return { root, ctx };
}
function add(root) {
  const file = path.join(root, 'bridge', 'ptt', `${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ text: 'spoken words', at: Date.now(), confidence: 0.9 }));
  return file;
}

test('PTT submits recent-strip text uniquely and deletes its file', (t) => {
  const { root, ctx } = fixture(t);
  const file = add(root);
  ptt.drain();
  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.submitted[0].text, 'spoken words');
  assert.equal(ctx.submitted[0].via, 'ptt');
  assert.ok(ctx.submitted[0].session.startsWith('ptt-'));
  assert.equal(fs.existsSync(file), false);
});

test('PTT drops stale strip and kill switch input and logs the reason', (t) => {
  const { root, ctx } = fixture(t);
  // A fixed time: `Date.now() - 10001` read again inside drain() is only 10000 ms old
  // when the clock ticks between the two reads, and the input was submitted (#43 CI).
  const staleAt = Date.now() - 20000;
  ctx.lastStripSeenAt = () => staleAt;
  const stale = add(root);
  ptt.drain();
  assert.equal(ctx.submitted.length, 0);
  assert.equal(fs.existsSync(stale), false);
  fs.writeFileSync(path.join(root, 'KILLED'), '');
  ctx.lastStripSeenAt = () => Date.now();
  const killed = add(root);
  ptt.drain();
  assert.equal(ctx.submitted.length, 0);
  assert.equal(fs.existsSync(killed), false);
  assert.match(fs.readFileSync(path.join(root, 'bridge', 'ptt', 'ptt.log'), 'utf8'), /dropped: game in lockout or not running/);
});
