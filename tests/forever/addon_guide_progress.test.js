// Guide progress from the quest log (backlog 70): Forever_Guide.lua in a Lua VM with
// the real Guide.lua, WoWAI.lua and the lockout module, and a fake quest log. Each
// step kind ticks off from the log, the late-objective retry, the hand tick that
// wins over the log, the classic API fallback and a hostile or missing API.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');

// LOG holds { id, complete, objectives }; FLAGGED[id] marks a quest turned in before.
const FAKE_LOG = `
LOG, FLAGGED = {}, {}
local function find(id) for _, q in ipairs(LOG) do if q.id == id then return q end end end
C_QuestLog = {
  GetNumQuestLogEntries = function() return #LOG end,
  GetInfo = function(i) local q = LOG[i]; return q and { questID = q.id, title = "Q" .. q.id, isHeader = false, isComplete = q.complete } end,
  GetQuestObjectives = function(id) local q = find(id); return q and q.objectives end,
  IsQuestFlaggedCompleted = function(id) return FLAGGED[id] == true end,
}`;

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
  run(FAKE_LOG);
  for (const file of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Guide.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Guide.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}

// The stub character is level 23. Step 4 shows from level 24 and has no quest.
const seed = v => {
  v.run(`WoWAIGuide.Sync({ epoch = 1, version = 1, list = { { id = "g", title = "G", steps = {
    { kind = "accept", text = "Take the task.", quest = "Task", questId = 101 },
    { kind = "do", text = "Do the task.", questId = 101 },
    { kind = "turnin", text = "Hand it in.", questId = 101 },
    { kind = "train", text = "Visit your trainer.", level = { min = 24 } },
    { kind = "accept", text = "Take the next one.", questId = 102 },
    { kind = "note", text = "The end." },
  } } } })`);
  v.run('SlashCmdList.WOWAI("guide show")');
};
const rows = v => [2, 3, 4].map(i => v.get(`WoWAIGuideFrame.children[${i}]:GetText()`));
const step = v => v.get('WoWAIGuideDB.panel.step.g');
const tickLabel = v => v.get('WoWAIGuideFrame.tick:GetText()');
const objectives = done => `{ { text = "Rats: 3/3", finished = true }, { text = "Wolves", finished = ${done} } }`;

test('each step kind ticks off from the log and the panel moves on', () => {
  const v = vm();
  seed(v);
  assert.deepEqual(rows(v), ['Accept: Take the task. (Task)', 'Do: Do the task.', 'Turn in: Hand it in.']);
  assert.equal(tickLabel(v), 'Tick');

  v.run(`LOG = { { id = 101, objectives = ${objectives(false)} } }; STUB.FireEvent("QUEST_ACCEPTED", 1, 101)`);
  assert.equal(step(v), '2', 'accept: the quest is in the log');
  assert.deepEqual(rows(v), ['Do: Do the task.', 'Turn in: Hand it in.', 'Accept: Take the next one.']);

  v.run(`LOG[1].objectives = ${objectives(true)}; STUB.FireEvent("QUEST_WATCH_UPDATE", 1)`);
  assert.equal(step(v), '3', 'do: every objective finished');

  v.run('LOG = {}; STUB.FireEvent("QUEST_TURNED_IN", 101, 0, 0); STUB.FireEvent("QUEST_REMOVED", 101)');
  assert.equal(step(v), '5', 'turnin: QUEST_TURNED_IN for that id, the hidden level 24 step skipped');
  v.run('SlashCmdList.WOWAI("guide prev"); SlashCmdList.WOWAI("guide prev")');
  assert.deepEqual(rows(v), ['Do: Do the task. (done)', 'Turn in: Hand it in. (done)', 'Accept: Take the next one.']);
  assert.equal(tickLabel(v), 'Untick');

  v.run('FLAGGED[102] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(step(v), '2', 'Previous onto a done step stays there when the log updates');
  assert.equal(v.get('WoWAIGuidePanel.Snapshot()(102)'), '3', 'turnin: IsQuestFlaggedCompleted counts as turned in');
  assert.equal(v.get('WoWAIGuidePanel.Snapshot()(999)'), '0');
});

test('a step with only a level filter shows on level up and is ticked by hand', () => {
  const v = vm();
  seed(v);
  v.run('LOG = { { id = 101, complete = true } }; FLAGGED[101] = true; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(step(v), '5', 'quest 101 done, the level 24 step is still hidden');
  v.run('WoWAIGuideDB.panel.step.g = 4; STUB.level = 24; STUB.FireEvent("PLAYER_LEVEL_UP", 24)');
  assert.deepEqual(rows(v), ['Train: Visit your trainer.', 'Accept: Take the next one.', 'Note: The end.']);
  assert.equal(step(v), '4', 'reaching the level shows the step; it does not tick it');
  v.run('WoWAIGuideFrame.tick.scripts.OnClick()');
  assert.equal(step(v), '5', 'the Tick button ticks it and moves on');
  v.run('SlashCmdList.WOWAI("guide prev")');
  assert.equal(rows(v)[0], 'Train: Visit your trainer. (done)');
});

test('late objective data: the retry a second later ticks the step', () => {
  const v = vm();
  seed(v);
  v.run(`LOG = { { id = 101, objectives = ${objectives(false)} } }; STUB.FireEvent("QUEST_LOG_UPDATE"); STUB.RunTimers()`);
  assert.equal(step(v), '2');
  v.run('STUB.FireEvent("QUEST_LOG_UPDATE"); STUB.FireEvent("QUEST_WATCH_UPDATE", 1)');
  assert.equal(v.get('#STUB.timers'), '1', 'one retry queued however many events arrive');
  v.run(`LOG[1].objectives = ${objectives(true)}`);
  assert.equal(step(v), '2', 'nothing moves before the retry');
  v.run('STUB.RunTimers()');
  assert.equal(step(v), '3', 'the retry reads the objectives that arrived late');
});

test('a hand untick wins over the log until the quest state changes', () => {
  const v = vm();
  seed(v);
  v.run('LOG = { { id = 101 } }; STUB.FireEvent("QUEST_ACCEPTED", 1, 101)');
  assert.equal(step(v), '2');
  v.run('SlashCmdList.WOWAI("guide prev")');
  assert.equal(tickLabel(v), 'Untick');
  v.run('WoWAIGuideFrame.tick.scripts.OnClick()');
  assert.equal(rows(v)[0], 'Accept: Take the task. (Task)', 'unticked by hand');
  v.run('for i = 1, 3 do STUB.FireEvent("QUEST_LOG_UPDATE"); STUB.RunTimers() end');
  assert.equal(step(v), '1', 'log updates with the quest in the same state leave it unticked');
  assert.equal(rows(v)[0], 'Accept: Take the task. (Task)');
  v.run(`LOG[1].objectives = ${objectives(true)}; STUB.FireEvent("QUEST_WATCH_UPDATE", 1)`);
  assert.equal(step(v), '3', 'the quest moved on, so the log decides again: accept and do are both done');
  v.run('SlashCmdList.WOWAI("guide tick")');
  assert.equal(step(v), '5', 'the tick command ticks the current step by hand and moves on');
  v.run('SlashCmdList.WOWAI("guide prev"); SlashCmdList.WOWAI("guide tick")');
  assert.equal(rows(v)[0], 'Turn in: Hand it in.', 'a hand tick can be taken back');
});

test('classic quest log API when C_QuestLog is missing', () => {
  const v = vm();
  v.run(`C_QuestLog = nil; CLASSIC = { done = 0 }
    function GetNumQuestLogEntries() return 2 end
    function GetQuestLogTitle(i)
      if i == 1 then return "Zone", 0, nil, true end
      return "Task", 1, nil, false, false, nil, nil, 101
    end
    function GetNumQuestLeaderBoards(i) return 2 end
    function GetQuestLogLeaderBoard(j, i) return "obj", "monster", j <= CLASSIC.done end
    function IsQuestFlaggedCompleted(id) return id == 102 end`);
  seed(v);
  v.run('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(step(v), '2', 'GetQuestLogTitle finds the quest; the header row is skipped');
  v.run('CLASSIC.done = 1; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(step(v), '2', 'one objective of two is not done');
  v.run('CLASSIC.done = 2; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(step(v), '3', 'every leaderboard line finished');
  assert.equal(v.get('WoWAIGuidePanel.Snapshot()(102)'), '3', 'global IsQuestFlaggedCompleted');
});

test('hostile or missing quest API: nothing ticks, nothing throws, the hand tick still works', () => {
  for (const setup of [
    'C_QuestLog = nil; IsQuestFlaggedCompleted = nil',
    `C_QuestLog = { GetNumQuestLogEntries = function() error("boom") end, IsQuestFlaggedCompleted = function() error("boom") end }
     function GetNumQuestLogEntries() return "lots" end`,
    `C_QuestLog = { GetNumQuestLogEntries = function() return 1e9 end, GetInfo = function(i) return i == 1 and "x" or { questID = "|Hquest|h", isHeader = false } end,
       GetQuestObjectives = function() return { 1, false } end, IsQuestFlaggedCompleted = function() return "yes" end }`,
  ]) {
    const v = vm();
    v.run(setup);
    seed(v);
    for (const ev of ['QUEST_ACCEPTED', 'QUEST_TURNED_IN', 'QUEST_REMOVED', 'QUEST_WATCH_UPDATE', 'QUEST_LOG_UPDATE', 'PLAYER_LEVEL_UP']) v.run(`STUB.FireEvent("${ev}", "|cffff0000"); STUB.RunTimers()`);
    assert.equal(step(v), 'nil', setup);
    assert.deepEqual(rows(v), ['Accept: Take the task. (Task)', 'Do: Do the task.', 'Turn in: Hand it in.'], setup);
    v.run('WoWAIGuideFrame.tick.scripts.OnClick()');
    assert.equal(step(v), '2', setup);
  }
});

test('combat: the log still ticks steps but the panel stays hidden until the fight ends', () => {
  const v = vm();
  seed(v);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  v.run('LOG = { { id = 101 } }; STUB.FireEvent("QUEST_ACCEPTED", 1, 101); STUB.RunTimers()');
  assert.equal(v.get('WoWAIGuideFrame:IsShown()'), 'false', 'no guide text during a fight');
  v.run('SlashCmdList.WOWAI("guide tick")');
  assert.equal(step(v), '2', 'the tick command does nothing mid-fight');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(v.get('WoWAIGuideFrame:IsShown()'), 'true');
  assert.equal(rows(v)[0], 'Do: Do the task.');
});
