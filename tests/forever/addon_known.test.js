'use strict';
// Backlog 60 (watched quests and shared map pins) and 61 (spellbook with ranks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
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
  run(`C_Map.GetMapInfo = function(id) if id == 1420 then return { name = "Tirisfal Glades", mapID = id } end end`);
  run(setup);
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua', 'Forever_Known.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('Runback.IsConnected = function() return true end');
  return { run, get };
}
const outbox = v => ({
  cmd: v.get('RunbackDB.outbox and RunbackDB.outbox.cmd'),
  text: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.text or ""'), 'hex').toString(),
  ctx: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.ctx or ""'), 'hex').toString(),
});
const type = (v, text) => { v.run(`RunbackInput:SetText(${JSON.stringify(text)}); Runback.SendFromInput()`); return outbox(v); };

const CLASSIC_QUESTS = `
  local LOG = {
    [3] = { "Wanted: Maggot Eye", 398, { { "Maggot Eye's Paw: 0/1" } } },
    [5] = { "The Mills Overrun", 426, { { "Scarlet Initiate slain: 10/10", 1 }, { "Scarlet Convert slain: 4/10" } } },
  }
  function GetNumQuestWatches() return 2 end
  function GetQuestIndexForWatch(i) return ({ 3, 5 })[i] end
  function GetQuestLogTitle(i) local q = LOG[i]; return q[1], 10, nil, false, nil, nil, nil, q[2] end
  function GetNumQuestLeaderBoards(i) return #LOG[i][3] end
  function GetQuestLogLeaderBoard(j, i) local o = LOG[i][3][j]; return o[1], "monster", o[2] end`;

const WARLOCK_BOOK = `
  BOOK = {
    { "General", { { "Attack" }, { "Will of the Forsaken" } } },
    { "Affliction", { { "Corruption", "Rank 1" }, { "Corruption", "Rank 2" }, { "Life Tap", "Rank 1" }, { "Curse of Agony", "Rank 2" }, { "Curse of Agony", "Rank 1" } } },
    { "Destruction", { { "Shadow Bolt", "Rank 3" }, { "Immolate", "Rank 2" }, { "Searing Pain", "Rank 1", "FUTURESPELL" } } },
  }
  local flat, tabs = {}, {}
  for t, tab in ipairs(BOOK) do
    tabs[t] = { tab[1], #flat }
    for _, s in ipairs(tab[2]) do flat[#flat + 1] = s end
    tabs[t][3] = #flat - tabs[t][2]
  end
  function GetNumSpellTabs() return #tabs end
  function GetSpellTabInfo(t) return tabs[t][1], "icon", tabs[t][2], tabs[t][3] end
  function GetSpellBookItemInfo(i, book) return flat[i][3] or "SPELL", 1000 + i end
  function GetSpellBookItemName(i, book) return flat[i][1], flat[i][2] or "" end`;

test('every message lists the watched quests with their objectives (classic quest API)', () => {
  const v = vm(CLASSIC_QUESTS);
  const sent = type(v, 'where do I go next?');
  assert.ok(sent.ctx.includes(
    "Watched quests: [398] Wanted: Maggot Eye - Maggot Eye's Paw: 0/1; " +
    '[426] The Mills Overrun - Scarlet Initiate slain: 10/10 (done), Scarlet Convert slain: 4/10'), sent.ctx);
});

test('watched quests through C_QuestLog when the client has the modern API', () => {
  const v = vm(`
    C_QuestLog = {
      GetNumQuestWatches = function() return 1 end,
      GetQuestIDForQuestWatchIndex = function(i) return 376 end,
      GetTitleForQuestID = function(id) return "The Damned" end,
      GetQuestObjectives = function(id) return { { text = "Scavenger Paw: 6/6", finished = true }, { text = "Duskbat Wing: 2/6", finished = false } } end,
    }`);
  assert.ok(type(v, 'hi').ctx.includes('Watched quests: [376] The Damned - Scavenger Paw: 6/6 (done), Duskbat Wing: 2/6'));
});

test('watched quests: capped at 5 quests and 290 characters', () => {
  const v = vm(`
    function GetNumQuestWatches() return 25 end
    function GetQuestIndexForWatch(i) return i end
    function GetQuestLogTitle(i) return "Quest number " .. i, 10, nil, false, nil, nil, nil, 100 + i end
    function GetNumQuestLeaderBoards(i) return 9 end
    function GetQuestLogLeaderBoard(j, i) return string.rep("x", 80) .. ": 0/1", "item", nil end`);
  const line = type(v, 'hi').ctx.split('\n').find(l => l.startsWith('Watched quests:'));
  assert.equal(line.length, 290);
  assert.ok(!line.includes('[106]'));
});

test('no quest-watch API: the line is left out and the message still goes', () => {
  const v = vm('GetNumQuestWatches = nil; GetQuestIndexForWatch = nil; C_QuestLog = nil');
  const sent = type(v, 'hi');
  assert.equal(sent.text, 'hi');
  assert.ok(!sent.ctx.includes('Watched quests'));
  assert.ok(sent.ctx.includes('Character: Testchar'));
});

test('a shared /mappin gets its map name, the coordinates exactly as typed', () => {
  const v = vm();
  assert.equal(type(v, 'what is at /mappin 1420 9.7 63.9 ?').text, 'what is at /mappin 1420 9.7 63.9 (Tirisfal Glades 9.7, 63.9) ?');
  assert.equal(v.get('Runback.DecodePins("/way #1420 9.70, 63.90")'), '/way #1420 9.70, 63.90 (Tirisfal Glades 9.70, 63.90)');
});

test('a pasted pin line on its own is sent with its map name, not refused as a command', () => {
  assert.equal(type(vm(), '/mappin 1420 9.7 63.9').text, '/mappin 1420 9.7 63.9 (Tirisfal Glades 9.7, 63.9)');
  const v = vm();
  assert.equal(type(v, '/way #1420 9.7 63.9').text, '/way #1420 9.7 63.9 (Tirisfal Glades 9.7, 63.9)');
  // A bare /mappin with no coordinates is still an unknown box command and sends nothing new.
  const before = v.get('#RunbackDB.chats[1].history');
  v.run('RunbackInput:SetText("/mappin"); Runback.SendFromInput()');
  assert.ok(v.get('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').startsWith('Unknown command /mappin'));
  assert.equal(Number(v.get('#RunbackDB.chats[1].history')), Number(before) + 1);
});

test('a shared pin on an unknown map, or with no C_Map, stays as typed', () => {
  let v = vm();
  assert.equal(type(v, 'go to /mappin 99999 9.7 63.9').text, 'go to /mappin 99999 9.7 63.9');
  v = vm('C_Map = nil');
  assert.equal(type(v, 'go to /mappin 1420 9.7 63.9').text, 'go to /mappin 1420 9.7 63.9');
  v = vm('C_Map.GetMapInfo = function() error("no such map") end');
  assert.equal(type(v, 'go to /mappin 1420 9.7 63.9').text, 'go to /mappin 1420 9.7 63.9');
});

test('a shift-clicked map pin link names the map and the coordinates', () => {
  const v = vm();
  const sent = type(v, 'what is here |cffffff00|Hworldmap:1420:970:6390|h[Map Pin Location]|h|r');
  assert.ok(sent.text.startsWith('what is here [Map Pin Location]'));
  assert.ok(sent.text.includes('[Map Pin Location] map pin Tirisfal Glades 9.7, 63.9'), sent.text);
});

const SPELLBOOK = 'Spellbook (highest rank known): General: Attack, Will of the Forsaken; ' +
  'Affliction: Corruption 2, Life Tap 1, Curse of Agony 2; Destruction: Shadow Bolt 3, Immolate 2';
const spellbookOf = ctx => ctx.split('\n').find(l => l.startsWith('Spellbook')) || null;

test('rotation and build questions carry the spellbook with ranks', () => {
  for (const question of ['What is my rotation?', 'which talent build for leveling', 'Should I cast Life Tap more?']) {
    const v = vm(WARLOCK_BOOK);
    assert.equal(spellbookOf(type(v, question).ctx), SPELLBOOK, question);
  }
});

test('the build command and a review carry the spellbook too', () => {
  let v = vm(WARLOCK_BOOK);
  v.run('SlashCmdList["RUNBACK"]("build")');
  assert.equal(outbox(v).cmd, 'build');
  assert.equal(spellbookOf(outbox(v).ctx), SPELLBOOK);

  v = vm(WARLOCK_BOOK);
  v.run('SlashCmdList["RUNBACK"]("review")');
  assert.equal(outbox(v).cmd, 'review');
  assert.equal(spellbookOf(outbox(v).ctx), SPELLBOOK);
});

test('unrelated chat carries no spellbook, and a spells question is not cached as the base context', () => {
  const v = vm(WARLOCK_BOOK);
  assert.equal(spellbookOf(type(v, 'where do I turn in this quest?').ctx), null);
  assert.equal(spellbookOf(type(v, 'thanks, see you later').ctx), null, 'one plain message after another');
});

test('a big spellbook is cut with a count of what was left out', () => {
  const v = vm(`
    function GetNumSpellTabs() return 1 end
    function GetSpellTabInfo(t) return "Arcane", "icon", 0, 200 end
    function GetSpellBookItemName(i) return "Spell number " .. i, "Rank 1" end`);
  const line = spellbookOf(type(v, 'rotation please').ctx);
  assert.ok(line.length <= 680, String(line.length));
  assert.match(line, / \+\d+ more$/);
  const shown = line.split(', ').length;
  assert.equal(Number(line.match(/\+(\d+) more$/)[1]), 200 - shown);
});

test('no spellbook API: a rotation question goes without the line', () => {
  const v = vm('GetNumSpellTabs = nil; C_SpellBook = nil');
  const sent = type(v, 'what is my rotation?');
  assert.equal(sent.text, 'what is my rotation?');
  assert.equal(spellbookOf(sent.ctx), null);
  assert.ok(sent.ctx.includes('Character: Testchar'));
});
