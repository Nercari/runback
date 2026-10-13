// Guide fits the player's log (backlog 76): Forever_Guide.lua in a Lua VM with the real
// Guide.lua, Runback.lua and the lockout module. Done and closed steps are skipped on
// load and by Next, the availability rules (requires, exclusive, rep, profession, level,
// faction) and their fail-open behaviour, the XP pace line and time per level.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');

// The stub character is a level 23 Alliance Night Elf Hunter. LOG holds { id, complete };
// FLAGGED[id] is a quest turned in before; REP[factionId] a standing; SKILL[name] a rank.
const WORLD = `
LOG, FLAGGED, REP, SKILL = {}, {}, { [72] = 4 }, { ["First Aid"] = 40 }
XP, XPMAX = 0, 6000
UnitXP = function() return XP end
UnitXPMax = function() return XPMAX end
C_QuestLog = {
  GetNumQuestLogEntries = function() return #LOG end,
  GetInfo = function(i) local q = LOG[i]; return q and { questID = q.id, isHeader = false, isComplete = q.complete } end,
  IsQuestFlaggedCompleted = function(id) return FLAGGED[id] == true end,
}
function GetFactionInfoByID(id) if REP[id] then return "Faction" .. id, "", REP[id] end end
local SKILLS = function()
  local list = { { "Professions", true, true } }
  for name, rank in pairs(SKILL) do list[#list + 1] = { name, false, false, rank } end
  return list
end
function GetNumSkillLines() return #SKILLS() end
function GetSkillLineInfo(i) local s = SKILLS()[i]; return s[1], s[2], s[3], s[4] end`;

const GUIDE = `{ id = "g", title = "G", steps = {
  { kind = "accept", text = "Take A.", questId = 101 },
  { kind = "turnin", text = "Hand in A.", questId = 101 },
  { kind = "accept", text = "Take B, after A.", questId = 102, requires = { 101 } },
  { kind = "accept", text = "Take C, unless D.", questId = 103, exclusive = { 104 } },
  { kind = "accept", text = "Take E at Friendly.", questId = 105, rep = { faction = 72, standing = 5 } },
  { kind = "accept", text = "Take F with First Aid 50.", questId = 106, profession = { name = "First Aid", skill = 50 } },
  { kind = "accept", text = "Take H, Horde only.", questId = 107, faction = "Horde" },
  { kind = "accept", text = "Take L at level 30.", questId = 108, level = { min = 30 } },
  { kind = "note", text = "The end." },
} }`;

function vm(setup = '') {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  run(WORLD);
  run(`RunbackGuideDB = { guides = { epoch = 1, version = 1, list = { ${GUIDE} } }, panel = { shown = true, guide = "g", step = { g = 1 } } }`);
  run(setup);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Guide.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Guide.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}
const rows = v => [2, 3, 4].map(i => v.get(`RunbackGuideFrame.children[${i}]:GetText()`));
const step = v => v.get('RunbackGuideDB.panel.step.g');
const pace = v => v.get('RunbackGuideFrame.pace:GetText()');
// The step text the panel shows as current after each Next, until it stops moving.
const walk = v => {
  const seen = [rows(v)[0]];
  for (let i = 0; i < 12; i++) {
    const before = step(v);
    v.run('RunbackGuideFrame.next.scripts.OnClick()');
    if (step(v) === before) break;
    seen.push(rows(v)[0]);
  }
  return seen;
};

test('metric: steps the log shows done or closed are never shown as current, on load or by Next', () => {
  const v = vm('FLAGGED[101] = true; FLAGGED[104] = true; LOG = { { id = 102 } }; REP[72] = 5');
  assert.equal(step(v), '5', 'on load the panel moves past A (turned in), B (in the log) and C (D turned in)');
  assert.deepEqual(walk(v), ['Take E at Friendly.', 'The end.'].map(t => (t.startsWith('Take') ? 'Accept: ' : 'Note: ') + t),
    'Next never lands on a done step or one the player cannot take: First Aid 40 < 50, Horde only, level 30');
  const manualSkips = walk(vm('FLAGGED[101] = true; FLAGGED[104] = true; LOG = { { id = 102 } }'))
    .filter(r => /\(done\)|Take [BCFHL]/.test(r)).length;
  assert.equal(manualSkips, 0);
});

test('a done step is skipped on load and the rows after the current step leave out done steps', () => {
  const v = vm('FLAGGED[101] = true');
  assert.equal(step(v), '3', 'A accepted and handed in: the panel opens on B');
  assert.deepEqual(rows(v), ['Accept: Take B, after A.', 'Accept: Take C, unless D.', 'Note: The end.']);
});

test('a step whose prerequisite is not turned in is skipped, and appears once it is', () => {
  const v = vm();
  assert.deepEqual(rows(v), ['Accept: Take A.', 'Turn in: Hand in A.', 'Accept: Take C, unless D.'], 'B waits for A');
  v.run('LOG = { { id = 101, complete = true } }; STUB.FireEvent("QUEST_ACCEPTED", 1, 101)');
  assert.equal(rows(v)[1], 'Accept: Take C, unless D.', 'A in the log is not A turned in');
  v.run('LOG = {}; FLAGGED[101] = true; STUB.FireEvent("QUEST_TURNED_IN", 101, 0, 0)');
  assert.equal(step(v), '3');
  assert.equal(rows(v)[0], 'Accept: Take B, after A.');
});

test('exclusive: any one of the listed quests turned in closes the step', () => {
  const v = vm('FLAGGED[101] = true; FLAGGED[102] = true');
  assert.equal(rows(v)[0], 'Accept: Take C, unless D.');
  v.run('FLAGGED[104] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(rows(v)[0], 'Note: The end.', 'C closed by D; E and F fail their rules');
});

test('rep and profession: hidden below the need, shown once the player reaches it', () => {
  const v = vm('FLAGGED[101] = true; FLAGGED[102] = true; FLAGGED[104] = true');
  assert.equal(rows(v)[0], 'Note: The end.');
  v.run('REP[72] = 5; SKILL["First Aid"] = 50; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.deepEqual(rows(v), ['Note: The end.'].concat(['', '']), 'the current step stays; earlier steps are not pulled back');
  v.run('SlashCmdList.RUNBACK("guide prev"); SlashCmdList.RUNBACK("guide prev")');
  assert.deepEqual(rows(v), ['Accept: Take E at Friendly.', 'Accept: Take F with First Aid 50.', 'Note: The end.']);
  v.run('SKILL = { Swords = 10 }; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(rows(v)[1], 'Note: The end.', 'a profession the player does not have is rank 0');
  v.run('LOG = { { id = 106 } }; STUB.FireEvent("QUEST_ACCEPTED", 1, 106)');
  assert.equal(v.get('RunbackGuidePanel.Visible({ questId = 106, profession = { name = "First Aid", skill = 50 } }, { quest = function() return 1 end, skill = function() return 0 end })'), 'true',
    'a quest already in the log is shown whatever the rules say');
});

test('level and faction filters: a Horde step and a level 30 step are skipped until they fit', () => {
  const v = vm('FLAGGED[101] = true; FLAGGED[102] = true; FLAGGED[104] = true; REP[72] = 8; SKILL["First Aid"] = 300; FLAGGED[105] = true; FLAGGED[106] = true');
  assert.equal(rows(v)[0], 'Note: The end.');
  const high = vm('STUB.level = 30; FLAGGED[101] = true; FLAGGED[102] = true; FLAGGED[104] = true; REP[72] = 8; SKILL["First Aid"] = 300; FLAGGED[105] = true; FLAGGED[106] = true');
  assert.deepEqual(rows(high), ['Accept: Take L at level 30.', 'Note: The end.', ''], 'the Horde step stays hidden for an Alliance character');
});

test('missing or broken APIs fail open: every rule step shows, nothing throws', () => {
  for (const setup of [
    'C_QuestLog = nil; IsQuestFlaggedCompleted = nil; GetFactionInfoByID = nil; GetNumSkillLines = nil; GetSkillLineInfo = nil',
    `C_QuestLog = { IsQuestFlaggedCompleted = function() return "maybe" end }; GetFactionInfoByID = function() error("boom") end
     GetNumSkillLines = function() return 0 end`,
    'FLAGGED[101] = true; GetSkillLineInfo = function(i) if i == 1 then return "Professions", true, false end return "Skinning", false, false, 10 end; GetNumSkillLines = function() return 2 end; REP = {}',
  ]) {
    const v = vm(`${setup}; RunbackGuideDB.panel.step.g = 3`);
    assert.equal(step(v), '3', setup);
    assert.deepEqual(rows(v), ['Accept: Take B, after A.', 'Accept: Take C, unless D.', 'Accept: Take E at Friendly.'], setup);
    v.run('SlashCmdList.RUNBACK("guide next"); SlashCmdList.RUNBACK("guide next")');
    assert.equal(rows(v)[1], 'Accept: Take F with First Aid 50.', `${setup}: unknown profession data shows the step`);
  }
});

test('pace line: shown after five minutes of XP readings, from the game XP values', () => {
  const v = vm();
  const xp = (now, value) => v.run(`STUB.now = ${now}; XP = ${value}; STUB.FireEvent("PLAYER_XP_UPDATE", "player")`);
  assert.equal(pace(v), '', 'no line before any XP is gained');
  xp(1120, 600);
  assert.equal(pace(v), '', 'two minutes of readings is not enough');
  xp(1300, 1500);
  assert.equal(pace(v), 'About 15 min to level, from your last 5 minutes', '1500 XP in 300 s since the login reading, 4500 to go: 900 s');
  xp(1600, 3000);
  assert.equal(pace(v), 'About 10 min to level, from your last 10 minutes', '3000 XP in 600 s, 3000 to go');
  xp(1900, 3000);
  assert.equal(pace(v), 'About 20 min to level, from your last 10 minutes', 'readings older than ten minutes are dropped: 1500 XP in 600 s');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.now = 1950; XP = 3100; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  assert.equal(v.get('RunbackGuideFrame:IsShown()'), 'false', 'no guide text, pace line included, during a fight');
});

test('pace across a level up, and time per level kept per character for the recap', () => {
  const v = vm();
  v.run('STUB.now = 1300; XP = 5400; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  v.run('STUB.now = 1600; STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24); XP = 600; XPMAX = 7000; STUB.FireEvent("PLAYER_XP_UPDATE", "player")');
  assert.equal(pace(v), 'About 10 min to level, from your last 10 minutes', '5400 + 600 + 600 XP across the level up in 600 s, 6400 to go: 582 s');
  v.run('STUB.now = 2800; STUB.level = 25; STUB.FireEvent("PLAYER_LEVEL_UP", 25)');
  v.run('STUB.now = 3100; STUB.FireEvent("PLAYER_LOGOUT")');
  const rec = 'RunbackGuideDB.levels["Testchar-Test Realm"]';
  assert.equal(v.get(`${rec}[23].sec`), '600', 'level 23 counted from login to the level up');
  assert.equal(v.get(`${rec}[23].at`), 'nil', 'reached before the addon saw it');
  assert.equal(v.get(`${rec}[24].sec`), '1200');
  assert.equal(v.get(`${rec}[24].at`), String(1700000000 + 1600));
  assert.equal(v.get(`${rec}[25].sec`), '300', 'logout adds the time since the last event');
  assert.equal(v.get('RunbackGuidePanel.LevelMinutes()'), 'levelMinutes=24:20,25:5');
  v.run('Runback.IsConnected = function() return true end; RunbackDB.outbox = nil; Runback.Send("recap", nil, { cmd = "recap" })');
  const ctx = Buffer.from(v.get('RunbackDB.outbox.ctx'), 'hex').toString();
  assert.match(ctx, /(^|\n)levelMinutes=24:20,25:5(\n|$)/, 'the recap carries the minutes per level');
  v.run('RunbackDB.outbox = nil; for _, c in ipairs(RunbackDB.chats) do c.pendingId = nil end; Runback.Send("hello there")');
  assert.doesNotMatch(Buffer.from(v.get('RunbackDB.outbox.ctx or ""'), 'hex').toString(), /levelMinutes=/);
});
