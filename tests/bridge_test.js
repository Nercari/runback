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

test('plainProgress turns every kind of raw progress line into one of a fixed set of phrases', () => {
  const raw = [
    '$ cd "C:/Users/x/wow-mentor" && node "C:/repo/tools/slice-fight.js" --start 1',
    '$ node C:/repo/tools/check-citations.js --review r.txt',
    '$ ls /tmp', '$ cat WoWCombatLog-101126.txt | head', 'read WoWCombatLog-101126_174100.txt', 'read toolu_01GxbuPG6Cvh8vs1VMiofAJe.txt',
    'read pedro-realm.md', 'read warlock.md', 'edit a.js, b.js', 'write new.md', 'delete old.md',
    'grep ^10/11/2026 17:4(1:(2[5-9]|[3-5]\\d)|2:(0\\d|1[0-5]))', 'grep: foo', 'glob {characters,reviews}/', 'ls src',
    'search: warlock wand', 'fetch https://example.com/x', 'tool: fs.list', 'agent: look around', 'todo list',
    '~ Looking at the tests first', 'Let me look at the file.', 'ToolSearch', 'TodoWrite', '', undefined,
  ];
  for (const line of raw) {
    const phrase = P.plainProgress(line);
    assert.ok(P.PROGRESS_PHRASES.includes(phrase), `${line} -> ${phrase}`);
  }
  assert.equal(P.plainProgress('$ node C:/repo/tools/slice-fight.js --start 1'), 'Cutting out your last fight');
  assert.equal(P.plainProgress('$ node C:/repo/tools/check-citations.js'), 'Checking my quotes against the log');
  assert.equal(P.plainProgress('read WoWCombatLog-101126_174100.txt'), 'Reading your combat log');
  assert.equal(P.plainProgress('read characters/Nercari.md'), 'Reading your notebook');
  assert.equal(P.plainProgress('grep SPELL_CAST_SUCCESS'), 'Searching the log');
  assert.equal(P.plainProgress('grep warlock'), 'Searching your files');
  assert.equal(P.plainProgress('search: wand vendor'), 'Searching the web');
  assert.equal(P.plainProgress('ToolSearch'), 'Getting ready');
  assert.equal(P.plainProgress('Let me look.'), 'Thinking it through');
});

test('addProgress keeps the newest three phrases and drops immediate repeats', () => {
  const list = [];
  for (const l of ['read a.txt', 'read b.txt', 'read c.txt', 'grep SPELL_', 'edit x.md', 'edit y.md']) P.addProgress(list, l);
  assert.deepEqual(list, ['Reading your files', 'Searching the log', 'Saving your notes']);
  P.addProgress(list, 'Antigravity is working (no live progress)', true);
  assert.deepEqual(list, ['Searching the log', 'Saving your notes', 'Antigravity is working (no live progress)']);
});

const CAST = '10/11/2026 17:41:56.311-3  SPELL_CAST_SUCCESS,Player-4613-01457956,"Nercari-ClassicBetaPvP2-",0x511,0x0,Player-4613-01457956,"Nercari-ClassicBetaPvP2-",0x511,0x0,687,"Demon Skin",0x20';
const HIT = '9/25/2026 19:59:52.000  SWING_DAMAGE,Creature-0-4395-0-12-1726-00001B2C3D,"Defias Magician",0xa48,0x0,Player-4395-0FFF9999,"Quelli-Testrealm",0x512,0x0,9,0,1,0,0,0,nil,nil,nil,nil';
const SHADOW = '9/25/2026 20:00:12.100  SPELL_DAMAGE,Creature-0-1,"Defias Pillager",0xa48,0x0,Player-1-2,"Quelli-Testrealm",0x512,0x0,116,"Frostbolt",0x10,9,0';

test('plainLogLine says who did what in one short sentence and keeps no raw fields', () => {
  assert.equal(P.plainLogLine(CAST), '17:41:56 Nercari cast Demon Skin');
  assert.equal(P.plainLogLine(HIT), '19:59:52 Defias Magician hit Quelli in melee');
  assert.equal(P.plainLogLine(SHADOW), '20:00:12 Defias Pillager hit Quelli with Frostbolt');
  // A quote cut short with an ellipsis still reads.
  assert.equal(P.plainLogLine(CAST.slice(0, CAST.indexOf('0x511')) + '…'), '17:41:56 Nercari cast a spell');
  assert.equal(P.plainLogLine('9/25/2026 20:00:30.000  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Creature-0-1,"Defias Pillager",0xa48,0x0'), '20:00:30 Defias Pillager died');
  assert.equal(P.plainLogLine('not a log line'), null);
});

test('plainEvidence swaps quoted log lines for one Evidence line per mistake and leaves the rest alone', () => {
  const review = [
    'Fight: Hogger (17:41:34-17:42:08), win',
    `1. Demon Skin cast mid-fight - 17:41:56`,
    `   Log: \`${CAST}\``,
    '   Why: it left you with 23 mana.',
    `2. Hit while moving - 20:00:12`,
    `   Log: ${HIT}`,
    `   ${SHADOW}`,
    '   Next time: stand still.',
    'Drill: none',
  ].join('\n');
  const out = P.plainEvidence(review);
  assert.equal(out, [
    'Fight: Hogger (17:41:34-17:42:08), win',
    '1. Demon Skin cast mid-fight - 17:41:56',
    '   Evidence: 17:41:56 Nercari cast Demon Skin',
    '   Why: it left you with 23 mana.',
    '2. Hit while moving - 20:00:12',
    '   Evidence: 19:59:52 Defias Magician hit Quelli in melee; 20:00:12 Defias Pillager hit Quelli with Frostbolt',
    '   Next time: stand still.',
    'Drill: none',
  ].join('\n'));
  // Fenced quotes, an inline span, three or more lines, and text with nothing to change.
  assert.equal(P.plainEvidence(['Proof:', '```', CAST, '```', 'done'].join('\n')), ['Proof:', 'Evidence: 17:41:56 Nercari cast Demon Skin', 'done'].join('\n'));
  assert.equal(P.plainEvidence(`You cast \`${CAST}\` too early.`), 'You cast 17:41:56 Nercari cast Demon Skin too early.');
  assert.match(P.plainEvidence([CAST, HIT, SHADOW].join('\n')), /^Evidence: .*; .* \(and 1 more in your saved review\)$/);
  assert.equal(P.plainEvidence('No quotes here, `code` stays.\n```lua\nlocal x = 1\n```'), 'No quotes here, `code` stays.\n```lua\nlocal x = 1\n```');
  assert.equal(P.plainEvidence(''), '');
  // Nothing raw survives, so the checker's exact quotes live only in the saved review.
  assert.doesNotMatch(out, /SPELL_|SWING_|Player-|0x5/);
});

test('replyNotes drops the permission sentence and parser internals; mapNote is one plain line', () => {
  assert.deepEqual(P.replyNotes(['Claude needs your OK to continue. Click Allow in the window.', 'Codex event parser failed: boom', 'x is a broad folder.']), ['x is a broad folder.']);
  assert.deepEqual(P.replyNotes(undefined), []);
  assert.equal(P.mapNote({ marked: 2 }), 'I marked 2 places on your map: open it with M.');
  assert.equal(P.mapNote({ marked: 1 }), 'I marked 1 place on your map: open it with M.');
  assert.equal(P.mapNote({ cleared: true }), 'I cleared the marks from your map.');
  assert.equal(P.mapNote({ errors: 1 }), 'I could not mark that on your map.');
  assert.equal(P.mapNote({}), '');
});

test('splitFollowUps turns a FOLLOW-UPS line into at most two short questions and strips it from the reply', () => {
  const r = P.splitFollowUps('Use Shadow Bolt.\n\nFOLLOW-UPS: What is my best rotation? | Which gear next?\nTL;DR: Use Shadow Bolt.');
  assert.deepEqual(r.followUps, ['What is my best rotation?', 'Which gear next?']);
  assert.equal(r.text, 'Use Shadow Bolt.\n\nTL;DR: Use Shadow Bolt.');
  assert.equal(P.splitSummary(r.text).summary, 'Use Shadow Bolt.', 'the summary is unaffected');
  // No tag, no follow-ups, text untouched.
  assert.deepEqual(P.splitFollowUps('plain reply'), { text: 'plain reply', followUps: [] });
  assert.deepEqual(P.splitFollowUps(undefined), { text: '', followUps: [] });
  // Cap at two, drop empty ones, collapse whitespace, tolerate bold and bullets.
  assert.deepEqual(P.splitFollowUps('a\n**FOLLOW-UPS:** one |  | two   words | three').followUps, ['one', 'two words']);
  assert.deepEqual(P.splitFollowUps('a\n- Follow-ups: "quoted?"').followUps, ['quoted?']);
  // A tag with nothing in it still disappears and shows no buttons.
  assert.deepEqual(P.splitFollowUps('a\nFOLLOW-UPS: | \nb'), { text: 'a\nb', followUps: [] });
  // Long questions are cut at a word, at most 80 characters.
  const long = P.splitFollowUps('a\nFOLLOW-UPS: ' + 'word '.repeat(40)).followUps[0];
  assert.ok(long.length <= 80 && long.endsWith('word'), long);
  // Only a line start counts, not the phrase inside a sentence.
  assert.deepEqual(P.splitFollowUps('see FOLLOW-UPS: x | y').followUps, []);
  // Without the colon it is a sentence, not the tag.
  assert.deepEqual(P.splitFollowUps('Go north.\nFollow up with the trainer in Orgrimmar.'), { text: 'Go north.\nFollow up with the trainer in Orgrimmar.', followUps: [] });
  assert.deepEqual(P.splitFollowUps('a\n**Follow-ups**: one').followUps, ['one']);
  // The reply-format rules tell the agent about the tag; the slot file carries it.
  assert.ok(P.systemPrompt('').includes('FOLLOW-UPS: <question> | <question>'));
  const lua = P.luaTable('WoWAI_SlotData', [{ chat: 'c', id: 1, status: 'done', text: 'x', followUps: ['Why "this"?', 'And that?'] }, { chat: 'c', id: 2, status: 'done', text: 'y', followUps: [] }]);
  assert.ok(lua.includes('followUps = { "Why \\"this\\"?", "And that?" },'), lua);
  assert.equal(lua.split('followUps').length, 2, 'none for a reply without follow-ups');
});
