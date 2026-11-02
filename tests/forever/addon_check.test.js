'use strict';
// Launch go/no-go (#141): /runback check prints rows 3 to 6 and 11 in one block.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm({ toc = '16001', loaded = true, secrets = false, combat = false } = {}) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const state = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(state, lua.LUA_OK, state === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  run(`STUB.loaded.Runback = ${loaded}
    C_AddOns.GetAddOnMetadata = function(name, field)
      if name == "Runback" and field == "Interface" then return "${toc}" end
    end
    function LoggingCombat() return true end`);
  if (secrets) {
    run(`C_Secrets = {
      HasSecretRestrictions = function() return true end,
      ShouldUnitHealthMaxBeSecret = function(unit) return unit == "player" end,
    }`);
  }
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_CombatLog.lua']) run(read(file));
  run(`STUB.combat = ${combat}; STUB.FireEvent("ADDON_LOADED", "Runback")
    STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()`);
  return { run, get };
}
const check = v => {
  v.run('RunbackDB.outbox = nil; SlashCmdList["RUNBACK"]("check")');
  return v.get('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text');
};

test('/runback check puts build, toc, API types, secrets and combat log in one block', () => {
  const v = vm();
  const text = check(v);
  assert.match(text, /^Launch check:\n/);
  assert.match(text, /build 1\.60\.1\.70532, interface 16001/);
  assert.match(text, /addon loaded, toc interface 16001 \(current\)/);
  assert.match(text, /sound PlaySoundFile function/);
  assert.match(text, /talents GetNumTalentTabs nil, C_ClassTalents\.GetActiveConfigID function/);
  assert.match(text, /mouse MouseIsOver nil, GetMacroIndexByName nil/);
  assert.match(text, /secrets C_Secrets absent/);
  assert.match(text, /combat log on/);
  assert.match(text, /transport mode pixel/);
  // The same block opens selected, so one Ctrl+C pastes it into the issue.
  assert.equal(v.get('RunbackCopyBox:GetText()'), text.slice('Launch check:\n'.length));
});

test('an old toc is named out of date and an unloaded addon is named', () => {
  assert.match(check(vm({ toc: '15000' })), /toc interface 15000 \(OUT OF DATE: tick Load out of date addons\)/);
  assert.match(check(vm({ toc: '17000' })), /toc interface 17000 \(newer than the client\)/);
  assert.match(check(vm({ loaded: false })), /addon NOT loaded/);
});

test('the secrets line carries both answers, and waits for a fight to end', () => {
  assert.match(check(vm({ secrets: true })),
    /secrets HasSecretRestrictions true, ShouldUnitHealthMaxBeSecret\(player\) true/);
  assert.match(check(vm({ secrets: true, combat: true })),
    /secrets in combat; run this again after the fight/);
});

test('check reads only: it sends nothing and prints nothing to chat', () => {
  const v = vm();
  check(v);
  assert.equal(v.get('RunbackDB.outbox'), 'nil');
  assert.equal(v.get('table.concat(STUB.prints, "\\n"):find("Launch check")'), 'nil');
});
