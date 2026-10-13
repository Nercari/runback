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

const PAIRS = [
  ['RunbackDB', 'WoWAIDB', '{ settings = { echo = "short" }, chats = {}, marker = 42 }'],
  ['RunbackMapDB', 'WoWAIMapDB', '{ map = { layers = {} }, marker = 7 }'],
  ['RunbackGuideDB', 'WoWAIGuideDB', '{ guides = { list = {} }, marker = 3 }'],
  ['RunbackForeverDB', 'WoWAIForeverDB', '{ off = false, marker = 9 }'],
  ['Runback_Bulk', 'WoWAI_Bulk', '{ ah = { version = 2 }, marker = 11 }'],
];

for (const [newName, oldName, legacyLua] of PAIRS) {
  test(`legacy ${oldName} migrates into ${newName} without touching the legacy table`, () => {
    const v = vm();
    v.run(`${oldName} = ${legacyLua}`);
    v.load();
    assert.equal(v.get(`${newName}.migratedFrom`), 'WoWAI');
    assert.equal(v.get(`${newName}.marker`), legacyLua.match(/marker = (\d+)/)[1]);
    assert.equal(v.get(`${oldName}.marker`), legacyLua.match(/marker = (\d+)/)[1]);
  });

  test(`existing ${newName} is not overwritten when ${oldName} is still present`, () => {
    const v = vm();
    v.run(`${newName} = { marker = 1, kept = true }`);
    v.run(`${oldName} = ${legacyLua}`);
    v.load();
    assert.equal(v.get(`${newName}.kept`), 'true');
    assert.equal(v.truthy(`${newName}.migratedFrom == nil`), true);
    assert.equal(v.get(`${oldName}.marker`), legacyLua.match(/marker = (\d+)/)[1]);
  });
}

test('migration is idempotent on a second ADDON_LOADED', () => {
  const v = vm();
  v.run('WoWAIDB = { settings = {}, chats = {}, seq = 1 }');
  v.load();
  v.run('RunbackDB.seq = 2');
  v.load();
  assert.equal(v.get('RunbackDB.seq'), '2');
  assert.equal(v.get('RunbackDB.migratedFrom'), 'WoWAI');
});

test('slash commands: /runback primary, /wow-ai and /wowai kept, /rb when free', () => {
  const v = vm();
  v.load();
  assert.equal(v.get('SLASH_RUNBACK1'), '/runback');
  assert.equal(v.get('SLASH_RUNBACK2'), '/wowai');
  assert.equal(v.get('SLASH_RUNBACK3'), '/wow-ai');
  assert.equal(v.get('SLASH_RUNBACK7'), '/rb');
});

function rbNotes(v) {
  const text = v.get('table.concat(STUB.prints, "\\n")');
  return text.split('\n').filter(line => line.includes('/runback still works'));
}

test('SlashCmdList.WOWAI is the Runback slash handler', () => {
  const v = vm();
  v.load();
  assert.equal(v.truthy('type(SlashCmdList["WOWAI"]) == "function"'), true);
  assert.equal(v.truthy('SlashCmdList["WOWAI"] == SlashCmdList["RUNBACK"]'), true);
  const before = v.get('#RunbackDB.chats[1].history');
  v.run('SlashCmdList["WOWAI"]("help")');
  assert.notEqual(v.get('#RunbackDB.chats[1].history'), before);
});

test('hash_SlashCmdList stores handlers: own function keeps /rb, another function hints once', () => {
  const own = vm();
  own.load();
  own.run('hash_SlashCmdList["/rb"] = nil');
  own.run('hash_SlashCmdList["/RB"] = SlashCmdList.RUNBACK');
  own.run('STUB.prints = {}');
  own.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(own.get('SLASH_RUNBACK7'), '/rb');
  assert.equal(rbNotes(own).length, 0);

  const other = vm();
  other.load();
  other.run('hash_SlashCmdList["/RB"] = function() end');
  other.run('STUB.prints = {}');
  other.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(other.get('SLASH_RUNBACK7'), 'nil');
  const once = rbNotes(other);
  assert.equal(once.length, 1);
  other.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(rbNotes(other).length, 1);
});

test('PLAYER_LOGIN rechecks /rb and says once when another addon owns it', () => {
  const taken = vm();
  taken.load();
  assert.equal(taken.get('SLASH_RUNBACK7'), '/rb');
  taken.run('hash_SlashCmdList["/rb"] = "OTHER"');
  taken.run('STUB.prints = {}');
  taken.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(taken.get('SLASH_RUNBACK7'), 'nil');
  const once = rbNotes(taken);
  assert.equal(once.length, 1);
  assert.equal(once[0].includes('\n'), false);
  taken.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(rbNotes(taken).length, 1);

  const free = vm();
  free.load();
  free.run('STUB.prints = {}');
  free.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(free.get('SLASH_RUNBACK7'), '/rb');
  assert.equal(rbNotes(free).length, 0);
});

test('slash /rb is not registered when hash_SlashCmdList already owns /rb', () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK);
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    assert.equal(lua.lua_pcall(L, nargs, 0, 0), lua.LUA_OK);
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  run('hash_SlashCmdList["/rb"] = "OTHER"');
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua']) run(read(file));
  run(read('Runback.lua'), 'Runback');
  assert.equal(get('SLASH_RUNBACK7'), 'nil');
  run('STUB.prints = {}');
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('RESULT = 0; for _, line in ipairs(STUB.prints) do if string.find(line, "/runback still works", 1, true) then RESULT = RESULT + 1 end end');
  assert.equal(get('RESULT'), '1');
});

test('Runback.toc declares Runback and legacy SavedVariables', () => {
  const toc = read('Runback.toc');
  for (const name of [
    'RunbackDB', 'RunbackMapDB', 'RunbackGuideDB', 'RunbackForeverDB', 'Runback_Bulk',
    'WoWAIDB', 'WoWAIMapDB', 'WoWAIGuideDB', 'WoWAIForeverDB', 'WoWAI_Bulk',
  ]) {
    assert.match(toc, new RegExp(`\\b${name}\\b`), name);
  }
});

test('non-table legacy saved data is skipped', () => {
  const v = vm();
  v.run('WoWAIDB = "not-a-table"');
  v.load();
  assert.equal(v.truthy('RunbackDB.migratedFrom == nil'), true);
  assert.equal(v.get('WoWAIDB'), 'not-a-table');
});

test('migration deep copy is cycle-safe', () => {
  const v = vm();
  v.run('local t = { marker = 5 }; t.loop = t; WoWAIDB = t');
  v.load();
  assert.equal(v.get('RunbackDB.marker'), '5');
  assert.equal(v.truthy('RunbackDB.loop == RunbackDB'), true);
  assert.equal(v.truthy('WoWAIDB.loop == WoWAIDB'), true);
});
