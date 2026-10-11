// Guide channel (backlog 67): env var, ```wowguide blocks, validation, state.json,
// slot-file encoding with a version, and the real Guide.lua / WoWAI.lua reading it
// back in a Lua VM. Mirrors the map-layer tests (map_test.js, map_addon_test.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const G = require('../bridge/guide');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'guides', name + '.json'), 'utf8');
const mini = (id, extra = {}) => ({ id, title: `Guide ${id}`, steps: [{ kind: 'do', text: 'Walk to the fire.', points: [{ m: 9990, x: 45.5, y: 60.25 }] }], ...extra });

function luaVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  return { run, evaluate };
}

test('extractGuideBlocks takes wowguide blocks out of the reply, even unreadable ones', () => {
  const text = 'Here is your guide.\n\n```wowguide\n' + JSON.stringify(mini('a')) + '\n```\n\nAnd:\n```wowguide\n[' + JSON.stringify(mini('b')) + ']\n```\n```wowguide\nnot json\n```\nBye.';
  const r = G.extractGuideBlocks(text);
  assert.deepEqual(r.raw.map(g => g.id), ['a', 'b']);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.text.includes('wowguide') && !r.text.includes('Walk to the fire'));
  assert.ok(r.text.startsWith('Here is your guide.') && r.text.endsWith('Bye.'));
  assert.deepEqual(G.extractGuideBlocks('no blocks').raw, []);
});

test('readGuideFile accepts one guide or a list and reports junk', () => {
  assert.equal(G.readGuideFile(JSON.stringify(mini('a'))).raw.length, 1);
  assert.equal(G.readGuideFile(JSON.stringify([mini('a'), mini('b')])).raw.length, 2);
  assert.deepEqual(G.readGuideFile('  \n'), { raw: [], errors: [] });
  assert.equal(G.readGuideFile('{broken').errors.length, 1);
});

test('applyGuides stores valid guides, bumps the version only on change, and rejects hostile ones', () => {
  const store = G.newGuides('e1');
  let r = G.applyGuides(store, [mini('a')]);
  assert.ok(r.changed); assert.equal(store.version, 1); assert.deepEqual(r.titles, ['Guide a']);
  r = G.applyGuides(store, [mini('a')]); // same content again
  assert.ok(!r.changed); assert.equal(store.version, 1); assert.equal(r.stored, 1);
  r = G.applyGuides(store, [mini('a', { title: 'New title' })]); // same id replaces
  assert.equal(store.guides.length, 1); assert.equal(store.guides[0].title, 'New title'); assert.equal(store.version, 2);

  // Hostile and invalid input is validated, not stored raw.
  const before = JSON.stringify(store);
  r = G.applyGuides(store, [{ id: 'bad id!', steps: [{ kind: 'note', text: 'x' }] }, { id: 'nosteps', steps: [] }, 'text', null, 7]);
  assert.ok(!r.changed); assert.equal(r.stored, 0);
  assert.equal(JSON.stringify(store), before);
  const s2 = G.newGuides('e');
  G.applyGuides(s2, JSON.parse(fixture('hostile')));
  assert.ok(!/run_macro/.test(JSON.stringify(s2)));
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f|]/.test(JSON.stringify(s2).replace(/\\u00[0-9a-f]{2}/g, '')), 'no control characters or pipes stored');
  assert.equal(({}).polluted, undefined);
});

test('the state keeps at most 12 guides and 1500 steps, dropping the oldest', () => {
  const store = G.newGuides('e');
  for (let i = 0; i < 15; i++) G.applyGuides(store, [mini('g' + i)]);
  assert.equal(store.guides.length, 12);
  assert.equal(store.guides[0].id, 'g3');
  const big = id => ({ id, steps: Array.from({ length: 600 }, (_, i) => ({ kind: 'note', text: 'step ' + i })) });
  const s2 = G.newGuides('e');
  G.applyGuides(s2, [big('a'), big('b'), big('c')]);
  assert.deepEqual(s2.guides.map(g => g.id), ['b', 'c']);
  assert.ok(s2.guides.reduce((n, g) => n + g.steps.length, 0) <= G.GUIDE_STATE_STEPS);
});

test('guideNote is one plain line', () => {
  assert.equal(G.guideNote({ titles: ['Demo'] }), 'I saved the guide "Demo".');
  assert.equal(G.guideNote({ titles: ['a', 'b'] }), 'I saved 2 guides.');
  assert.equal(G.guideNote({ failed: true }), 'I could not save that guide.');
  assert.equal(G.guideNote({}), '');
});

test('the system prompt tells the agent about WOW_AI_GUIDE_FILE only with the game context', () => {
  const s = P.systemPrompt('Character: Testchar, level 5 Mage');
  assert.ok(s.includes('WOW_AI_GUIDE_FILE') && s.includes('wowguide') && s.includes('never a macro'));
  assert.ok(!P.systemPrompt('').includes('WOW_AI_GUIDE_FILE'));
});

const FULL = {
  id: 'demo-start', title: 'Demo "start" route', minLevel: 1, maxLevel: 3, faction: 'Alliance', source: 'Invented test guide',
  steps: [
    { kind: 'accept', text: 'Talk to the sample officer.', quest: 'Sample Task One', questId: 90001, points: [{ m: 9990, x: 45.5, y: 60.25, label: 'Camp fire' }] },
    { kind: 'do', text: 'Defeat five dummies \\ near the camp.', quest: 'Sample Task One', questId: 90001, points: [{ m: 9990, x: 47, y: 62, radius: 5 }], sticky: true, completewith: 3, level: { min: 1, max: 2 }, class: ['Mage', 'Druid'], race: ['Human'], faction: 'Alliance', optional: true },
    { kind: 'turnin', text: 'Report back.', quest: 'Sample Task One', questId: 90001 },
  ],
};

test('slot files carry the guides as a Lua table with a version, and only when there are some', () => {
  const store = G.newGuides('ep0ch');
  G.applyGuides(store, [FULL]);
  assert.equal(store.version, 1);
  const src = P.luaTable('WoWAI_SlotData', [], { now: 1, cwd: '/x', guides: store });
  const vm = luaVM();
  vm.run(src);
  assert.equal(vm.evaluate('WoWAI_SlotData.guides.epoch'), 'ep0ch');
  assert.equal(vm.evaluate('WoWAI_SlotData.guides.version'), '1');
  const g = 'WoWAI_SlotData.guides.list[1]';
  assert.equal(vm.evaluate(`${g}.title`), 'Demo "start" route');
  assert.equal(vm.evaluate(`#${g}.steps`), '3');
  assert.equal(vm.evaluate(`${g}.steps[2].text`), 'Defeat five dummies \\ near the camp.');
  assert.equal(vm.evaluate(`${g}.steps[2].points[1].radius`), '5');
  assert.equal(vm.evaluate(`${g}.steps[2].completewith`), '3');
  assert.equal(vm.evaluate(`${g}.steps[2].class[2]`), 'Druid');
  assert.equal(vm.evaluate(`${g}.steps[2].level.max`), '2');
  assert.equal(vm.evaluate(`${g}.steps[1].points[1].label`), 'Camp fire');
  assert.ok(!P.luaTable('X', [], { now: 1 }).includes('guides ='));
  assert.ok(P.luaTable('X', [], { now: 1, map: P.newMap('m'), guides: store }).includes('guides ='));
});

test('one guide round-trips: bridge Lua -> slot data -> Guide.lua -> saved variables', () => {
  const store = G.newGuides('ep0ch');
  G.applyGuides(store, [FULL]);
  const vm = luaVM();
  vm.run(fs.readFileSync(path.join(ADDON, 'Guide.lua'), 'utf8'));
  vm.run(P.luaTable('WoWAI_SlotData', [], { now: 1, guides: store }));
  assert.equal(vm.evaluate('WoWAIGuide.Sync(WoWAI_SlotData.guides)'), 'true');
  assert.equal(vm.evaluate('WoWAIGuideDB.guides.version'), '1');
  assert.equal(vm.evaluate('#WoWAIGuide.List()'), '1');
  assert.equal(vm.evaluate('WoWAIGuide.Find("demo-start").steps[3].kind'), 'turnin');
  assert.equal(vm.evaluate('WoWAIGuide.Find("nope")'), null);
  // The same or an older version changes nothing; a newer one or another epoch replaces.
  assert.equal(vm.evaluate('WoWAIGuide.Sync(WoWAI_SlotData.guides)'), 'false');
  assert.equal(vm.evaluate('WoWAIGuide.Sync({ epoch = "ep0ch", version = 0, list = {} })'), 'false');
  assert.equal(vm.evaluate('#WoWAIGuide.List()'), '1');
  assert.equal(vm.evaluate('WoWAIGuide.Sync({ epoch = "ep0ch", version = 2, list = {} })'), 'true');
  assert.equal(vm.evaluate('#WoWAIGuide.List()'), '0');
  assert.equal(vm.evaluate('WoWAIGuide.Sync({ epoch = "other", version = 1, list = { { id = "x", steps = { { kind = "note", text = "t" } } } } })'), 'true');
  assert.equal(vm.evaluate('WoWAIGuide.Version()'), '1');
  // Junk is ignored, not stored.
  assert.equal(vm.evaluate('WoWAIGuide.Sync("junk")'), 'false');
  assert.equal(vm.evaluate('WoWAIGuide.Sync({ epoch = "e3", version = 1, list = { 5, { id = 1 }, { id = "y", steps = {} } } })'), 'true');
  assert.equal(vm.evaluate('#WoWAIGuide.List()'), '0');
});

test('slot data carrying guides reaches the guide store through the real WoWAI.lua', () => {
  const vm = luaVM();
  vm.run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Guide.lua']) vm.run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  const store = G.newGuides('ep0ch');
  G.applyGuides(store, [FULL]);
  vm.run(`STUB.FireEvent("ADDON_LOADED", "WoWAI"); ${P.luaTable('WoWAI_Inbox', [], { now: 1, guides: store })}; STUB.FireEvent("PLAYER_LOGIN")`);
  assert.equal(vm.evaluate('WoWAIGuideDB.guides.list[1].id'), 'demo-start');
  assert.equal(vm.evaluate('WoWAIGuideDB.guides.version'), '1');
});

test('Guide.lua calls no game action, shows nothing, and replaces nothing', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Guide.lua'), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(src, /CreateFrame|print\(|hooksecurefunc|Quest|Gossip|Target|Cast|Taxi|Trainer|RegisterEvent|C_[A-Z]/);
});

// The real bridge with a fake Claude CLI: the run gets WOW_AI_GUIDE_FILE, a guide in
// the file and one in the reply are kept, a hostile one is not.
const FAKE = `
const fs = require('fs');
process.stdin.resume(); process.stdin.on('data', () => {});
const emit = (o) => console.log(JSON.stringify(o));
fs.appendFileSync(process.env.FAKE_ENVOUT, (process.env.WOW_AI_GUIDE_FILE || 'MISSING') + '\\n');
if (process.env.FAKE_MODE === 'guides') {
  fs.writeFileSync(process.env.WOW_AI_GUIDE_FILE, JSON.stringify({ id: 'fromfile', title: 'From the file', steps: [{ kind: 'note', text: 'Written to the guide file.' }] }));
  const reply = [
    'Here is a short guide.',
    '\`\`\`wowguide',
    JSON.stringify({ id: 'inreply', title: 'In the reply', steps: [{ kind: 'do', text: 'Walk |cffff0000north|r.', points: [{ m: 1429, x: 40, y: 50 }] }] }),
    '\`\`\`',
    '\`\`\`wowguide',
    JSON.stringify([{ id: 'evil', steps: [{ kind: 'run_macro', text: '/run DeleteCursorItem()' }] }, { id: '../bad', steps: [{ kind: 'note', text: 'x' }] }]),
    '\`\`\`',
  ].join('\\n');
  emit({ type: 'result', session_id: 's1', is_error: false, result: reply });
} else {
  emit({ type: 'result', session_id: 's1', is_error: false, result: 'No guide this time.' });
}
`;

test('the bridge sets WOW_AI_GUIDE_FILE on every run and keeps validated guides', () => {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-guide-'));
  try {
    const repo = path.join(S, 'repo');
    fs.cpSync(path.join(__dirname, '..', 'bridge'), path.join(repo, 'bridge'), { recursive: true, filter: f => !/[\\/]bridge[\\/]tmp/.test(f) });
    fs.cpSync(path.join(__dirname, '..', 'mentor'), path.join(repo, 'mentor'), { recursive: true });
    fs.mkdirSync(path.join(S, 'addons', 'WoWAI'), { recursive: true });
    fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(S, 'addons', 'WoWAI', 'WoWAI.toc'), '## Interface: 16001\n');
    fs.writeFileSync(path.join(S, 'fake-claude.js'), FAKE);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'config.example.json'), 'utf8'));
    Object.assign(cfg, { addonDir: path.join(S, 'addons'), inboxFile: path.join(S, 'addons', 'WoWAI', 'Inbox.lua'), savedVariablesFile: path.join(S, 'nope.lua'), defaultCwd: path.join(S, 'proj'), slots: 5, progressWriteMs: 1 });
    cfg.agent = 'claude';
    cfg.agents = { ...(cfg.agents || {}), claude: { ...((cfg.agents || {}).claude || {}), path: path.join(S, 'fake-claude.js') } };
    cfg.forever = { ...(cfg.forever || {}), mentorDir: path.join(S, 'mentor-workspace') };
    fs.writeFileSync(path.join(repo, 'bridge', 'config.json'), JSON.stringify(cfg, null, 2));
    const envOut = path.join(S, 'env.txt');
    const baseEnv = { ...process.env, FAKE_ENVOUT: envOut };
    delete baseEnv.CLAUDECODE;
    const run = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: path.join(repo, 'bridge'), encoding: 'utf8', env: { ...baseEnv, ...extra }, timeout: 60000 });
    assert.equal(run(['install-slots.js']).status, 0);

    // A run that writes no guide still gets the variable, and stores nothing.
    let r = run(['bridge.js', '--inject', 'hello', '--agent', 'claude'], { FAKE_MODE: 'none' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let state = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'state.json'), 'utf8'));
    assert.equal(state.guides.version, 0);
    assert.deepEqual(state.guides.guides, []);

    r = run(['bridge.js', '--inject', 'make me a guide', '--agent', 'claude'], { FAKE_MODE: 'guides' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const paths = fs.readFileSync(envOut, 'utf8').trim().split('\n');
    assert.equal(paths.length, 2);
    for (const p of paths) assert.match(p, /guidejobs[\\/].+\.json$/, 'WOW_AI_GUIDE_FILE is set for every run');
    assert.notEqual(paths[0], paths[1], 'one file per job');
    assert.ok(!fs.existsSync(paths[1]), 'the guide file is deleted when the run ends');

    // state.json: the file guide and the reply guide, cleaned; nothing hostile.
    state = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'state.json'), 'utf8'));
    assert.deepEqual(state.guides.guides.map(g => g.id).sort(), ['fromfile', 'inreply']);
    assert.ok(state.guides.version >= 1);
    assert.equal(state.guides.guides.find(g => g.id === 'inreply').steps[0].text, 'Walk cffff0000north r.');
    assert.ok(!JSON.stringify(state.guides).includes('DeleteCursorItem') && !JSON.stringify(state.guides).includes('run_macro'));

    // The slot file the game reads carries them with the version; the reply shows no block.
    const inbox = fs.readFileSync(cfg.inboxFile, 'utf8');
    const vm = luaVM();
    vm.run(inbox);
    assert.equal(vm.evaluate('WoWAI_Inbox.guides.version'), String(state.guides.version));
    assert.equal(vm.evaluate('#WoWAI_Inbox.guides.list'), '2');
    const text = vm.evaluate('WoWAI_Inbox.replies[1].text');
    assert.doesNotMatch(text, /wowguide|DeleteCursorItem|Walk/);
    assert.match(text, /Here is a short guide\./);
    assert.match(text, /I saved 2 guides\./);

    // The addon reads that same slot file back through WoWAI.lua's inbox path.
    vm.run(fs.readFileSync(path.join(ADDON, 'Guide.lua'), 'utf8'));
    assert.equal(vm.evaluate('WoWAIGuide.Sync(WoWAI_Inbox.guides)'), 'true');
    assert.equal(vm.evaluate('WoWAIGuide.Find("inreply").steps[1].points[1].m'), '1429');
  } finally {
    fs.rmSync(S, { recursive: true, force: true });
  }
});
