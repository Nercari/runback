'use strict';
// The test client (tests/wow_stub.lua) stands in for the Forever client at
// build 1.60.1 (70532), not for Classic Era. A green suite must not pass on API
// the real client lacks (the audit of #132).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

function vm() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const value = (expression) => {
    run(`RESULT = tostring(${expression})`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const result = to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return result;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  return { run, value };
}

test('the stub reports the Forever client build', () => {
  const { value } = vm();
  assert.equal(value('select(1, GetBuildInfo()) .. "/" .. select(2, GetBuildInfo()) .. "/" .. select(4, GetBuildInfo())'), '1.60.1/70532/16001');
});

test('the stub has no Classic talent or skill globals', () => {
  const { value } = vm();
  for (const name of ['GetNumTalentTabs', 'GetTalentTabInfo', 'GetNumSkillLines', 'GetSkillLineInfo']) {
    assert.equal(value(`type(${name})`), 'nil', `${name} is gone in build 70532`);
  }
});

test('the stub has the Forever talent and skill namespaces', () => {
  const { value } = vm();
  assert.equal(value('type(C_ClassTalents) .. "/" .. type(C_ClassTalents.GetActiveConfigID)'), 'table/function');
  assert.equal(value('type(C_Traits) .. "/" .. type(C_Traits.GetNodeInfo)'), 'table/function');
  assert.equal(value('C_SkillInfo.GetNumSkillLines()'), '8');
  assert.equal(value('C_SkillInfo.GetSkillLineInfo(4).name .. " " .. C_SkillInfo.GetSkillLineInfo(4).rank'), 'Skinning 75');
});

test('UnitHealth returns a plain number or a secret-like value', () => {
  const { run, value } = vm();
  assert.equal(value('UnitHealth("player")'), 'nil', 'no health until a test sets one');
  run('STUB.health = 1000; STUB.healthMax = 1000');
  assert.equal(value('UnitHealth("player")'), '1000');
  run('STUB.health = STUB.Secret()');
  assert.equal(value('issecretvalue(UnitHealth("player"))'), 'true');
  assert.equal(value('pcall(function() return UnitHealth("player") * 100 end)'), 'false', 'arithmetic on a secret raises');
  assert.equal(value('pcall(function() return tostring(UnitHealth("player")) end)'), 'false');
  assert.equal(value('issecretvalue(999)'), 'false');
});
