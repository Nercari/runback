// Launch 9 (#139): one coach note per pull has to cost about nothing, so a fight
// review runs on the agent's cheap model by default and a chat keeps its own.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync, spawn } = require('child_process');
const A = require('../bridge/agents');

// The cheap model each agent gets, the configured one, and the agents with none.
test('coachModel: the cheap model, the configured one, and the normal model', () => {
  assert.equal(A.coachModel({}, 'claude'), 'haiku');
  assert.equal(A.coachModel({ coachModel: 'sonnet' }, 'claude'), 'sonnet');
  assert.equal(A.coachModel({ coachModel: 'sonnet', models: ['opus'] }, 'claude'), '', 'a model the agent does not offer is ignored');
  assert.equal(A.coachModel({ coachModel: 'not-a-model' }, 'claude'), 'haiku', 'a bad value falls back to the default');
  assert.equal(A.coachModel({ models: ['opus', 'sonnet'] }, 'claude'), '', 'the player left the cheap model out');
  assert.equal(A.coachModel({ model: 'sonnet' }, 'claude'), 'haiku', 'the normal model does not turn it off');
  // No list here names a cheaper model than the normal one, so reviews keep it.
  for (const id of ['codex', 'grok', 'agy', 'hermes']) assert.equal(A.coachModel({}, id), '', `${id} has no cheap model`);
  assert.equal(A.coachModel({ models: ['gpt-5.5'] }, 'codex'), '');
});

// The real bridge with a fake Claude CLI that records its own command line.
const FAKE = `
const fs = require('fs');
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', session_id: 's1', is_error: false, result: 'Fight: nothing to fix.\\n\\nTL;DR: keep going.' })));
`;

const outbox = (id, fields) => 'RunbackDB = {\n["outbox"] = {\n' +
  Object.entries({ id, ...fields }).map(([k, v]) => `["${k}"] = ${typeof v === 'number' ? v : JSON.stringify(v)},\n`).join('') +
  '},\n}\n';

test('a coach note runs on the cheap model; a chat and a list without it keep their own', () => {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-coach-'));
  try {
    const repo = path.join(S, 'repo');
    for (const d of ['bridge', 'mentor', 'tools']) {
      fs.cpSync(path.join(__dirname, '..', d), path.join(repo, d), { recursive: true, filter: f => !/[\\/]bridge[\\/]tmp/.test(f) });
    }
    for (const f of ['config.json', 'state.json', 'bridge.log', 'KILLED']) fs.rmSync(path.join(repo, 'bridge', f), { force: true });
    const addons = path.join(S, 'addons', 'Runback');
    fs.mkdirSync(addons, { recursive: true });
    fs.writeFileSync(path.join(addons, 'Runback.toc'), '## Interface: 16001\n');
    const saved = path.join(S, 'Runback.lua');
    const fake = path.join(S, 'fake-claude.js');
    fs.writeFileSync(fake, FAKE);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'config.example.json'), 'utf8'));
    Object.assign(cfg, { addonDir: path.join(S, 'addons'), inboxFile: path.join(addons, 'Inbox.lua'), savedVariablesFile: saved, defaultCwd: path.join(S, 'proj'), slots: 5, progressWriteMs: 1, pollMs: 20 });
    cfg.agent = 'claude';
    cfg.capture = { ...cfg.capture, enabled: false };
    cfg.forever = { ...cfg.forever, mentorDir: path.join(S, 'mentor-workspace') };
    fs.mkdirSync(cfg.defaultCwd, { recursive: true });
    fs.mkdirSync(cfg.forever.mentorDir, { recursive: true });
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const OPUS = { id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
    const claude = (extra) => {
      cfg.agents = { ...cfg.agents, claude: { ...cfg.agents.claude, path: fake, model: '', models: [OPUS, 'sonnet', 'haiku'], coachModel: '', ...extra } };
      fs.writeFileSync(path.join(repo, 'bridge', 'config.json'), JSON.stringify(cfg, null, 2));
    };
    claude({});
    const inst = spawnSync(process.execPath, ['install-slots.js'], { cwd: path.join(repo, 'bridge'), encoding: 'utf8', env });
    assert.equal(inst.status, 0, inst.stderr);
    // One message in the reload outbox, then the real bridge until the agent starts.
    // A review's intercept is asynchronous, so the bridge runs normally and is killed.
    let id = 0;
    const send = (fields) => {
      id++;
      fs.writeFileSync(saved, outbox(id, fields));
      const argvFile = path.join(S, `argv-${id}.json`);
      const child = spawn(process.execPath, ['bridge.js'], { cwd: path.join(repo, 'bridge'), encoding: 'utf8', env: { ...env, FAKE_ARGV: argvFile }, stdio: 'ignore' });
      try {
        const until = Date.now() + 20000;
        while (!fs.existsSync(argvFile) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        assert.ok(fs.existsSync(argvFile), `the bridge did not start the agent for ${JSON.stringify(fields)}:\n` +
          (() => { try { return fs.readFileSync(path.join(repo, 'bridge', 'bridge.log'), 'utf8').slice(-1500); } catch { return ''; } })());
      } finally { child.kill('SIGKILL'); }
      return JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    };
    const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };

    // A review from a chat on opus, with its level: the note runs on haiku at the cheap model's own level.
    const review = send({ text: '526576696577', model: 'opus', effort: 'high', cmd: 'review' });
    assert.equal(flag(review, '--model'), 'haiku');
    assert.equal(flag(review, '--effort'), null);
    // A plain chat keeps the model and level it picked.
    const chat = send({ text: '6869', model: 'opus', effort: 'high' });
    assert.equal(flag(chat, '--model'), 'opus');
    assert.equal(flag(chat, '--effort'), 'high');
    // No cheap model in the player's list: the review uses the normal model, with no error.
    claude({ models: [OPUS, 'sonnet'] });
    const plain = send({ text: '526576696577', model: 'opus', effort: 'high', cmd: 'review' });
    assert.equal(flag(plain, '--model'), 'opus');
    // The configured coach model wins.
    claude({ coachModel: 'sonnet' });
    const own = send({ text: '526576696577', model: 'opus', effort: 'high', cmd: 'review' });
    assert.equal(flag(own, '--model'), 'sonnet');
  } finally {
    fs.rmSync(S, { recursive: true, force: true });
  }
});
