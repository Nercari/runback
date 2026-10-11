'use strict';
// Backlog 77: a reply must not be stranded when the slot pool runs out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
function vm() {
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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'WoWAI.lua']) run(fs.readFileSync(path.join(addon, file), 'utf8'));
  run(`function BUTTON(label)
    for _, f in ipairs(STUB.frames) do
      if f.kind == "Button" and f.text == label and f.shown then return f end
    end
  end`);
  return { run, get };
}

const slot = replies => `STUB.onLoadAddOn = function() WoWAI_SlotData = { now = time(), cwd = "", agent = "agy", agents = { "claude", "agy" }, replies = { ${replies || ''} } } end`;

test('slot pool used up with a reply pending: the status says to click Get reply, the stall offer stays, only the click reloads', () => {
  const v = vm();
  v.run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  v.run(slot());
  v.run('STUB.now = STUB.now + 6; STUB.Tick()');
  v.run('WoWAI.Send("how do I get to Undercity?")');
  const chatId = v.get('WoWAIDB.chats[1].id');
  const id = v.get('WoWAIDB.chats[1].pendingId');
  v.run(slot(`{ chat = "${chatId}", id = ${id}, status = "working", text = "read a", stall = "quiet" }`));
  v.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(v.get('WoWAIDB.chats[1].stall'), 'quiet');

  // Every slot addon is now loaded: the next poll finds no free slot.
  v.run('C_AddOns.IsAddOnLoaded = function() return true end; STUB.texts = {}');
  for (let i = 0; i < 10; i++) v.run('STUB.now = STUB.now + 30; STUB.Tick(); STUB.RunTimers()');

  const status = v.get('table.concat(STUB.texts, "\\n")').split('\n').filter(t => /slot/i.test(t)).at(-1);
  assert.equal(status, 'Antigravity has gone quiet. Out of reply slots: click Get reply to check for your reply (the game UI reloads)');
  assert.equal(v.get('BUTTON("Stop") ~= nil'), 'true', 'Stop still shows');
  assert.equal(v.get('BUTTON("Ask Claude instead") ~= nil'), 'true', 'Ask Claude instead still shows');
  assert.equal(v.get('BUTTON("Get reply") ~= nil'), 'true', 'a Get reply button shows');
  assert.equal(v.get('BUTTON("Reload") == nil'), 'true', 'no second reload button');
  assert.equal(v.get('STUB.reloaded == true'), 'false', 'timers and ticks never reload');

  v.run('BUTTON("Get reply").scripts.OnClick(BUTTON("Get reply"))');
  assert.equal(v.get('STUB.reloaded == true'), 'true', 'the click reloads');
});
