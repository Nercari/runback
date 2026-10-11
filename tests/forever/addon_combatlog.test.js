'use strict';
// Backlog 58: combat log reminder at login and "This fight wasn't logged" on the mini bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm(logging) {
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
  // Every call that sets the log is recorded, so a test can prove none happened by itself.
  run(`STUB.logging = ${logging}; LOG_SETS = {}
    function LoggingCombat(on)
      if on ~= nil then table.insert(LOG_SETS, tostring(on)); STUB.logging = on end
      return STUB.logging
    end`);
  for (const file of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_CombatLog.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}
const prints = v => v.get('table.concat(STUB.prints, "\\n")').split('\n').filter(Boolean);
const reminders = v => prints(v).filter(line => line.includes('[turn on combat log]'));
const logSets = v => v.get('table.concat(LOG_SETS, ",")');
const mini = v => v.get(`(function()
  local out = {}
  for _, c in ipairs(WoWAIMini.children) do if c.kind == "FontString" and c.text then out[#out + 1] = c.text end end
  return table.concat(out, " | ")
end)()`);
const fight = v => v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');

test('login with the combat log off prints exactly one line with the link', () => {
  const v = vm(false);
  v.run('STUB.RunTimers(); STUB.FireEvent("PLAYER_ENTERING_WORLD")');
  const lines = reminders(v);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('|Hwowai:combatlog|h|cff55ff55[turn on combat log]|r|h'), lines[0]);
});

test('login with the combat log on prints nothing', () => {
  const v = vm(true);
  assert.deepEqual(prints(v).filter(line => /combat log/i.test(line)), []);
});

test('the reminder never switches the log on by itself', () => {
  const v = vm(false);
  fight(v);
  v.run('STUB.RunTimers(); STUB.Tick()');
  fight(v);
  assert.equal(logSets(v), '');
  assert.equal(v.get('STUB.logging'), 'false');
});

test('clicking the link turns the log on out of combat, and only says so in combat', () => {
  let v = vm(false);
  v.run('SetItemRef("wowai:combatlog")');
  assert.equal(logSets(v), 'true');
  assert.equal(v.get('STUB.logging'), 'true');
  assert.ok(prints(v).includes('|cff7ec8ff[WoW AI]|r Combat log on.'));
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('Combat log: on'), 'the window button is refreshed');

  v = vm(false);
  v.run('STUB.combat = true; SetItemRef("wowai:combatlog")');
  assert.equal(logSets(v), '');
  assert.equal(v.get('STUB.logging'), 'false');
  assert.ok(prints(v).includes('|cff7ec8ff[WoW AI]|r The combat log can be switched on out of combat only.'));
});

test('a fight that ends with the log off shows "This fight wasn\'t logged" on the mini bar', () => {
  const v = vm(false);
  v.run('WoWAI.Minimize(true)');
  assert.doesNotMatch(mini(v), /wasn't logged/);
  fight(v);
  assert.match(mini(v), /This fight wasn't logged/);
  // Switching the log on clears it at once.
  v.run('SetItemRef("wowai:combatlog")');
  assert.doesNotMatch(mini(v), /wasn't logged/);
});

test('a fight that ends with the log on shows nothing about it', () => {
  const v = vm(true);
  v.run('WoWAI.Minimize(true)');
  fight(v);
  assert.doesNotMatch(mini(v), /wasn't logged/);
  assert.match(mini(v), /idle/);
});

test('the Combat log button still toggles through the shared switch', () => {
  const v = vm(false);
  v.run(`for _, f in ipairs(STUB.frames) do
    if f.kind == "Button" and f.text == "Combat log: off" then f.scripts.OnClick(f) end
  end`);
  assert.equal(logSets(v), 'true');
});
