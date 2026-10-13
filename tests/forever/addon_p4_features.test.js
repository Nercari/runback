'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const luaparse = require('luaparse');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', '..', 'addon', 'Runback');
const STUB_PATH = path.join(__dirname, '..', 'wow_stub.lua');

const FEATURES_STUB = `
STUB.screenshots = 0
Screenshot = function()
  STUB.screenshots = STUB.screenshots + 1
end

STUB.playedSounds = {}
SOUNDKIT = { IG_QUEST_LOG_OPEN = 850 }
PlaySound = function(id)
  table.insert(STUB.playedSounds, id)
end

STUB.openedChat = {}
ChatFrame_OpenChat = function(text)
  table.insert(STUB.openedChat, text)
end

STUB.sentTells = {}
ChatFrame_SendTell = function(target)
  table.insert(STUB.sentTells, target)
end

C_VoiceChat = {
  spoken = {},
  voices = { { voiceID = 1, name = "Voice 1" } },
  SpeakText = function(id, text) table.insert(C_VoiceChat.spoken, text) end,
  GetTtsVoices = function() return C_VoiceChat.voices end,
}
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
  run(FEATURES_STUB);
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

test('all P4 module files parse as Lua 5.1 and respect local definition order', () => {
  const p4Files = [
    'Forever_Speech.lua',
    'Forever_Macro.lua',
    'Forever_Bulk.lua',
    'Forever_DeathShot.lua',
    'Forever_Translate.lua',
    'Forever_Jobs.lua',
    'Forever_Banner.lua',
  ];
  for (const f of p4Files) {
    const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
    assert.doesNotThrow(() => {
      luaparse.parse(src, { luaVersion: '5.1' });
    }, f + ' must parse as Lua 5.1');

    const code = src.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, m => m.replace(/[^\n]/g, ' '));
    const forward = new Set([...code.matchAll(/^local (\w+)\s*$/gm)].map(m => m[1]));
    const defs = [
      ...[...code.matchAll(/^local function (\w+)/gm)].map(m => ({ name: m[1], at: m.index, kind: 'function' })),
      ...[...code.matchAll(/^local (\w+)\s*=/gm)].map(m => ({ name: m[1], at: m.index, kind: 'value' })),
    ];
    for (const d of defs) {
      if (forward.has(d.name)) continue;
      const use = d.kind === 'function'
        ? new RegExp('(?<![\\w.:])' + d.name + '\\s*\\(', 'g')
        : new RegExp('(?<![\\w.:])' + d.name + '(?![\\w])', 'g');
      for (const m of code.matchAll(use)) {
        assert.ok(m.index >= d.at, `${d.name} used before definition in ${f}`);
      }
    }
  }
});

test('death shot button appears after death when out of combat and calls Screenshot only on click', () => {
  const vm = newVM();
  login(vm);

  // Player enters combat, then dies
  vm.run('InCombatLockdown = function() return true end');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  // The button may not exist yet: it is built lazily, out of combat.
  assert.equal(vm.evaluate('not (RunbackDeathShotButton and RunbackDeathShotButton.shown)'), 'true', 'button not shown in combat');
  assert.equal(vm.num('STUB.screenshots'), 0);

  // Leave combat
  vm.run('InCombatLockdown = function() return false end');
  vm.run('STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('RunbackDeathShotButton.shown'), 'true', 'button shown once out of combat');
  assert.equal(vm.num('STUB.screenshots'), 0, 'Screenshot not called before click');

  // Click the button
  vm.run('RunbackDeathShotButton.scripts.OnClick(RunbackDeathShotButton)');
  assert.equal(vm.num('STUB.screenshots'), 1, 'Screenshot called on click');
  assert.equal(vm.evaluate('RunbackDeathShotButton.shown'), 'false', 'button hidden after click');
});

test('translator never buffers non-opted channels, rate limits <= 1 send per 10s, never calls SendChatMessage', () => {
  const vm = newVM();
  login(vm);
  // Connect so Runback.Send works
  vm.run(`
    Runback.IsConnected = function() return true end
    Runback.Send = function(text, allow, opts)
      STUB.sentMsg = text
      STUB.sentOpts = opts
      for _, c in ipairs(RunbackDB.chats) do
        if c.id == opts.chat then c.pendingId = 7; STUB.target = c end
      end
    end
  `);

  // Non-opted channel (all default off)
  vm.run('STUB.FireEvent("CHAT_MSG_WHISPER", "hello stranger", "Alice")');
  assert.equal(vm.evaluate('STUB.sentMsg'), null, 'nothing sent for non-opted channel');

  // Opt-in to whisper
  vm.run('SlashCmdList.RUNBACK("translate on whisper")');
  assert.equal(vm.evaluate('RunbackForeverDB.translate.channels["whisper"]'), 'true');

  // Message from Alice
  vm.run('STUB.FireEvent("CHAT_MSG_WHISPER", "hello friend", "Alice")');
  assert.ok(vm.evaluate('STUB.sentMsg').includes('Alice: hello friend'));
  assert.ok(vm.evaluate('STUB.sentMsg').includes('[translate] to pt:'));
  assert.equal(vm.evaluate('STUB.sentOpts.cmd'), 'translate');

  // Second message immediately within 10s is buffered but not sent yet
  vm.run('STUB.sentMsg = nil');
  vm.run('STUB.FireEvent("CHAT_MSG_WHISPER", "how are you", "Alice")');
  assert.equal(vm.evaluate('STUB.sentMsg'), null, 'rate-limited: not sent before 10s');

  // Advance time by 10s and tick
  vm.run('STUB.now = STUB.now + 11; STUB.Tick()');
  assert.ok(vm.evaluate('STUB.sentMsg').includes('Alice: how are you'));

  // A plain reply in the mentor chat is not a translation: no popup.
  vm.run(`
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "translate" and mod.onReply then
        mod.onReply(STUB.target, { id = 6, text = "Plain mentor answer." })
      end
    end
  `);
  assert.equal(vm.evaluate('RunbackTranslateFrame == nil or not RunbackTranslateFrame:IsShown()'), 'true');

  // Reply containing fenced reply block pre-fills chat edit box
  vm.run(`
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "translate" and mod.onReply then
        mod.onReply(STUB.target, { id = 7, text ="Translation here.\\n\\n\`\`\`reply\\nEstou bem, obrigado!\\n\`\`\`" })
      end
    end
  `);
  assert.equal(vm.evaluate('RunbackTranslateFrame:IsShown()'), 'true', 'a translation opens the popup');
  assert.equal(vm.num('#STUB.sentTells'), 1);
  assert.equal(vm.evaluate('STUB.sentTells[1]'), 'Alice');
  // Never call SendChatMessage
  assert.equal(vm.evaluate('type(SendChatMessage)'), 'nil');
});

test('job board status transition triggers done sound and speech notice once', () => {
  const vm = newVM();
  login(vm);

  vm.run('SlashCmdList.RUNBACK("speak on")');

  // Toggle jobs frame
  vm.run('SlashCmdList.RUNBACK("jobs")');
  assert.equal(vm.evaluate('RunbackJobsFrame.shown'), 'true');

  // Set chat 1 to working
  vm.run('RunbackDB.chats[1].pendingId = 42');
  vm.run('for _, mod in ipairs(RunbackForever.modules) do if mod.name == "jobs" then mod.onReply({}, {}) end end'); // records "working"
  vm.run('STUB.playedSounds = {}; C_VoiceChat.spoken = {}');

  // Chat 1 completes with done status
  vm.run(`
    local c = RunbackDB.chats[1]
    c.pendingId = nil
    table.insert(c.history, { role = "assistant", text = "Finished task.", id = 42, t = time() })
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "jobs" and mod.onReply then
        mod.onReply(c, { id = 42, status = "done", text = "Finished task." })
      end
    end
  `);

  assert.equal(vm.num('#STUB.playedSounds'), 1, 'done sound played once');
  assert.equal(vm.num('STUB.playedSounds[1]'), 850);
  assert.equal(vm.num('#C_VoiceChat.spoken'), 1);
  assert.equal(vm.evaluate('C_VoiceChat.spoken[1]'), 'Chat 1 done');

  // Ticking does NOT re-trigger the sound or speech
  vm.run('STUB.Tick()');
  assert.equal(vm.num('#STUB.playedSounds'), 1, 'sound not played again on subsequent tick');
  assert.equal(vm.num('#C_VoiceChat.spoken'), 1);
});

test('policy banner shows on [policy] reply and prints once', () => {
  const vm = newVM();
  login(vm);

  const policyMsg = '[policy] File access to /etc/passwd was denied by security policy.';
  vm.run(`
    STUB.prints = {}
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "banner" and mod.onReply then
        mod.onReply({}, { text = "${policyMsg}" })
      end
    end
  `);

  assert.equal(vm.evaluate('RunbackPolicyBanner.shown'), 'true');
  assert.equal(vm.evaluate('RunbackPolicyBanner.msgText.text'), policyMsg);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes(policyMsg));

  // It sits below the mini bar (which spans y -40 to -70), stays on screen and closes with Esc.
  assert.ok(vm.num('RunbackPolicyBanner.y') <= -70, 'banner anchored clear of the mini bar');
  assert.equal(vm.evaluate('RunbackPolicyBanner.clamped'), 'true');
  assert.equal(vm.evaluate('(function() for _, n in ipairs(UISpecialFrames) do if n == "RunbackPolicyBanner" then return true end end return false end)()'), 'true');

  // Dismiss button hides banner
  vm.run('RunbackPolicyBanner.dismiss.scripts.OnClick()');
  assert.equal(vm.evaluate('RunbackPolicyBanner.shown'), 'false');
});
