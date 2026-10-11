// Unit tests for the bridge's pure protocol code (bridge/protocol.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const P = require('../bridge/protocol');

test('luaStr escapes everything Lua 5.1 needs', () => {
  assert.equal(P.luaStr('a"b\\c\nd\re\x01'), '"a\\"b\\\\c\\nde\\001"');
  assert.equal(P.luaStr(null), '""');
  assert.equal(P.luaStr(42), '"42"');
});

test('parseFlags reads new-session, hello, forget, context, agent and allow lists', () => {
  const none = { newSession: false, hello: false, forget: false, context: false, allow: [], agent: '', model: '', effort: '', cmd: '' };
  assert.deepEqual(P.parseFlags(''), none);
  assert.deepEqual(P.parseFlags('n'), { ...none, newSession: true });
  assert.deepEqual(P.parseFlags('h'), { ...none, hello: true });
  assert.deepEqual(P.parseFlags('d'), { ...none, forget: true });
  assert.deepEqual(P.parseFlags('h;c'), { ...none, hello: true, context: true });
  assert.deepEqual(P.parseFlags('n;allow=WebSearch, Bash(git:*),'), { ...none, newSession: true, allow: ['WebSearch', 'Bash(git:*)'] });
  assert.deepEqual(P.parseFlags('agent=Codex'), { ...none, agent: 'codex' });
  assert.deepEqual(P.parseFlags('n;agent=grok;allow=WebSearch'), { ...none, newSession: true, agent: 'grok', allow: ['WebSearch'] });
  // A model keeps its case; anything that could be read as a CLI flag or shell text is dropped.
  assert.deepEqual(P.parseFlags('agent=claude;model=claude-sonnet-4-5[1m]'), { ...none, agent: 'claude', model: 'claude-sonnet-4-5[1m]' });
  assert.equal(P.parseFlags('agent=hermes;model=openrouter/x-ai/grok-4').model, 'openrouter/x-ai/grok-4');
  for (const bad of ['--dangerously-skip-permissions', 'a b', 'x$(y)', 'o"pus', 'a'.repeat(65), '']) {
    assert.equal(P.parseFlags('model=' + bad).model, '', bad);
  }
  // An effort level is lowercase letters only, up to 16, like the catalog's levels.
  assert.deepEqual(P.parseFlags('agent=claude;model=opus;effort=high'), { ...none, agent: 'claude', model: 'opus', effort: 'high' });
  for (const bad of ['--effort', 'High', 'high5', 'a b', 'a'.repeat(17), '']) {
    assert.equal(P.parseFlags('effort=' + bad).effort, '', bad);
  }
});

test('jobsFromStrip parses the current record format and keeps separators inside text', () => {
  const rec = ['sess', 'chat1', '12', 'realms', 'allow=WebSearch', 'My chat', 'hello\x1Fworld'].join('\x1F');
  const jobs = P.jobsFromStrip(12, rec);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], { session: 'sess', chat: 'chat1', id: 12, cwd: 'realms', newSession: false, hello: false, forget: false, context: false, allow: ['WebSearch'], agent: '', model: '', effort: '', cmd: '', name: 'My chat', text: 'hello\x1Fworld', via: 'pixel' });
  // A chat that picked its own agent says so in the flags.
  const codex = P.jobsFromStrip(13, ['sess', 'chat1', '13', '', 'agent=codex', 'My chat', 'hi'].join('\x1F'))[0];
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.text, 'hi');
});

test('jobsFromStrip reads the game context field only when the flags say so', () => {
  const ctx = 'Game: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter';
  const withCtx = ['sess', 'chat1', '13', '', 'c', 'My chat', ctx, 'is this\x1Fgood'].join('\x1F');
  const jobs = P.jobsFromStrip(13, withCtx);
  assert.equal(jobs[0].context, true);
  assert.equal(jobs[0].ctx, ctx);
  assert.equal(jobs[0].text, 'is this\x1Fgood');
  // An empty context clears it; a hello carries one too.
  const hello = P.jobsFromStrip(14, ['sess', 'chat1', '14', '', 'h;c', 'My chat', '', ''].join('\x1F'))[0];
  assert.equal(hello.hello, true);
  assert.equal(hello.ctx, '');
  assert.equal(hello.text, '');
  // Without the flag, a seventh field is just text with a separator in it.
  const plain = P.jobsFromStrip(15, ['sess', 'chat1', '15', '', '', 'My chat', 'a', 'b'].join('\x1F'))[0];
  assert.equal(plain.ctx, undefined);
  assert.equal(plain.text, 'a\x1Fb');
  // A "c" flag on a record too short to hold the field is not trusted.
  const short = P.jobsFromStrip(16, ['sess', 'chat1', '16', '', 'c', 'My chat', 'only text'].join('\x1F'))[0];
  assert.equal(short.ctx, undefined);
  assert.equal(short.text, 'only text');
});

test('systemPrompt always asks for the TL;DR block, and wraps the game context and primer when given', () => {
  // Without a context the prompt is only the reply-format rule.
  for (const empty of ['', '  \n ', undefined]) {
    const s = P.systemPrompt(empty);
    assert.ok(s.includes('wow-ai addon'));
    assert.ok(s.includes('"TL;DR:"'), 'asks for the summary marker');
    assert.ok(!s.includes('in-game situation'), 'no context section without a context');
    assert.ok(!s.includes('Reference for writing addons'), 'no primer section without a context');
  }
  const s = P.systemPrompt('Game: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter');
  assert.ok(s.includes('"TL;DR:"'));
  assert.ok(s.includes('WOW_AI_MAP_FILE') && s.includes('wowmap') && s.includes('"op":"set"'), 'explains how to mark the map');
  assert.ok(!P.systemPrompt('').includes('WOW_AI_MAP_FILE'), 'map hint only with the game context');
  assert.ok(s.includes('\nGame: World of Warcraft: Forever\nCharacter: Testchar, level 23 Hunter\n'));
  assert.ok(s.includes('Linked from the game'));
  assert.ok(s.includes('Never give the player /run, /script, /console or /dump lines') && s.includes('menu path'), 'settings come as menu paths, not scripts');
  assert.ok(!P.systemPrompt('').includes('/run'), 'the script rule only goes with the game context');
  assert.ok(!s.includes('Reference for writing addons'), 'no primer section without a primer');
  // The primer rides with the context, and only with it.
  const withPrimer = P.systemPrompt('Character: Testchar', '# Primer\n\nUse local.');
  assert.ok(withPrimer.endsWith('Reference for writing addons and macros for this client. Follow it when the task is about WoW, and check anything it marks as uncertain against the Blizzard UI source it names:\n\n# Primer\n\nUse local.'));
  assert.ok(!P.systemPrompt('', '# Primer').includes('# Primer'));
});

test('splitSummary takes the last TL;DR block for the game chat and keeps the whole reply for the window', () => {
  const reply = 'Renamed the function.\n\nDetails:\n- foo.js\n- bar.js\n\n---\n**TL;DR:** Renamed doIt to run in foo.js and bar.js.\nTests pass.';
  const r = P.splitSummary(reply);
  assert.equal(r.summary, 'Renamed doIt to run in foo.js and bar.js.\nTests pass.');
  assert.equal(r.text, reply);
  assert.deepEqual(P.splitSummary('no marker here'), { text: 'no marker here', summary: '' });
  assert.deepEqual(P.splitSummary(''), { text: '', summary: '' });
  assert.deepEqual(P.splitSummary(undefined), { text: '', summary: '' });
  // Headings, missing colon, no bold, and a marker that is not at a line start.
  assert.equal(P.splitSummary('a\n## TL;DR\nsum').summary, 'sum');
  assert.equal(P.splitSummary('a\ntldr: sum').summary, 'sum');
  assert.equal(P.splitSummary('a TL;DR: inline\nmore').summary, '');
  assert.equal(P.splitSummary('first TL;DR: x\n\nbody\n\nTL;DR: last one').summary, 'last one');
  // The slot file carries the summary only when there is one.
  const lua = P.luaTable('WoWAI_SlotData', [{ chat: 'c', id: 1, status: 'done', text: 'body\nTL;DR: short', summary: 'short' }, { chat: 'c', id: 2, status: 'done', text: 'plain' }]);
  assert.ok(lua.includes('summary = "short"'));
  assert.equal((lua.match(/summary = /g) || []).length, 1);
  // The agents installed on the bridge PC, and the models each can switch to.
  const pools = P.luaTable('WoWAI_SlotData', [], { agent: 'claude', agents: ['claude', 'codex'], models: { claude: ['opus', 'sonnet'], codex: [], 'bad id': ['x'] } });
  assert.ok(pools.includes('agents = { "claude", "codex" },'));
  assert.ok(pools.includes('models = { claude = { "opus", "sonnet" }, codex = {  } },'));
});

test('the shipped primer exists, mentions the essentials, and stays small enough to send on every run', () => {
  const fs = require('fs');
  const primer = fs.readFileSync(path.join(__dirname, '..', 'docs', 'WOW-ADDON-PRIMER.md'), 'utf8');
  for (const must of ['## Interface: 16001', 'Gethe/wow-ui-source', 'InCombatLockdown', 'hooksecurefunc', 'SavedVariables', '/reload', '#showtooltip']) {
    assert.ok(primer.includes(must), 'primer mentions ' + must);
  }
  assert.ok(primer.length < 9000, `primer is ${primer.length} chars; keep it under 9000 (it costs tokens on every message)`);
});

test('jobsFromStrip handles several records per frame and older formats', () => {
  const a = ['s', 'c1', '3', '', '', 'A', 'first'].join('\x1F');
  const b = ['s', 'c2', '4', 'C:\\x', 'n', 'second'].join('\x1F'); // no-name format
  const c = ['s', 'C:\\y', '', 'third'].join('\x1F'); // pre-chat format
  const jobs = P.jobsFromStrip(9, [a, b, c].join('\x1E'));
  assert.deepEqual(jobs.map(j => [j.id, j.chat, j.text, j.newSession]), [[3, 'c1', 'first', false], [4, 'c2', 'second', true], [9, '', 'third', false]]);
  assert.deepEqual(P.jobsFromStrip(1, 'garbage'), []);
  assert.deepEqual(P.jobsFromStrip(1, ['s', 'c', 'notanumber', '', '', '', 'x'].join('\x1F')), []);
});

test('parseOutbox decodes the SavedVariables fallback', () => {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const src = `WoWAIDB = {\n["outbox"] = {\n["id"] = 7,\n["session"] = "abc123",\n["chat"] = "c1",\n["text"] = "${hex('héllo')}",\n["cwd"] = "${hex('realms')}",\n["newSession"] = true,\n},\n["settings"] = {},\n}`;
  assert.deepEqual(P.parseOutbox(src), { id: 7, session: 'abc123', chat: 'c1', text: 'héllo', cwd: 'realms', newSession: true, via: 'reload' });
  const withAllow = src.replace('["newSession"]', `["allow"] = "${hex('WebSearch\x1fBash(git:*)')}",\n["newSession"]`);
  assert.deepEqual(P.parseOutbox(withAllow).allow, ['WebSearch', 'Bash(git:*)']);
  const withCtx = src.replace('["newSession"]', `["ctx"] = "${hex('Character: Testchar')}",\n["newSession"]`);
  assert.equal(P.parseOutbox(withCtx).ctx, 'Character: Testchar');
  const withAgent = src.replace('["newSession"]', '["agent"] = "codex",\n["newSession"]');
  assert.equal(P.parseOutbox(withAgent).agent, 'codex');
  assert.equal(P.parseOutbox(src).agent, undefined);
  const withModel = src.replace('["newSession"]', '["agent"] = "claude",\n["model"] = "sonnet",\n["newSession"]');
  assert.equal(P.parseOutbox(withModel).model, 'sonnet');
  assert.equal(P.parseOutbox(src.replace('["newSession"]', '["model"] = "-x",\n["newSession"]')).model, undefined);
  assert.equal(P.parseOutbox('WoWAIDB = {}'), null);
  assert.equal(P.parseOutbox('["outbox"] = { ["text"] = "" }'), null);
  // The reload outbox carries the chat's effort like its model; a bad token is dropped.
  const withEffort = src.replace('["newSession"] = true,', '["newSession"] = true,\n["model"] = "opus",\n["effort"] = "high",');
  assert.equal(P.parseOutbox(withEffort).effort, 'high');
  assert.equal(P.parseOutbox(withEffort.replace('"high"', '"--x"')).effort, undefined);
});

test('resolveCwd: empty is the default, relative joins it, ~ is home, absolute wins', () => {
  const base = path.resolve('C:\\work\\proj');
  assert.equal(P.resolveCwd('', base), base);
  assert.equal(P.resolveCwd('  ', base), base);
  assert.equal(P.resolveCwd('realms', base), path.join(base, 'realms'));
  assert.equal(P.resolveCwd('./realms/', base), path.join(base, 'realms'));
  assert.equal(P.resolveCwd('../other', base), path.resolve(base, '..', 'other'));
  assert.equal(P.resolveCwd('~/x', base), path.join(os.homedir(), 'x'));
  assert.equal(P.resolveCwd('D:\\elsewhere', base), path.win32.normalize('D:\\elsewhere'));
  assert.ok(P.sameFolder('C:\\A\\b\\', 'c:/a/B'));
  assert.ok(!P.sameFolder('C:\\a', 'C:\\a\\b'));
});

test('rulesFor gives one rule per part of a compound command', () => {
  const r = cmd => P.rulesFor({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.deepEqual(r('ls -la | head'), ['Bash(ls:*)', 'Bash(head:*)']);
  assert.deepEqual(r('echo "a | b" && ls'), ['Bash(echo:*)', 'Bash(ls:*)']);
  assert.deepEqual(r('ls 2>&1 | head &> out.txt'), ['Bash(ls:*)', 'Bash(head:*)']);
  assert.deepEqual(r('ls || ls'), ['Bash(ls:*)']);
  assert.deepEqual(r('ls | "C:\\x.exe" a'), ['Bash(ls:*)', 'Bash']);
  assert.deepEqual(P.rulesFor({ tool_name: 'WebSearch' }), ['WebSearch']);
  assert.deepEqual(r(''), ['Bash']);
});

test('ruleFor turns denials into prefix rules', () => {
  assert.equal(P.ruleFor({ tool_name: 'WebSearch' }), 'WebSearch');
  assert.equal(P.ruleFor({ tool_name: 'Bash', tool_input: { command: 'cargo build --release' } }), 'Bash(cargo:*)');
  assert.equal(P.ruleFor({ tool_name: 'Bash', tool_input: { command: '"C:\\weird path\\x.exe" arg' } }), 'Bash');
  assert.equal(P.ruleFor({}), 'Unknown');
});

test('describeToolUse gives one short line per tool call', () => {
  assert.equal(P.describeToolUse({ name: 'Bash', input: { command: 'npm test\nsecond line' } }), '$ npm test');
  assert.equal(P.describeToolUse({ name: 'Edit', input: { file_path: 'C:\\x\\player.gd' } }), 'edit player.gd');
  assert.equal(P.describeToolUse({ name: 'Mystery' }), 'Mystery');
});

test('handled ids are tracked per session token and capped', () => {
  const state = { lastId: 0, handled: {}, sessions: {} };
  const job = { session: 's1', id: 5 };
  assert.equal(P.alreadyHandled(state, job), false);
  P.markHandled(state, job, 1000);
  assert.equal(P.alreadyHandled(state, job), true);
  assert.equal(P.alreadyHandled(state, { session: 's2', id: 5 }), false);
  assert.equal(state.lastId, 5);
  assert.equal(state.seen.s1, 1000);
  for (let i = 1; i <= 1200; i++) P.markHandled(state, { session: 's1', id: i });
  assert.ok(Object.keys(state.handled.s1).length <= 1000);
  // Sessionless (inject / very old addon) jobs fall back to the high-water mark.
  assert.equal(P.alreadyHandled(state, { session: '', id: 3 }), true);
  assert.equal(P.alreadyHandled(state, { session: '', id: 5000 }), false);
});

test('pruneStale forgets session tokens not seen for a month', () => {
  const day = 24 * 3600 * 1000;
  const now = 100 * day;
  const state = { lastId: 0, handled: { old: { 1: 1 }, fresh: { 1: 1 }, unknown: { 1: 1 }, '': { 1: 1 } }, seen: { old: now - 40 * day, fresh: now - day } };
  const transcripts = { chats: {}, tokens: { old: now - 40 * day, fresh: now } };
  const removed = P.pruneStale(state, transcripts, now);
  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(state.handled).sort(), ['', 'fresh', 'unknown']);
  assert.equal(state.seen.unknown, now); // grace period starts when first seen by the pruner
  assert.deepEqual(Object.keys(transcripts.tokens), ['fresh']);
});

test('slotNumber wraps and SILENT_WAV is a valid RIFF header', () => {
  assert.equal(P.slotNumber(1, 200), 1);
  assert.equal(P.slotNumber(200, 200), 200);
  assert.equal(P.slotNumber(201, 200), 1);
  assert.equal(P.SILENT_WAV.toString('ascii', 0, 4), 'RIFF');
  assert.equal(P.SILENT_WAV.readUInt32LE(4), P.SILENT_WAV.length - 8);
  assert.equal(P.chatKey({ session: 's', chat: 'c' }), 's:c');
  assert.equal(P.sessKey({ session: 's', chat: 'c' }), 'chat:c');
  assert.equal(P.sessKey({ session: 's', chat: '' }), 's:default');
});


test('cmd flags accept only lowercase constrained names', () => {
  assert.equal(P.parseFlags('cmd=look').cmd, 'look');
  assert.equal(P.parseFlags('cmd=Look').cmd, '');
  assert.equal(P.parseFlags('cmd=a_b').cmd, '');
  assert.equal(P.parseFlags('cmd=' + 'a'.repeat(25)).cmd, '');
});

test('isBroadFolder: drive root, home and above, Documents/Desktop/Downloads; a project folder is not', () => {
  const home = path.join(os.tmpdir(), 'wowai-home', 'pedro');
  for (const d of [path.parse(home).root, home, path.dirname(home), path.join(home, 'Documents'), path.join(home, 'desktop'), path.join(home, 'Downloads'), path.join(home, 'OneDrive'), path.join(home, 'OneDrive - Work', 'Documents')]) {
    assert.equal(P.isBroadFolder(d, home), true, d);
  }
  for (const d of [path.join(home, 'Documents', 'wow-mentor'), path.join(home, 'code'), path.join(os.tmpdir(), 'elsewhere', 'Documents')]) {
    assert.equal(P.isBroadFolder(d, home), false, d);
  }
});

test('pickDefaultCwd: explicit wins, broad start and config folders fall back to the mentor workspace', () => {
  const home = path.join(os.tmpdir(), 'wowai-home', 'pedro');
  const docs = path.join(home, 'Documents'), proj = path.join(docs, 'realms'), mentorDir = path.join(docs, 'wow-mentor');
  const pick = o => P.pickDefaultCwd({ mentorDir, home, ...o });
  assert.deepEqual(pick({ project: docs, env: proj, started: proj }), { dir: docs, source: '--project' });
  assert.deepEqual(pick({ env: proj, started: docs }), { dir: proj, source: 'WOW_AI_PROJECT' });
  assert.deepEqual(pick({ started: proj, config: docs }), { dir: proj, source: 'started here' });
  assert.deepEqual(pick({ started: docs, config: proj }), { dir: proj, source: 'config.json' });
  // The video case: started in Documents, config written by setup from Documents.
  assert.deepEqual(pick({ started: docs, config: docs }), { dir: mentorDir, source: 'mentor workspace' });
  assert.deepEqual(pick({ started: '', config: '' }), { dir: mentorDir, source: 'mentor workspace' });
});

test('the mentor prompt forbids paste-in scripts and asks for menu paths', () => {
  const mentor = require('fs').readFileSync(path.join(__dirname, '..', 'mentor', 'AGENTS.md'), 'utf8');
  const rule = mentor.split('\n').find(l => l.includes('**No scripts to paste.**')) || '';
  for (const word of ['`/run`', '`/script`', '`/console`', '`/dump`', 'menu path', 'Options > Keybindings']) assert.ok(rule.includes(word), word);
  // Nothing else the agent reads may suggest such a line: every mention sits in a sentence that forbids it.
  for (const file of ['docs/WOW-ADDON-PRIMER.md', 'mentor/AGENTS.md', 'mentor/knowledge/community-sources.md']) {
    const text = require('fs').readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/\/(run|script|console|dump)\b/.test(line)) assert.ok(/\b(no|never|rejects)\b/i.test(line), file + ': ' + line.slice(0, 120));
    }
  }
});

test('a prompt starting with / is a command line the bridge will not forward to an agent (backlog 55)', () => {
  assert.equal(P.isSlashLine('/model 3.8 flash'), true);
  assert.equal(P.isSlashLine('  /run print(1)'), true);
  assert.equal(P.isSlashLine('what does /ai do?'), false);
  assert.equal(P.isSlashLine(''), false);
  assert.equal(P.isSlashLine(undefined), false);
  assert.ok(!P.SLASH_REFUSAL.includes('\n') && P.SLASH_REFUSAL.length < 200, 'one plain line');
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
  const q = src.slice(src.indexOf('function queueJob'), src.indexOf('function drainQueue'));
  assert.ok(q.indexOf('P.isSlashLine(job.text)') > -1 && q.indexOf('P.isSlashLine(job.text)') < q.indexOf('runJob(job)'), 'the check runs before any agent starts');
});
