'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('../../bridge/forever');

test('registry calls hooks in order, isolates errors and can own jobs asynchronously', async () => {
  const seen = []; const logs = [];
  F.register({ init() { seen.push('init'); }, intercept() { seen.push('miss'); return false; }, augment(job, info) { info.args.push('x'); }, onRun() { throw Error('test'); }, onFinish() { seen.push('finish'); } }, 'one');
  F.register({ intercept: async () => { seen.push('owner'); return true; } }, 'two');
  F.init({ log: (...x) => logs.push(x) });
  assert.equal(await F.intercept({}), true);
  const info = { args: [] }; F.augment({}, info); assert.deepEqual(info.args, ['x']);
  F.onRun({}); F.onFinish({}, 'done', 'ok');
  assert.deepEqual(seen, ['init', 'miss', 'owner', 'finish']); assert.equal(logs.length, 1);
});

test('load honors disabled module basenames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forever-'));
  try { fs.writeFileSync(path.join(dir, 'skip.js'), 'module.exports = { init() { throw Error("loaded"); } }'); F.load(dir, ['skip']); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('runAgentOnce spawns and parses an agent without bridge chat state', async () => {
  const { runAgentOnce } = require('../../bridge/forever/run-agent-once');
  const A = require('../../bridge/agents'); const P = require('../../bridge/protocol');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forever-agent-'));
  try {
    const script = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ type: "result", session_id: "unused-session", is_error: false, result: "isolated answer" }) + "\\n");`);
    const cfg = { agents: { claude: { path: script } }, timeoutMs: 3000 };
    const seen = [];
    const augment = (job, info) => { seen.push(job.cwd); info.args = info.args.filter(x => x !== '--dangerously-skip-permissions'); };
    const result = await runAgentOnce({ agentId: 'claude', cwd: dir, prompt: 'hello' }, { A, P, cfg, killTree: child => child.kill(), augment });
    assert.deepEqual(result, { status: 'done', text: 'isolated answer' });
    // One-off runs (council, journal) go through the same mentor guard as chats.
    assert.deepEqual(seen, [dir]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reload outbox carries cmd', () => {
  const P = require('../../bridge/protocol');
  const src = 'RunbackDB = {\n["outbox"] = {\n["id"] = 5,\n["text"] = "6869",\n["cmd"] = "review",\n},\n}';
  assert.equal(P.parseOutbox(src).cmd, 'review');
  assert.equal(P.parseOutbox(src.replace('review', 'BAD CMD')).cmd, undefined);
});
