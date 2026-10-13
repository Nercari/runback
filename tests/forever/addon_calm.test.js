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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Calm.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}

test('the window folds when a fight starts and opens again when it ends', () => {
  const v = vm();
  v.run('Runback.Toggle(true)');
  assert.equal(v.get('RunbackFrame.shown'), 'true');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(v.get('RunbackFrame.shown'), 'false', 'no advice on screen in combat');
  assert.equal(v.get('RunbackDB.settings.minimized'), 'true');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(v.get('RunbackFrame.shown'), 'true', 'back after the fight');
});

test('a window the player had closed stays closed, and a manual choice in a fight wins', () => {
  let v = vm();
  v.run('Runback.Toggle(false)');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(v.get('RunbackFrame.shown'), 'false');

  v = vm();
  v.run('Runback.Toggle(true); STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); Runback.Toggle(false)');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(v.get('RunbackFrame.shown'), 'false', 'player closed it mid-fight, it stays closed');
});

// Backlog 79: a window opened by hand mid-fight shows no AI reply text.
const HIDDEN = 'Replies are hidden during combat';
const BUILD = 'Talent build: 5/5 Improved Corruption first.';
const OTHER = 'Second chat reply about Rot Hide Gnolls.';
const bodies = v => JSON.parse(v.get(`(function()
  local out = {}
  for _, b in ipairs(RunbackContent.children) do
    if b.shown and b.body then table.insert(out, string.format("%q", b.body:GetText())) end
  end
  return "[" .. table.concat(out, ",") .. "]"
end)()`).replace(/\\\n/g, '\\n'));

function withReplies() {
  const v = vm();
  v.run(`Runback.NewChat("second")
    table.insert(RunbackDB.chats[1].history, { role = "user", text = "best build?", t = 1 })
    table.insert(RunbackDB.chats[1].history, { role = "assistant", text = ${JSON.stringify(BUILD)}, t = 2 })
    table.insert(RunbackDB.chats[2].history, { role = "assistant", text = ${JSON.stringify(OTHER)}, t = 3 })
    Runback.SwitchChat(RunbackDB.chats[1].id)
    Runback.Toggle(true)`);
  return v;
}

test('a window opened mid-fight shows one hidden line instead of the replies, and they come back after', () => {
  const v = withReplies();
  assert.deepEqual(bodies(v), ['best build?', BUILD]);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); Runback.Toggle(true)');
  assert.equal(v.get('RunbackFrame.shown'), 'true', 'the manual open still wins');
  assert.deepEqual(bodies(v), [HIDDEN]);
  v.run('Runback.SwitchChat(RunbackDB.chats[2].id)');
  assert.deepEqual(bodies(v), [HIDDEN], 'switching chats in a fight shows no reply either');
  v.run('Runback.Render()');
  assert.deepEqual(bodies(v), [HIDDEN], 'a re-render in a fight stays hidden');
  assert.equal(v.get('RunbackInput.shown'), 'true', 'the input box stays');
  assert.equal(v.get('RunbackDB.activeChat == RunbackDB.chats[2].id'), 'true', 'the chat list still switches');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.deepEqual(bodies(v), [OTHER], 'the text is back after the fight');
});

test('the copy box shows no reply text in a fight', () => {
  let v = withReplies();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); Runback.Toggle(true); Runback.ShowCopy("secret")');
  assert.equal(v.get('RunbackCopy ~= nil and RunbackCopy.shown'), 'false', 'it does not open in a fight');

  v = withReplies();
  v.run('Runback.ShowCopy("secret")');
  assert.equal(v.get('RunbackCopy.shown'), 'true');
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(v.get('RunbackCopy.shown'), 'false', 'an open one closes when the fight starts');
});
