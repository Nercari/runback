'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', '..', 'addon', 'Runback');
const STUB_PATH = path.join(__dirname, '..', 'wow_stub.lua');

// The Forever client has no retail auction house search events; its RegisterEvent errors on them.
const MISSING_EVENTS = `
local missing = { ITEM_SEARCH_RESULTS_RECEIVED = true, ITEM_SEARCH_RESULTS_UPDATED = true,
  COMMODITY_SEARCH_RESULTS_RECEIVED = true, COMMODITY_SEARCH_RESULTS_UPDATED = true }
local create = CreateFrame
CreateFrame = function(...)
  local f = create(...)
  local register = f.RegisterEvent
  f.RegisterEvent = function(self, ev)
    if missing[ev] then error('Attempt to register unknown event "' .. ev .. '"') end
    return register(self, ev)
  end
  return f
end
`;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) {
      throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(STUB_PATH, 'utf8'));
  run(MISSING_EVENTS);
  return { run, evaluate };
}

test('a module event the client lacks is skipped instead of breaking the addon load', () => {
  const vm = newVM();
  for (const f of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Bulk.lua']) {
    vm.run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Runback');
  }
  assert.equal(vm.evaluate('RunbackForever.modules[#RunbackForever.modules].name'), 'bulk');
  vm.run(`RunbackForever.Register({ name = "retail-ah", events = {
    ITEM_SEARCH_RESULTS_RECEIVED = true, COMMODITY_SEARCH_RESULTS_RECEIVED = true, AUCTION_HOUSE_SHOW = true } })`);
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.ITEM_SEARCH_RESULTS_RECEIVED'), 'true');
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.COMMODITY_SEARCH_RESULTS_RECEIVED'), 'true');
  assert.equal(vm.evaluate('RunbackForever.skippedEvents.AUCTION_HOUSE_SHOW'), null);
  // Every event the client does know is still registered for the bulk module.
  vm.run(`
    HAS = {}
    for _, f in ipairs(STUB.frames) do for ev in pairs(f.events) do HAS[ev] = true end end
  `);
  for (const ev of ['AUCTION_HOUSE_SHOW', 'AUCTION_HOUSE_CLOSED', 'PLAYER_LEVEL_UP', 'ZONE_CHANGED_NEW_AREA', 'PLAYER_LOGOUT']) {
    assert.equal(vm.evaluate(`HAS.${ev}`), 'true', ev);
  }
});
