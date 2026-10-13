// Guide panel (backlog 69): Forever_Guide.lua in a Lua VM with the real Guide.lua,
// Runback.lua and the lockout module. Step window, Previous / Next, the picker,
// combat hide and restore, and /runback guide parsing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm() {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    const status = lua.lua_pcall(L, 0, 0, 0);
    if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Guide.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Guide.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}

// Steps s1..sN; step 3 is Horde only and step 5 is for Mages, so a level 23
// Alliance Night Elf Hunter (the stub's character) sees 1, 2, 4, 6, ...
const steps = n => Array.from({ length: n }, (_, i) => {
  const extra = i === 2 ? ', faction = "Horde"' : i === 4 ? ', class = { "Mage" }' : '';
  return `{ kind = "do", text = "s${i + 1}"${extra} }`;
}).join(', ');
const seed = v => v.run(`RunbackGuide.Sync({ epoch = 1, version = 1, list = {
  { id = "a", title = "Guide A", steps = { ${steps(8)} } },
  { id = "b", title = "Guide B", steps = { { kind = "accept", text = "Talk to the officer.", quest = "Sample Task" }, { kind = "turnin", text = "b2" } } },
} })`);
// What the frame shows: children are the header, the three step rows, then the buttons.
const rows = v => [2, 3, 4].map(i => v.get(`RunbackGuideFrame.children[${i}]:GetText()`));
const header = v => v.get('RunbackGuideFrame.children[1]:GetText()');
const shown = v => v.get('RunbackGuideFrame ~= nil and RunbackGuideFrame:IsShown()');

test('step window: current plus the next two, filtered for the character, clamped at both ends', () => {
  const v = vm();
  v.run('W = RunbackGuidePanel; ORDER = { 1, 2, 4, 6, 7 }');
  assert.equal(v.get('table.concat(W.Window(ORDER, 1, 3), ",")'), '1,2,4');
  assert.equal(v.get('table.concat(W.Window(ORDER, 3, 3), ",")'), '4,6,7', 'a hidden step moves to the next one shown');
  assert.equal(v.get('table.concat(W.Window(ORDER, 7, 3), ",")'), '7', 'last step alone at the end');
  assert.equal(v.get('table.concat(W.Window(ORDER, 99, 3), ",")'), '7', 'past the end clamps to the last');
  assert.equal(v.get('select(2, W.Window(ORDER, 6, 3)) .. "/" .. select(3, W.Window(ORDER, 6, 3))'), '4/5');
  assert.equal(v.get('#W.Window({}, 1, 3)'), '0');
  assert.equal(v.get('W.Move(ORDER, 1, -1)'), '1', 'Previous stops at the first step');
  assert.equal(v.get('W.Move(ORDER, 2, 1)'), '4', 'Next skips a step the character cannot see');
  assert.equal(v.get('W.Move(ORDER, 7, 1)'), '7', 'Next stops at the last step');
  const who = '{ level = 23, class = "Hunter", classToken = "HUNTER", race = "Night Elf", raceToken = "NightElf", faction = "Alliance" }';
  assert.equal(v.get(`W.Visible({ level = { min = 30 } }, ${who})`), 'false');
  assert.equal(v.get(`W.Visible({ level = { max = 23 } }, ${who})`), 'true');
  assert.equal(v.get(`W.Visible({ race = { "Night Elf" } }, ${who})`), 'true');
  assert.equal(v.get(`W.Visible({ class = { "hunter", "Mage" } }, ${who})`), 'true');
  assert.equal(v.get(`W.Visible({ faction = "Horde" }, ${who})`), 'false');
});

test('panel: hidden until asked, shows three steps, Next and Previous buttons move and persist', () => {
  const v = vm();
  seed(v);
  assert.equal(shown(v), 'false', 'nothing shows until the player asks');
  v.run('SlashCmdList.RUNBACK("guide")');
  assert.equal(shown(v), 'true');
  assert.equal(v.get('RunbackGuideDB.panel.guide'), 'b', 'the newest guide until one is picked');
  v.run('SlashCmdList.RUNBACK("guide pick a")');
  assert.match(header(v), /^Guide A {2}1\/6$/);
  assert.deepEqual(rows(v), ['Do: s1', 'Do: s2', 'Do: s4']);
  v.run('RunbackGuideFrame.next.scripts.OnClick(); RunbackGuideFrame.next.scripts.OnClick()');
  assert.deepEqual(rows(v), ['Do: s4', 'Do: s6', 'Do: s7']);
  assert.equal(v.get('RunbackGuideDB.panel.step.a'), '4', 'the step is saved per guide');
  v.run('for i = 1, 10 do SlashCmdList.RUNBACK("guide next") end');
  assert.deepEqual(rows(v), ['Do: s8', '', ''], 'clamped at the last step');
  v.run('RunbackGuideFrame.prev.scripts.OnClick()');
  assert.equal(v.get('RunbackGuideDB.panel.step.a'), '7');
  v.run('SlashCmdList.RUNBACK("guide back")');
  assert.equal(v.get('RunbackGuideDB.panel.step.a'), '6');
  assert.equal(v.get('RunbackGuideFrame.next:GetText()'), 'Next');
  // The hide button and the hide command both remember the choice.
  v.run('SlashCmdList.RUNBACK("guide hide")');
  assert.equal(shown(v), 'false');
  assert.equal(v.get('RunbackGuideDB.panel.shown'), 'false');
});

test('picker: the button cycles guides, pick takes a number, list prints them, each guide keeps its step', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show"); SlashCmdList.RUNBACK("guide pick 1"); SlashCmdList.RUNBACK("guide next")');
  assert.equal(v.get('RunbackGuideDB.panel.step.a'), '2');
  v.run('RunbackGuideFrame.children[#RunbackGuideFrame.children].scripts.OnClick()');
  assert.equal(v.get('RunbackGuideDB.panel.guide'), 'b', 'picker moves to the next guide');
  assert.deepEqual(rows(v), ['Accept: Talk to the officer. (Sample Task)', 'Turn in: b2', '']);
  v.run('RunbackGuideFrame.children[#RunbackGuideFrame.children].scripts.OnClick()');
  assert.equal(v.get('RunbackGuideDB.panel.guide'), 'a', 'and wraps round');
  assert.deepEqual(rows(v), ['Do: s2', 'Do: s4', 'Do: s6'], 'back where the player left guide A');
  v.run('STUB.prints = {}; SlashCmdList.RUNBACK("guide pick zz")');
  assert.match(v.get('table.concat(STUB.prints, "\\n")'), /No guide zz/);
  v.run('STUB.prints = {}; SlashCmdList.RUNBACK("guide list")');
  const list = v.get('table.concat(STUB.prints, "\\n")');
  assert.match(list, /1\. Guide A \(a, 8 steps\) {2}\(current\)/);
  assert.match(list, /2\. Guide B \(b, 2 steps\)/);
});

test('combat: the panel hides at combat start and comes back after; commands show nothing mid-fight', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show")');
  assert.equal(shown(v), 'true');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(shown(v), 'false', 'no guide text during a fight');
  v.run('STUB.prints = {}; SlashCmdList.RUNBACK("guide list"); SlashCmdList.RUNBACK("guide next"); SlashCmdList.RUNBACK("guide show")');
  assert.equal(shown(v), 'false');
  assert.equal(v.get('RunbackGuideDB.panel.step.b'), 'nil', 'Next does nothing in combat');
  assert.equal(v.get('table.concat(STUB.prints, "\\n")').includes('Guide A'), false, 'no guide titles printed in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(v), 'true', 'back after the fight');
  // A guide that arrives mid-fight does not open the panel.
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); RunbackGuide.Sync({ epoch = 1, version = 2, list = { { id = "c", steps = { { kind = "note", text = "new" } } } } })');
  assert.equal(shown(v), 'false');
  // Hidden by the player in combat stays hidden after.
  v.run('SlashCmdList.RUNBACK("guide hide"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(v), 'false');
});

test('/runback guide parsing: subcommands run, anything else goes to the agent as a message', () => {
  const v = vm();
  const parse = rest => v.get(`table.concat({ RunbackGuidePanel.Parse(${JSON.stringify(rest)}) }, "|")`);
  assert.equal(parse(''), 'toggle|');
  assert.equal(parse('Next'), 'next|');
  assert.equal(parse('previous'), 'prev|');
  assert.equal(parse('pick 2'), 'pick|2');
  assert.equal(parse('pick'), '');
  assert.equal(parse('me to Goldshire'), '');
  assert.equal(parse('next steps please'), '');
  v.run('SlashCmdList.RUNBACK("guide me to Goldshire")');
  // Not connected in the stub, so Runback.Send leaves it in the box to send on connect.
  assert.ok(v.get('table.concat(STUB.texts, "\\n")').split('\n').includes('guide me to Goldshire'), 'handed to Runback.Send as a message');
  assert.equal(v.get('RunbackGuideDB and RunbackGuideDB.panel and RunbackGuideDB.panel.shown'), 'nil', 'not run as a command');
});

test('empty and hostile data: no guide shows a hint, escape codes are shown as text', () => {
  const v = vm();
  v.run('SlashCmdList.RUNBACK("guide show")');
  assert.equal(shown(v), 'true');
  assert.match(rows(v)[0], /No guide yet/);
  v.run('RunbackGuide.Sync({ epoch = 1, version = 1, list = { { id = "h", title = "|cffff0000Red", steps = { { kind = "do", text = "|Hitem:1|h[x]|h" } } } } })');
  assert.equal(rows(v)[0], 'Do: ||Hitem:1||h[x]||h');
  assert.match(header(v), /^\|\|cffff0000Red/);
});

// Explain this step (backlog 75): the Why? buttons are children 5 to 7, one per step row.
const why = (v, row) => `RunbackGuideFrame.children[${4 + row}]`;
const typed = v => v.get('table.concat(STUB.texts, "|")');

test('Why? button: types the question, the step and its quest name in the box, sends nothing', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show")');
  assert.deepEqual(rows(v), ['Accept: Talk to the officer. (Sample Task)', 'Turn in: b2', '']);
  assert.equal(v.get(`${why(v, 1)}:IsShown()`), 'true');
  assert.equal(v.get(`${why(v, 2)}:IsShown()`), 'true');
  assert.equal(v.get(`${why(v, 3)}:IsShown()`), 'false', 'no button on an empty row');
  assert.equal(v.get(`${why(v, 1)}:GetText()`), 'Why?');
  v.run(`${why(v, 1)}.scripts.OnClick(${why(v, 1)})`);
  assert.equal(v.get('RunbackFrame.shown'), 'true', 'the chat window opens');
  assert.ok(typed(v).includes('Why this step, and what do I need? Guide step: "Accept: Talk to the officer." Quest: "Sample Task".'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
  // The second row explains its own step, and a step with no quest has no quest part.
  v.run(`${why(v, 2)}.scripts.OnClick(${why(v, 2)})`);
  assert.ok(typed(v).includes('Why this step, and what do I need? Guide step: "Turn in: b2".'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil');
});

test('Why? button: does nothing in combat, and strips quotes and escape codes from guide text', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show"); SlashCmdList.RUNBACK("guide pick a")');
  v.run(`STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.texts = {}; ${why(v, 1)}.scripts.OnClick(${why(v, 1)})`);
  assert.equal(typed(v).includes('Why this step'), false, 'nothing typed in combat');
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'nothing sent in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  v.run(`${why(v, 1)}.scripts.OnClick(${why(v, 1)})`);
  assert.ok(typed(v).includes('Why this step, and what do I need? Guide step: "Do: s1".'), 'works after the fight');
  assert.equal(v.get('RunbackGuidePanel.Question({ kind = "note", text = "Say \\"hi\\" |cffff0000now|r", quest = "A\\nB" })'),
    'Why this step, and what do I need? Guide step: "Note: Say hi cffff0000nowr" Quest: "AB".');
});

// Re-plan from here (backlog 73): one header button, created before the picker.
const replan = 'RunbackGuideFrame.children[#RunbackGuideFrame.children - 1]';

test('Re-plan button: types the request with the guide, current step and done count, sends nothing', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show"); SlashCmdList.RUNBACK("guide pick b")');
  assert.equal(v.get(`${replan}:GetText()`), 'Re-plan');
  v.run(`${replan}.scripts.OnClick(${replan})`);
  assert.equal(v.get('RunbackFrame.shown'), 'true', 'the chat window opens');
  assert.ok(typed(v).includes('Re-plan my leveling guide from here: I skipped steps or took another route. Use my level, zone and quest log from the game context and write a new guide for what comes next, under a new id. Current guide: "Guide B" (b). Current step: "Accept: Talk to the officer.". Steps done: 0 of 2.'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
  // After a step is ticked by hand the question moves on and counts it.
  v.run('SlashCmdList.RUNBACK("guide tick"); STUB.texts = {}');
  v.run(`${replan}.scripts.OnClick(${replan})`);
  assert.ok(typed(v).includes('Current step: "Turn in: b2". Steps done: 1 of 2.'));
});

test('Re-plan button: does nothing in combat, asks for a new guide when none is loaded, strips escape codes', () => {
  const v = vm();
  seed(v);
  v.run('SlashCmdList.RUNBACK("guide show")');
  v.run(`STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.texts = {}; ${replan}.scripts.OnClick(${replan})`);
  assert.equal(typed(v).includes('Re-plan'), false, 'nothing typed in combat');
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  v.run('RunbackGuide.Sync({ epoch = 3, version = 1, list = {} })');
  v.run(`${replan}.scripts.OnClick(${replan})`);
  assert.ok(typed(v).includes('Make me a leveling guide from here. Use my level, zone and quest log from the game context.'));
  v.run('RunbackGuide.Sync({ epoch = 2, version = 1, list = { { id = "x|y", title = "Say \\"hi\\" |cffff0000now|r", steps = { { kind = "note", text = "Go" } } } } })');
  assert.ok(v.get('RunbackGuidePanel.ReplanQuestion()').includes('Current guide: "Say hi cffff0000nowr" (xy).'));
});
