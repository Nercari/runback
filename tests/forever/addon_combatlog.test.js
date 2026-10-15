'use strict';
// Backlog 58: combat log reminder at login and "This fight wasn't logged" on the mini bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_CombatLog.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}
const prints = v => v.get('table.concat(STUB.prints, "\\n")').split('\n').filter(Boolean);
const reminders = v => prints(v).filter(line => line.includes('[turn on combat log]'));
const logSets = v => v.get('table.concat(LOG_SETS, ",")');
const mini = v => v.get(`(function()
  local out = {}
  for _, c in ipairs(RunbackMini.children) do if c.kind == "FontString" and c.text then out[#out + 1] = c.text end end
  return table.concat(out, " | ")
end)()`);
const fight = v => v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');

test('login with the combat log off prints exactly one line with the link', () => {
  const v = vm(false);
  v.run('STUB.RunTimers(); STUB.FireEvent("PLAYER_ENTERING_WORLD")');
  const lines = reminders(v);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('|Hrunback:combatlog|h|cff55ff55[turn on combat log]|r|h'), lines[0]);
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
  v.run('SetItemRef("runback:combatlog")');
  assert.equal(logSets(v), 'true');
  assert.equal(v.get('STUB.logging'), 'true');
  assert.ok(prints(v).includes('|cff7ec8ff[Runback]|r Combat log on.'));
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('Combat log: on'), 'the window button is refreshed');

  v = vm(false);
  v.run('STUB.combat = true; SetItemRef("runback:combatlog")');
  assert.equal(logSets(v), '');
  assert.equal(v.get('STUB.logging'), 'false');
  assert.ok(prints(v).includes('|cff7ec8ff[Runback]|r The combat log can be switched on out of combat only.'));
});

test('a fight that ends with the log off shows "This fight wasn\'t logged" on the mini bar', () => {
  const v = vm(false);
  v.run('Runback.Minimize(true)');
  assert.doesNotMatch(mini(v), /wasn't logged/);
  fight(v);
  assert.match(mini(v), /This fight wasn't logged/);
  // Switching the log on clears it at once.
  v.run('SetItemRef("runback:combatlog")');
  assert.doesNotMatch(mini(v), /wasn't logged/);
});

test('a fight that ends with the log on shows nothing about it', () => {
  const v = vm(true);
  v.run('Runback.Minimize(true)');
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

// Backlog 83: the button read "off" for a moment with no click. Each change of
// LoggingCombat() is recorded with its time for /runback diag; an off without the
// player's click says so once per session in chat; nothing here switches the log.
const flipNotes = v => prints(v).filter(line => line.includes('without a click on the Combat log button'));
const diag = v => {
  v.run('SlashCmdList["RUNBACK"]("diag")');
  const h = 'RunbackDB.chats[1].history';
  return v.get(`${h}[#${h}].text`);
};
const clickButton = v => v.run(`for _, f in ipairs(STUB.frames) do
  if f.kind == "Button" and f.text and f.text:find("^Combat log: ") then f.scripts.OnClick(f) end
end`);

test('a flip to off with no click is recorded for diag and said once in chat', () => {
  const v = vm(true);
  v.run('STUB.Tick()');
  v.run('STUB.logging = false; STUB.Tick(); STUB.Tick(); STUB.Tick()');
  const notes = flipNotes(v);
  assert.equal(notes.length, 1, 'one line, not one per tick');
  assert.match(notes[0], /^\|cff7ec8ff\[Runback\]\|r The combat log turned off at 12:00 without a click/);
  // It comes back on (by something else), then flips off again: recorded, but no second line,
  // since on Forever it can flip every few seconds (2026-10-14, three lines in 24 s).
  v.run('STUB.logging = true; STUB.Tick(); STUB.logging = false; STUB.Tick()');
  assert.equal(flipNotes(v).length, 1, 'once per session');
  const text = diag(v);
  assert.match(text, /combat log now: off, changes this session: 12:00 off \(no click\); 12:00 on \(no click\); 12:00 off \(no click\)/);
  assert.equal(logSets(v), '', 'the watch only reads the log');
});

test('the diag list keeps only the last 10 changes', () => {
  const v = vm(true);
  v.run('STUB.Tick(); for i = 1, 15 do STUB.logging = not STUB.logging; STUB.Tick() end');
  const list = diag(v).match(/changes this session: (.*)/)[1].split('; ');
  assert.equal(list.length, 10);
});

test('the player\'s click on the Combat log button is recorded as a click and prints no flip line', () => {
  const v = vm(true);
  v.run('STUB.Tick()');
  clickButton(v);
  v.run('STUB.Tick()');
  assert.equal(logSets(v), 'false', 'the click switched it off');
  assert.deepEqual(flipNotes(v), []);
  assert.match(diag(v), /changes this session: 12:00 off \(your click\)/);
});

test('no diag change and no line while the log stays as it is', () => {
  const v = vm(true);
  for (let i = 0; i < 5; i++) v.run('STUB.Tick()');
  assert.deepEqual(flipNotes(v), []);
  assert.match(diag(v), /combat log now: on, changes this session: none/);
});

test('only the player-click switch calls LoggingCombat with an argument', () => {
  // Every LoggingCombat( call in the addon either reads it (no argument) or is the one in Runback.SetCombatLog.
  const writes = [];
  for (const file of fs.readdirSync(addon).filter(f => f.endsWith('.lua'))) {
    read(file).split('\n').forEach((line, i) => {
      if (/^\s*--/.test(line)) return;
      for (const m of line.matchAll(/LoggingCombat\(([^)]*)\)/g)) if (m[1].trim() !== '') writes.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(writes, ['Runback.lua:' + (read('Runback.lua').split('\n').findIndex(l => l.trim() === 'LoggingCombat(on)') + 1) + ': LoggingCombat(on)']);
  const fn = read('Runback.lua').match(/function Runback\.SetCombatLog\(on\)\n([\s\S]*?)\nend/)[1];
  assert.match(fn, /if InCombatLockdown\(\) or type\(LoggingCombat\) ~= "function" then return false end\n\tLoggingCombat\(on\)/);
  // SetCombatLog is reached only from the button's OnClick and the chat link click.
  const callers = [];
  for (const file of fs.readdirSync(addon).filter(f => f.endsWith('.lua'))) {
    read(file).split('\n').forEach(line => { if (/SetCombatLog\(/.test(line) && !/function Runback\.SetCombatLog/.test(line)) callers.push(line.trim()); });
  }
  assert.deepEqual(callers, [
    'if type(LoggingCombat) == "function" then Runback.SetCombatLog(not LoggingCombat()) end',
    'elseif Runback.SetCombatLog(true) then',
  ]);
});
