'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', '..', 'addon', 'Runback');
const STUB_PATH = path.join(__dirname, '..', 'wow_stub.lua');

const SPEECH_STUB = `
C_VoiceChat = {
  spoken = {},
  voices = { { voiceID = 1, name = "Voice One" }, { voiceID = 2, name = "Voice Two" } },
  SpeakText = function(voiceID, text, dest, rate, vol)
    table.insert(C_VoiceChat.spoken, { voiceID = voiceID, text = text, dest = dest, rate = rate, vol = vol, t = time() })
  end,
  GetTtsVoices = function()
    return C_VoiceChat.voices
  end,
}
Enum = Enum or {}
Enum.VoiceTtsDestination = { LocalPlayback = 1, RemoteTransmission = 2 }
GetQuestText = function() return STUB.questText or "Quest objective details text here." end
`;

function newVM(extra) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) {
      throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) {
      throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));

  run(fs.readFileSync(STUB_PATH, 'utf8'));
  run(SPEECH_STUB);
  if (extra) run(extra);
  for (const f of [
    'Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua',
    'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua',
    'Forever_Speech.lua', 'Forever_Macro.lua', 'Forever_Bulk.lua', 'Forever_DeathShot.lua',
    'Forever_Translate.lua', 'Forever_Jobs.lua', 'Forever_Banner.lua',
  ]) {
    run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Runback');
  }
  return { run, evaluate, num };
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "Runback")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
}

test('speech queue during lockout then flush in order with 5-min drop and newest-3 cap', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("speak on")');
  assert.equal(vm.evaluate('RunbackForeverDB.speech.enabled'), 'true');

  // Trigger lockout
  vm.run('STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(vm.evaluate('RunbackForever.Locked() ~= nil'), 'true');

  // Send 4 items while locked; cap keeps newest 3 ("item2", "item3", "item4")
  vm.run('RunbackForever.Speak("item1")');
  vm.run('RunbackForever.Speak("item2")');
  vm.run('RunbackForever.Speak("item3")');
  vm.run('RunbackForever.Speak("item4")');
  assert.equal(vm.num('#C_VoiceChat.spoken'), 0, 'nothing spoken while locked');

  // Advance time by 320 seconds; item2 and item3 are now older than 5 minutes (300s)
  vm.run('STUB.now = STUB.now + 320');
  // Add item5 which is fresh
  vm.run('RunbackForever.Speak("item5")');

  // End combat and lockout
  vm.run('STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('RunbackForever.Locked() == nil'), 'true');

  // Flushed: item2, item3, item4 were queued; after adding item5, queue had item3, item4, item5.
  // item3 and item4 were enqueued at t=0, so now-t=320 > 300: they are dropped!
  // Only item5 was fresh (at t=320) and survives.
  assert.equal(vm.num('#C_VoiceChat.spoken'), 1);
  assert.equal(vm.evaluate('C_VoiceChat.spoken[1].text'), 'item5');
});

test('speech commands configure settings and handle missing voices', () => {
  const vm = newVM();
  login(vm);

  vm.run('SlashCmdList.RUNBACK("speak voices")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Voice One'));

  vm.run('SlashCmdList.RUNBACK("speak voice 2")');
  assert.equal(vm.evaluate('RunbackForeverDB.speech.voice'), '2');

  vm.run('SlashCmdList.RUNBACK("speak rate 4")');
  assert.equal(vm.evaluate('RunbackForeverDB.speech.rate'), '4');

  vm.run('SlashCmdList.RUNBACK("narrate on")');
  assert.equal(vm.evaluate('RunbackForeverDB.speech.narrate'), 'true');

  // Client with no voices
  const vmNoVoices = newVM('C_VoiceChat.voices = {}');
  login(vmNoVoices);
  vmNoVoices.run('SlashCmdList.RUNBACK("speak on")');
  assert.ok(vmNoVoices.evaluate('table.concat(STUB.prints, "\\n")').includes('No text-to-speech voices on this client; replies stay text only.'));
  assert.equal(vmNoVoices.evaluate('RunbackForeverDB.speech.enabled'), 'false');
});

test('onReply speaks TL;DR marker or first 200 chars when enabled', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("speak on")');

  // Reply with TL;DR
  vm.run('C_VoiceChat.spoken = {}');
  vm.run('RunbackForever.modules[#RunbackForever.modules].onReply({}, { status = "done", text = "Long technical reply.\\n\\nTL;DR: The short summary." })');
  // Look for onReply across all modules
  vm.run(`
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "speech" and mod.onReply then
        mod.onReply({}, { status = "done", text = "First part.\\n\\nTL;DR: The short summary." })
      end
    end
  `);
  assert.equal(vm.evaluate('C_VoiceChat.spoken[#C_VoiceChat.spoken].text'), 'The short summary.');

  // Reply without TL;DR: first 200 chars
  const longText = 'A'.repeat(250);
  vm.run(`
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "speech" and mod.onReply then
        mod.onReply({}, { status = "done", text = "${longText}" })
      end
    end
  `);
  assert.equal(vm.evaluate('C_VoiceChat.spoken[#C_VoiceChat.spoken].text'), 'A'.repeat(200));
});

test('quest narration speaks GetQuestText on QUEST_DETAIL if narrate is on and not locked', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("narrate on")');
  vm.run('STUB.questText = "Deliver this package to Darkshire."');
  vm.run('C_VoiceChat.spoken = {}');

  vm.run('STUB.FireEvent("QUEST_DETAIL")');
  assert.equal(vm.num('#C_VoiceChat.spoken'), 1);
  assert.equal(vm.evaluate('C_VoiceChat.spoken[1].text'), 'Deliver this package to Darkshire.');

  // In combat: does not speak
  vm.run('C_VoiceChat.spoken = {}');
  vm.run('STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.run('STUB.FireEvent("QUEST_DETAIL")');
  assert.equal(vm.num('#C_VoiceChat.spoken'), 0);
});
