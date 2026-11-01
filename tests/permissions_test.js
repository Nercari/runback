// Decision 5 (issue 137): the game cannot widen an agent's permissions, a broad
// folder or one outside allowedFolders is refused, and outside the mentor
// workspace the default tools are read-only. These tests run the real bridge
// against a fake Claude CLI.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const FAKE = `
const fs = require('fs');
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', session_id: 's1', is_error: false, result: 'PONG' }));
});
`;
const MARK = 'PONG';

function sandbox({ allowed = [], defaultCwd } = {}) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-perm-'));
  const repo = path.join(S, 'repo');
  fs.cpSync(path.join(__dirname, '..', 'bridge'), path.join(repo, 'bridge'), { recursive: true, filter: f => !/[\\/]bridge[\\/]tmp/.test(f) });
  fs.cpSync(path.join(__dirname, '..', 'mentor'), path.join(repo, 'mentor'), { recursive: true });
  fs.mkdirSync(path.join(S, 'addons', 'Runback'), { recursive: true });
  fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
  fs.mkdirSync(path.join(S, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(S, 'addons', 'Runback', 'Runback.toc'), '## Interface: 16001\n');
  fs.writeFileSync(path.join(S, 'fake-claude.js'), FAKE);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'config.example.json'), 'utf8'));
  Object.assign(cfg, {
    addonDir: path.join(S, 'addons'), inboxFile: path.join(S, 'addons', 'Runback', 'Inbox.lua'),
    savedVariablesFile: path.join(S, 'saved.lua'), defaultCwd: defaultCwd || path.join(S, 'proj'),
    allowedFolders: allowed, slots: 5, progressWriteMs: 1, pollMs: 50,
  });
  cfg.capture = { ...(cfg.capture || {}), enabled: false };
  cfg.agent = 'claude';
  cfg.agents = { ...(cfg.agents || {}), claude: { ...((cfg.agents || {}).claude || {}), path: path.join(S, 'fake-claude.js') } };
  cfg.forever = { ...(cfg.forever || {}), mentorDir: path.join(S, 'mentor-workspace') };
  fs.writeFileSync(path.join(repo, 'bridge', 'config.json'), JSON.stringify(cfg, null, 2));
  assert.equal(spawnSync(process.execPath, ['install-slots.js'], { cwd: path.join(repo, 'bridge'), encoding: 'utf8' }).status, 0);
  const env = { ...process.env, FAKE_ARGV: path.join(S, 'argv.json') };
  delete env.CLAUDECODE;
  const run = args => spawnSync(process.execPath, args, { cwd: path.join(repo, 'bridge'), encoding: 'utf8', env, timeout: 60000 });
  const argv = () => fs.existsSync(env.FAKE_ARGV) ? JSON.parse(fs.readFileSync(env.FAKE_ARGV, 'utf8')) : null;
  const config = () => fs.readFileSync(path.join(repo, 'bridge', 'config.json'), 'utf8');
  // The reload path: the addon's SavedVariables outbox, with an old allow= rule.
  const outbox = (id, cwd, allow) => {
    const hex = s => Buffer.from(s, 'utf8').toString('hex');
    fs.writeFileSync(cfg.savedVariablesFile, 'RunbackDB = {\n["outbox"] = {\n' +
      `["id"] = ${id},\n["text"] = "${hex('hello')}",\n["cwd"] = "${hex(cwd)}",\n` +
      (allow ? `["allow"] = "${hex(allow)}",\n` : '') + '},\n}\n');
  };
  // The bridge stays up while the reload poll picks the outbox up (an async
  // module owns the job briefly, so --once would exit too early).
  const runLive = (id, cwd, marker, allow) => {
    outbox(id, cwd, allow);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['bridge.js'], { cwd: path.join(repo, 'bridge'), env, stdio: 'ignore' });
      const started = Date.now();
      const stop = () => {
        child.kill();
        if (child.exitCode !== null || child.signalCode) resolve();
        else child.once('exit', resolve);
      };
      const timer = setInterval(() => {
        let text = '';
        try { text = fs.readFileSync(cfg.inboxFile, 'utf8'); } catch {}
        if (text.includes(marker)) { clearInterval(timer); stop(); return; }
        if (Date.now() - started > 15000) { clearInterval(timer); stop(); reject(new Error(`timed out waiting for ${marker}`)); }
      }, 50);
    });
  };
  return { S, repo, cfg, run, argv, config, outbox, runLive };
}

test('outside the mentor workspace the default tools are read-only', () => {
  const s = sandbox();
  try {
    const r = s.run(['bridge.js', '--inject', 'hello', '--agent', 'claude']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const args = s.argv();
    const mode = args.indexOf('--permission-mode');
    assert.equal(args[mode + 1], 'default');
    const at = args.indexOf('--allowedTools');
    assert.ok(at >= 0);
    const rules = [];
    for (let i = at + 1; i < args.length && !args[i].startsWith('--'); i++) rules.push(args[i]);
    assert.deepEqual(rules, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
    assert.ok(!rules.some(rule => /^(Bash|Write|Edit)/.test(rule)), rules.join(', '));
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }
});

test('an allow= rule from the game leaves config.json unchanged', async () => {
  const s = sandbox();
  try {
    const before = s.config();
    await s.runLive(1, path.join(s.S, 'proj'), MARK, 'Bash(*)');
    assert.equal(s.config(), before, 'config.json is byte-for-byte the same');
    const args = s.argv();
    assert.ok(!args.some(a => /^Bash\(/.test(a)), args.join(' '));
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }
});

test('a folder outside allowedFolders is refused, and added only by config.json', async () => {
  let s = sandbox();
  try {
    await s.runLive(1, path.join(s.S, 'outside'), 'outside the folders this bridge allows');
    assert.equal(s.argv(), null, 'no agent run in a refused folder');
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }

  // The terminal adds it: the same chat now runs, read-only.
  s = sandbox({ allowed: [path.join(os.tmpdir(), 'runback-not-this-one')] });
  try {
    const cfg = JSON.parse(s.config());
    cfg.allowedFolders = [path.join(s.S, 'outside')];
    fs.writeFileSync(path.join(s.repo, 'bridge', 'config.json'), JSON.stringify(cfg, null, 2));
    await s.runLive(1, path.join(s.S, 'outside'), MARK);
    assert.ok(s.argv(), 'the agent ran inside an allowed folder');
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }
});

test('an agent with no read-only limit is refused outside the mentor workspace', () => {
  const s = sandbox();
  try {
    const r = s.run(['bridge.js', '--inject', 'hello', '--agent', 'hermes']);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.argv(), null);
    assert.match(fs.readFileSync(s.cfg.inboxFile, 'utf8'), /read-only tools outside the mentor workspace/);
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }
});

test('a broad folder is refused even when the terminal named it', () => {
  const s = sandbox();
  try {
    const r = s.run(['bridge.js', '--project', os.homedir(), '--inject', 'hello', '--agent', 'claude']);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(s.argv(), null);
    assert.match(fs.readFileSync(s.cfg.inboxFile, 'utf8'), /broad folder/);
  } finally { fs.rmSync(s.S, { recursive: true, force: true }); }
});
