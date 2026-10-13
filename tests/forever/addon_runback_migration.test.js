'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');

function vm() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    const status = lua.lua_pcall(L, nargs, 0, 0);
    if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  const truthy = expr => {
    run(`RESULT = (${expr}) and 1 or 0`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = lua.lua_tointeger(L, -1); lua.lua_pop(L, 1); return value === 1;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua']) run(read(file));
  run(read('Runback.lua'), 'Runback');
  return { run, get, truthy, load: () => run('STUB.FireEvent("ADDON_LOADED", "Runback")') };
}

test('legacy WoWAIDB migrates into RunbackDB once without touching the legacy table', () => {
  const v = vm();
  v.run('WoWAIDB = { settings = { echo = "short" }, chats = { { id = "abc", name = "Old" } }, marker = 42 }');
  v.load();
  assert.equal(v.get('RunbackDB.migratedFrom'), 'WoWAI');
  assert.equal(v.get('RunbackDB.marker'), '42');
  assert.equal(v.get('RunbackDB.settings.echo'), 'short');
  assert.equal(v.get('WoWAIDB.marker'), '42');
  assert.equal(v.get('WoWAIDB.settings.echo'), 'short');
});

test('an existing RunbackDB is not overwritten when WoWAIDB is still present', () => {
  const v = vm();
  v.run('RunbackDB = { settings = { echo = "off" }, chats = {}, kept = true }');
  v.run('WoWAIDB = { settings = { echo = "full" }, chats = {}, marker = 99 }');
  v.load();
  assert.equal(v.get('RunbackDB.kept'), 'true');
  assert.equal(v.get('RunbackDB.settings.echo'), 'off');
  assert.equal(v.truthy('RunbackDB.migratedFrom == nil'), true);
  assert.equal(v.get('WoWAIDB.marker'), '99');
});

test('migration is idempotent on a second ADDON_LOADED', () => {
  const v = vm();
  v.run('WoWAIDB = { settings = {}, chats = {}, seq = 1 }');
  v.load();
  v.run('RunbackDB.seq = 2');
  v.load();
  assert.equal(v.get('RunbackDB.seq'), '2');
  assert.equal(v.get('RunbackDB.migratedFrom'), 'WoWAI');
});

test('/runback and /wowai are registered; /rb registers when free', () => {
  const v = vm();
  v.load();
  assert.equal(v.get('SLASH_RUNBACK1'), '/runback');
  assert.equal(v.get('SLASH_RUNBACK2'), '/wowai');
  assert.equal(v.get('SLASH_RUNBACK6'), '/rb');
});
