'use strict';
// Backlog 80: `/ai look` with no text asks about the screen with a default question,
// typed or through the key binding, instead of printing a usage line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
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
  run('unpack = table.unpack');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua', 'WoWAI.lua', 'Forever_Keys.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  run('WoWAI.IsConnected = function() return true end');
  return { run, get };
}
const sent = v => ({
  cmd: v.get('WoWAIDB.outbox and WoWAIDB.outbox.cmd'),
  text: Buffer.from(v.get('WoWAIDB.outbox and WoWAIDB.outbox.text or ""'), 'hex').toString(),
  prints: v.get('table.concat(STUB.prints, "|")'),
});

test('/ai look alone asks about the screen with a default question', () => {
  const v = vm();
  v.run('SlashCmdList.WOWAI("look")');
  const out = sent(v);
  assert.equal(out.cmd, 'look');
  assert.equal(out.text, "What's on my screen?");
  assert.doesNotMatch(out.prints, /Usage: \/ai look/);
});

test('/ai look with text still sends that text', () => {
  const v = vm();
  v.run('SlashCmdList.WOWAI("look what is this mob?")');
  assert.deepEqual([sent(v).cmd, sent(v).text], ['look', 'what is this mob?']);
});

test('the look key binding with nothing typed sends the default question', () => {
  const v = vm();
  v.run('WoWAIForeverKeys.Run("look")');
  assert.equal(v.get('WoWAIInput:GetText()'), '/ai look ');
  v.run('WoWAIInput.scripts.OnEnterPressed(WoWAIInput)');
  assert.deepEqual([sent(v).cmd, sent(v).text], ['look', "What's on my screen?"]);
});

test('/ai council alone still asks for its question', () => {
  const v = vm();
  v.run('SlashCmdList.WOWAI("council")');
  assert.match(sent(v).prints, /Usage: \/ai council <text>/);
  assert.equal(sent(v).cmd, 'nil');
});
