'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const luaparse = require('luaparse');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const root = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waiprobe-'));

function probeVM() {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const run = (source) => {
    if (lauxlib.luaL_loadstring(state, to_luastring(source)) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
    if (lua.lua_pcall(state, 0, 0, 0) !== lua.LUA_OK) {
      throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
    }
  };
  const value = (expression) => {
    run(`RESULT = tostring(${expression})`);
    lua.lua_getglobal(state, to_luastring('RESULT'));
    const result = to_jsstring(lua.lua_tolstring(state, -1));
    lua.lua_pop(state, 1);
    return result;
  };
  run(fs.readFileSync(path.join(root, 'tests', 'wow_stub.lua'), 'utf8'));
  run(`
    STUB.calls = {}
    local function called(name)
      table.insert(STUB.calls, name)
    end
    function Screenshot() called('Screenshot') end
    function CopyToClipboard() called('CopyToClipboard') end
    function CreateMacro() called('CreateMacro'); return 1 end
    function SetCVar() called('SetCVar') end
    function LoggingCombat() called('LoggingCombat'); return false end
    function GetCVar() return 'tga' end
    function GetServerTime() return time() end
    function GetNumMacros() return 0, 0 end
    function GetMacroIndexByName() return 0 end
    function GetMacroInfo() return nil end
    function DeleteMacro() end
    function GetQuestText() return 'Quest' end
    function GetObjectiveText() return 'Objective' end
    function GetInventoryItemLink() return nil end
    function GetNumMacros() return 0, 0 end
    function GetMacroInfo() return nil end
    function InCombatLockdown() return STUB.combat or false end
    C_AuctionHouse = {}
    C_EncounterJournal = {}
    C_ChallengeMode = {}
    C_DamageMeter = {}
    C_VoiceChat = { SpeakText = function() end, GetTtsVoices = function() return {} end }
    C_Traits = {}
    C_ClassTalents = {}
    C_PartyInfo = {}
    function STUB.ClickProbe(label)
      for _, frame in ipairs(STUB.frames) do
        for _, child in ipairs(frame.children or {}) do
          if child.scripts and child.scripts.OnClick and child.text == label then
            child.scripts.OnClick(child)
            return
          end
        end
      end
    end
  `);
  const addon = fs.readFileSync(path.join(root, 'probe', 'RunbackProbe', 'RunbackProbe.lua'), 'utf8');
  run(`(function(...) ${addon}\nend)("RunbackProbe")`);
  return { run, value };
}

test('probe Lua files parse as Lua 5.1', () => {
  for (const file of [
    'probe/RunbackProbe/RunbackProbe.lua',
    'probe/RunbackProbe_LOD/RunbackProbe_LOD.lua',
  ]) {
    assert.doesNotThrow(() => {
      luaparse.parse(fs.readFileSync(path.join(root, file), 'utf8'), { luaVersion: '5.1' });
    });
  }
});

test('probe boot readback, event counts, and buttons obey click and combat gates', () => {
  const vm = probeVM();
  vm.run('STUB.FireEvent("ADDON_LOADED", "RunbackProbe")');
  assert.equal(vm.value('RunbackProbeDB.results.sv_readback.value'), 'UNKNOWN (first run)');
  vm.run('RunbackProbeDB = { boot = 1, lastWrite = 10 }; STUB.FireEvent("ADDON_LOADED", "RunbackProbe")');
  assert.equal(vm.value('RunbackProbeDB.results.sv_readback.value'), 'PASS');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.value('#STUB.calls'), '0');
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.run('STUB.FireEvent("QUEST_DETAIL"); STUB.FireEvent("ENCOUNTER_START", 1, "Boss")');
  vm.run('STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.value('RunbackProbeDB.events.PLAYER_REGEN_DISABLED.count'), '1');
  assert.equal(vm.value('RunbackProbeDB.events.PLAYER_REGEN_ENABLED.count'), '1');
  const before = Number(vm.value('#STUB.calls'));
  vm.run('STUB.ClickProbe("Screenshot now")');
  assert.equal(Number(vm.value('#STUB.calls')), before);
  vm.run('STUB.ClickProbe("Set PNG"); STUB.ClickProbe("CreateMacro test")');
  vm.run('STUB.ClickProbe("LoggingCombat test"); STUB.ClickProbe("LoadAddOn test")');
  assert.equal(Number(vm.value('#STUB.calls')), before);
  vm.run('STUB.combat = false; STUB.ClickProbe("Screenshot now")');
  assert.equal(vm.value('#STUB.calls'), '1');
  assert.equal(vm.value('STUB.calls[1]'), 'Screenshot');
});

test('check-log streams summary and anonymizes fixture consistently without changing source', () => {
  const log = path.join(tmp, 'WoWCombatLog.txt');
  const fixture = path.join(tmp, 'fixture.txt');
  const src = [
    'COMBAT_LOG_VERSION, 23, ADVANCED_LOG_ENABLED, 1',
    '9/25 12:00:00.000  ENCOUNTER_START, 1, "Boss", 16, 20',
    '9/25 12:00:01.000  SPELL_DAMAGE, 0x0000000000000001, "Alice-Realm", 0x511, ' +
      '0x0000000000000002, "Other-Realm", 0x511, 1, "Hit", 4, 100, 0, 0, 0, ' +
      '0, 0, 0, 1.2, 3.4, 1',
    '9/25 12:00:02.000  ENCOUNTER_END, 1, "Boss", 16, 20, 1',
  ].join('\n') + '\n';
  fs.writeFileSync(log, src);
  const result = spawnSync(process.execPath, [
    path.join(root, 'probe/check-log.js'), '--log', log, '--player', 'Alice-Realm',
    '--fixture', fixture, '--start', '2026-09-25T12:00:00Z', '--end', '2026-09-25T13:00:00Z', '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  const output = fs.readFileSync(fixture, 'utf8');
  assert.equal(data.lineCount, 4);
  assert.equal(data.player.nameAppears, true);
  assert.match(output, /Player1/);
  assert.equal(fs.readFileSync(log, 'utf8'), src);
});

test('gate-table uses exact per-key pass values', () => {
  const saved = path.join(tmp, 'RunbackProbe.lua');
  const output = path.join(tmp, 'gate.md');
  fs.writeFileSync(saved, 'RunbackProbeDB = { ["report"] = "screenshot_hw=CALLED\\napi_auctionhouse=table\\nsv_readback=PASS\\ncreatemacro=FAIL\\n" }');
  const result = spawnSync(process.execPath, [
    path.join(root, 'probe/gate-table.js'), '--sv', saved, '--out', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const table = fs.readFileSync(output, 'utf8');
  assert.match(table, /F02[^\n]*FALLBACK/);
  assert.match(table, /F13[^\n]*PASS/);
  assert.match(table, /S4[^\n]*PASS/);
  assert.match(table, /F25[^\n]*UNKNOWN/);
});
