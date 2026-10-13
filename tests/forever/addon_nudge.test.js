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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Nudge.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}
const prints = v => v.get('table.concat(STUB.prints, "\\n")');

test('level-up nudge: one chat line out of combat, the link fills the box and sends nothing', () => {
  const v = vm();
  v.run('STUB.FireEvent("PLAYER_LEVEL_UP", 12)');
  assert.ok(prints(v).includes('Level 12!'));
  assert.ok(prints(v).includes('|Hrunback:ask:'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'nothing was sent');

  // Clicking the link opens the window with the question typed, still unsent.
  v.run('SetItemRef("runback:ask:" .. RunbackDB.chats[1].id)');
  assert.equal(v.get('RunbackFrame.shown'), 'true');
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('I just reached level 12. What changes at this level?'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
});

test('level-up nudge waits for combat to end and stays quiet while the AI is off', () => {
  let v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("PLAYER_LEVEL_UP", 20)');
  assert.ok(!prints(v).includes('Level 20!'), 'nothing in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.ok(prints(v).includes('Level 20!'), 'offered once combat ends');
  v.run('STUB.prints = {}; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.ok(!prints(v).includes('Level 20!'), 'offered only once');

  v = vm();
  v.run('RunbackForeverDB = RunbackForeverDB or {}; RunbackForeverDB.off = true; STUB.FireEvent("PLAYER_LEVEL_UP", 5)');
  assert.ok(!prints(v).includes('Level 5!'));
});

test('quest nudge: one chat line after accepting a quest out of combat; the link fills the box and sends nothing', () => {
  const v = vm();
  v.run('STUB.FireEvent("QUEST_DETAIL")');
  v.run('GetTitleText = function() return "Fiddlesticks" end; STUB.FireEvent("QUEST_DETAIL")');
  v.run('STUB.FireEvent("QUEST_ACCEPTED", 3, 77)');
  assert.ok(prints(v).includes('Quest accepted.'));
  assert.ok(prints(v).includes('[explain this quest]'));
  assert.ok(prints(v).includes('|Hrunback:ask:'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'nothing was sent');
  v.run('SetItemRef("runback:ask:" .. RunbackDB.chats[1].id)');
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('I just accepted the quest "Fiddlesticks". Explain what it asks of me, without spoilers.'));
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
});

test('quest nudge waits out combat, shows once, and stays quiet while the AI is off', () => {
  let v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("QUEST_ACCEPTED", 1, 5)');
  assert.ok(!prints(v).includes('Quest accepted.'), 'nothing in combat');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.ok(prints(v).includes('Quest accepted.'), 'offered once combat ends');
  assert.ok(v.get('Runback.askText').includes('a new quest'), 'no title known');
  v.run('STUB.prints = {}; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.ok(!prints(v).includes('Quest accepted.'), 'offered only once');

  v = vm();
  v.run('RunbackForeverDB = RunbackForeverDB or {}; RunbackForeverDB.off = true; STUB.FireEvent("QUEST_ACCEPTED", 1, 5)');
  assert.ok(!prints(v).includes('Quest accepted.'));
});

test('quest nudge: a title remembered from an earlier quest is not reused for the next accept', () => {
  const v = vm();
  v.run('GetTitleText = function() return "Fiddlesticks" end; STUB.FireEvent("QUEST_DETAIL"); STUB.FireEvent("QUEST_ACCEPTED", 1, 5)');
  assert.ok(v.get('Runback.askText').includes('Fiddlesticks'));
  v.run('STUB.FireEvent("QUEST_ACCEPTED", 2, 6)');
  assert.ok(v.get('Runback.askText').includes('a new quest'), 'no stale name');
});

test('quest nudge: a client that passes only the quest id still gets the quest named', () => {
  const v = vm();
  v.run('C_QuestLog = { GetTitleForQuestID = function(id) return id == 77 and "Fiddlesticks" or nil end }; STUB.FireEvent("QUEST_ACCEPTED", 77)');
  assert.ok(v.get('Runback.askText').includes('"Fiddlesticks"'));
});
