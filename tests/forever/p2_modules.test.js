'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lua = require('../../bridge/forever/lua-table');
const command = require('../../bridge/forever/modules/00-commands');
const mentor = require('../../bridge/forever/modules/05-mentor-guard');
const audit = require('../../bridge/forever/modules/10-audit');
const bulk = require('../../bridge/forever/modules/20-bulk');
const screenshots = require('../../bridge/forever/modules/30-screenshots');
const council = require('../../bridge/forever/modules/40-council');
const phone = require('../../bridge/forever/modules/50-phone');
const kill = require('../../bridge/forever/modules/01-killswitch');

test('safe Lua parser handles fields, escapes, comments, arrays, and truncation', () => {
  const source = 'Runback_Bulk = { -- hi\n ah = { version=2, at=3, items = { ' +
    '{ id=1, name="a\\n\\034", ok=true, price=-1.5e2, }, }, }, }';
  const out = lua.parseGlobal(source, 'Runback_Bulk');
  assert.equal(out.ah.items[0].name, 'a\n"');
  assert.equal(out.ah.items[0].price, -150);
  assert.equal(out.ah.items[0].ok, true);
  assert.throws(() => lua.parseGlobal('Runback_Bulk = { ah = {', 'Runback_Bulk'), e => e.name === 'LuaParseError' && e.truncated);
  assert.equal(lua.parseGlobal('Other = {}', 'Runback_Bulk'), undefined);
});

test('command prefix and mentor argument rewrites', () => {
  const job = { cmd: 'journal', text: 'go' };
  assert.equal(command.intercept(job), false);
  assert.equal(job.text, '[runback cmd=journal]\ngo');
  const claude = mentor.rewrite('claude', ['--permission-mode', 'default', '--allowedTools', 'Bash(*)', '--resume', 'x'], '/mentor', '/repo');
  assert.deepEqual(claude.slice(0, 3), ['--resume', 'x', '--permission-mode']);
  assert.ok(claude.includes('Read') && claude.includes(`Bash(node ${path.join('/repo', 'tools', 'slice-fight.js')}:*)`) && claude.includes(`Bash(node ${path.join('/repo', 'tools', 'check-citations.js')}:*)`) && claude.includes(`Bash(node ${path.join('/repo', 'tools', 'theorycraft.js')}:*)`) && claude.includes(`Bash(node ${path.join('/repo', 'tools', 'practice-compare.js')}:*)`) && claude.includes(`Bash(node ${path.join('/repo', 'tools', 'session-recap.js')}:*)`));
  assert.deepEqual(mentor.rewrite('codex', ['-s', 'read-only', '-C', '/old'], '/mentor', '/repo'), ['-s', 'workspace-write', '-C', '/mentor']);
  assert.deepEqual(mentor.rewrite('agy', [], '/mentor', '/repo'), ['--mode', 'accept-edits', '--add-dir', '/mentor']);
  // Bypass flags never survive into a mentor chat.
  assert.deepEqual(mentor.rewrite('codex', ['--dangerously-bypass-approvals-and-sandbox', '-C', '/old'], '/mentor', '/repo'),
    ['-s', 'workspace-write', '-C', '/mentor']);
  assert.deepEqual(mentor.rewrite('agy', ['--dangerously-skip-permissions', '--mode', 'plan'], '/mentor', '/repo'),
    ['--mode', 'accept-edits', '--add-dir', '/mentor']);
  assert.ok(!mentor.rewrite('grok', ['--always-approve'], '/mentor', '/repo').includes('--always-approve'));
  assert.deepEqual(mentor.rewrite('hermes', ['-y', '--yolo=1'], '/mentor', '/repo'), ['--in', '/mentor']);
  // codex exec keeps its trailing `resume <id> -` positionals last.
  assert.deepEqual(mentor.rewrite('codex', ['exec', '--json', '-C', '/old', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'abc', '-'], '/mentor', '/repo'),
    ['exec', '--json', '-s', 'workspace-write', '-C', '/mentor', 'resume', 'abc', '-']);
  // grok loses any configured allow rule, Bash(*) included.
  const grok = mentor.rewrite('grok', ['--allow', 'Bash(*)', '--permission-mode', 'acceptEdits'], '/mentor', '/repo');
  assert.ok(!grok.includes('Bash(*)') && grok.includes('Read') && grok.includes('dontAsk'));
  if (process.platform === 'win32') assert.ok(mentor.inside('C:/WoW-Mentor/x', 'c:/wow-mentor'));
  assert.deepEqual(mentor.rewrite('hermes', ['--yolo'], '/mentor', '/repo'), ['--in', '/mentor']);
});

test('audit appends prompt fields and prunes old dated files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-audit-'));
  const ctx = { HERE: dir, log() {} };
  const old = path.join(dir, 'audit'); fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, '2000-01-01.jsonl'), 'old');
  audit.init(ctx);
  audit.onRun({ job: { chat: 'c', text: 'prompt', ctx: 'context', images: ['x'], cmd: 'look' }, agentId: 'claude', cwd: '/x' }, ctx);
  const file = fs.readdirSync(old).find(f => f !== '2000-01-01.jsonl');
  const row = JSON.parse(fs.readFileSync(path.join(old, file), 'utf8'));
  assert.equal(row.prompt, 'prompt\ncontext');
  assert.equal(row.bytes, Buffer.byteLength(row.prompt));
  assert.deepEqual(row.attachments, ['x']);
  assert.equal(fs.existsSync(path.join(old, '2000-01-01.jsonl')), false);
});

test('bulk writes newer tables once and invokes logout journal handler', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-bulk-'));
  const cfg = { savedVariablesFile: '', agent: 'claude', forever: {
    mentorDir: dir, journal: { enabled: true, dir: path.join(dir, 'journal'), agent: '' }, clientDir: dir,
  } };
  const ctx = { HERE: dir, cfg,
    state: { forever: { bulk: {} } }, atomicWrite: (file, body) => fs.writeFileSync(file, body), saveState() {}, runAgentOnce(opts) { this.once = opts; } };
  bulk.onSavedVariables('Runback_Bulk = { ah = { version=1, at=2, items={} }, journal = { version=1, at=2, logout=true, events={} }, }', ctx);
  bulk.onSavedVariables('Runback_Bulk = { ah = { version=1, at=2, items={} }, }', ctx);
  assert.ok(fs.existsSync(path.join(dir, 'bulk', 'ah.json')));
  assert.equal(ctx.once.chat, 'journal');
  assert.equal(ctx.state.forever.bulk.ah.version, 1);
});

test('screenshot look attaches newest and refuses agy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-shot-'));
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'b.jpg');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  const now = Date.now();
  fs.utimesSync(a, new Date(now - 2000), new Date(now - 2000)); fs.utimesSync(b, new Date(now - 1000), new Date(now - 1000));
  const ctx = { cfg: { forever: { screenshotsDir: dir, clientDir: dir }, agent: 'claude' }, state: {}, finish(job, s, t) { this.finished = t; }, log() {} };
  screenshots.init(ctx);
  t.after(() => screenshots.stop());
  const job = { cmd: 'look', agent: 'claude' };
  assert.equal(screenshots.intercept(job, ctx), false);
  assert.deepEqual(job.images, [b]);
  assert.equal(screenshots.intercept({ cmd: 'look', agent: 'agy' }, ctx), true);
  assert.equal(ctx.finished, "Antigravity can't see screenshots. To ask about your screen, pick Claude, Codex, Grok or Hermes with the AI button, then press Print Screen and type look.");
  for (const agent of ['codex', 'grok', 'hermes']) assert.equal(screenshots.intercept({ cmd: 'look', agent }, ctx), false, agent);
  // A screenshot older than 10 minutes is never sent.
  fs.utimesSync(a, new Date(now - 3600000), new Date(now - 3600000)); fs.utimesSync(b, new Date(now - 3600000), new Date(now - 3600000));
  assert.equal(screenshots.intercept({ cmd: 'look', agent: 'claude' }, ctx), true);
  assert.match(ctx.finished, /last 10 minutes/);
});

test('council owns the job and tolerates agent timeout', async () => {
  const calls = [];
  const ctx = { cfg: { agents: { claude: {}, codex: {} }, forever: { council: { agents: ['claude', 'codex'], timeoutMs: 1, synthesizer: 'claude' } } },
    async runAgentOnce(o) { calls.push(o); return o.agentId === 'codex' ? { status: 'error', text: 'timeout' } : { status: 'done', text: 'answer' }; },
    finish(job, status, text) { this.result = text; } };
  const job = { cmd: 'council', text: '[runback cmd=council]\nquestion', cwd: '.' };
  // The claim is synchronous so the bridge can ack before the agents answer.
  assert.equal(council.intercept(job, ctx), true);
  await council.run(job, ctx);
  assert.equal(calls.length, 6);
  assert.match(ctx.result, /Missing: codex/);
});

test('phone intercept is disabled without a target and onFinish suppresses killed bridge', () => {
  let finished;
  const ctx = { cfg: { forever: { phone: { target: '' } } }, finish(job, status, text) { finished = text; } };
  assert.equal(phone.intercept({ cmd: 'phone' }, ctx), true);
  assert.match(finished, /notifications are off/);
});

test('kill switch refuses jobs and stops or restarts capture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-kill-'));
  const events = [];
  const ctx = { HERE: dir, capture: { stop() { events.push('stop'); }, start() { events.push('start'); } },
    finish(job, status, text) { this.reply = text; } };
  fs.writeFileSync(path.join(dir, 'KILLED'), '');
  kill.init(ctx);
  assert.deepEqual(events, ['stop']);
  assert.equal(kill.intercept({ cmd: 'hello' }, ctx), true);
  assert.match(ctx.reply, /AI is off/);
  assert.equal(kill.intercept({ cmd: 'on' }, ctx), true);
  assert.deepEqual(events, ['stop', 'start']);
  assert.equal(fs.existsSync(path.join(dir, 'KILLED')), false);
});

test('phone notifier invokes a fake node script with argv and never Hermes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-phone-'));
  const argsFile = path.join(dir, 'args.json');
  const script = path.join(dir, 'fake-notifier.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`);
  const ctx = { HERE: dir, state: { forever: {} }, cfg: { forever: { phone: { target: 'telegram:42', command: script, notifyAfterMs: 1 } } }, log() {} };
  phone.onFinish({ chat: 'abc', cmd: '', startedAt: Date.now() - 100 }, 'done', 'short answer', ctx);
  for (let i = 0; i < 30 && !fs.existsSync(argsFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['send', '-t', 'telegram:42', '-q', 'abc: done — short answer']);
});

test('lua table parser ignores __proto__ keys', () => {
  const { parseGlobal } = require('../../bridge/forever/lua-table');
  const t = parseGlobal('X = { ["__proto__"] = { a = 1 }, b = 2 }', 'X');
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  assert.equal(t.b, 2);
  assert.equal(t.a, undefined);
});

test('Sol review: rules, junctions, journal single-flight, kill switch stops agents', async () => {
  const A = require('../../bridge/agents');
  // An allow rule that looks like an option never reaches the CLI.
  const args = A.AGENTS.claude.args({ cfg: { allowedTools: ['Read', '--mcp-config=evil.json'] }, resume: '', system: '' });
  assert.ok(args.includes('Read') && !args.some(a => a.includes('mcp-config')));
  assert.ok(!A.AGENTS.grok.args({ cfg: { allowedTools: ['-x'] }, resume: '', cwd: '.', system: '', promptFile: 'p' }).includes('-x'));

  // A junction to the mentor folder is still the mentor folder.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-junction-'));
  const root = path.join(base, 'mentor'), link = path.join(base, 'link');
  fs.mkdirSync(root);
  try { fs.symlinkSync(root, link, 'junction'); } catch { /* no permission: skip this part */ }
  if (fs.existsSync(link)) assert.ok(mentor.inside(link, root));
  fs.rmSync(base, { recursive: true, force: true });

  // Blank lines don't make the SavedVariables search quadratic.
  const { parseGlobal } = require('../../bridge/forever/lua-table');
  const before = Date.now();
  assert.equal(parseGlobal('\n'.repeat(200000), 'Runback_Bulk'), undefined);
  assert.ok(Date.now() - before < 1000);

  // Two journal logouts in a row start one agent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-journal-'));
  let runs = 0, release;
  const ctx = { cfg: { agent: 'claude', forever: { mentorDir: dir, clientDir: dir, journal: { dir, enabled: true } } },
    state: { forever: { bulk: {} } }, saveState() {}, atomicWrite: (f, t) => fs.writeFileSync(f, t),
    runAgentOnce() { runs++; return new Promise(r => { release = r; }); } };
  bulk.init(ctx);
  bulk.onSavedVariables('Runback_Bulk = { ["journal"] = { ["version"] = 1, ["at"] = 1, ["logout"] = true } }', ctx);
  bulk.onSavedVariables('Runback_Bulk = { ["journal"] = { ["version"] = 2, ["at"] = 2, ["logout"] = true } }', ctx);
  assert.equal(runs, 1);
  release({ status: 'done' });
  await new Promise(r => setImmediate(r));
  fs.rmSync(dir, { recursive: true, force: true });

  // /runback off stops running agents.
  const killDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-kill2-'));
  let stopped = 0;
  const kctx = { HERE: killDir, capture: { stop() {}, start() {} }, stopRunning() { stopped++; }, finish() {} };
  kill.init(kctx);
  kill.intercept({ cmd: 'off' }, kctx);
  assert.equal(stopped, 1);
  fs.rmSync(killDir, { recursive: true, force: true });
});
