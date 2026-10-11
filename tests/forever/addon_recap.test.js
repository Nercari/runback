'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm() {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const run = code => {
    const loaded = lauxlib.luaL_loadstring(L, to_luastring(code));
    assert.equal(loaded, lua.LUA_OK, loaded === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1)));
    const status = lua.lua_pcall(L, 0, 0, 0);
    if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  };
  const get = expr => {
    run(`RESULT = tostring(${expr})`); lua.lua_getglobal(L, to_luastring('RESULT'));
    const value = to_jsstring(lua.lua_tolstring(L, -1)); lua.lua_pop(L, 1); return value;
  };
  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8'));
  run('unpack = table.unpack');
  for (const file of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Recap.lua', 'Forever_Commands.lua']) run(read(file));
  run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, get };
}
const prints = v => v.get('table.concat(STUB.prints, "\\n")');

const fight = v => v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');

test('recap offer: one chat line after a fight and a quiet spell; the link fills the box and sends nothing', () => {
  const v = vm();
  v.run('STUB.RunTimers()');
  assert.ok(!prints(v).includes('recap this session'), 'no fight, no offer');
  fight(v);
  assert.ok(!prints(v).includes('recap this session'), 'not before the quiet spell');
  v.run('STUB.RunTimers()');
  assert.ok(prints(v).includes('[recap this session]'));
  v.run('SetItemRef("wowai:ask:" .. WoWAIDB.chats[1].id)');
  assert.ok(v.get('table.concat(STUB.texts, "|")').includes('Give me a short recap of this session.'));
  assert.equal(v.get('WoWAIDB.chats[1].pendingId'), 'nil', 'the player still has to press Enter');
});

test('recap offer: cancelled by a new fight, at most once an hour, quiet while the AI is off', () => {
  let v = vm();
  fight(v);
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  v.run('STUB.RunTimers()');
  assert.ok(!prints(v).includes('recap this session'), 'not offered during a fight');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED"); STUB.RunTimers()');
  assert.ok(prints(v).includes('recap this session'));
  v.run('STUB.prints = {}; STUB.now = STUB.now + 600');
  fight(v); v.run('STUB.RunTimers()');
  assert.ok(!prints(v).includes('recap this session'), 'a second offer inside the hour');
  v.run('STUB.now = STUB.now + 4000');
  fight(v); v.run('STUB.RunTimers()');
  assert.ok(prints(v).includes('recap this session'), 'offered again after an hour and another fight');

  v = vm();
  v.run('WoWAIForeverDB = WoWAIForeverDB or {}; WoWAIForeverDB.off = true');
  fight(v); v.run('STUB.RunTimers()');
  assert.ok(!prints(v).includes('recap this session'));
});

test('/ai recap sends cmd=recap with the default text out of combat only', () => {
  const v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); SlashCmdList.WOWAI("recap")');
  assert.match(v.get('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), /AI paused in combat/);
});

test('recap offer: window use restarts the quiet spell (no offer within 5 minutes of use)', () => {
  const v = vm();
  v.run('WoWAI.Toggle(true)');
  fight(v);
  v.run('STUB.now = STUB.now + 200; WoWAI.SendFromInput()');
  v.run('STUB.now = STUB.now + 150'); // 350 s after the fight, 150 s after the last use
  v.run('STUB.RunTimers()');
  assert.ok(!prints(v).includes('recap this session'), 'used the window 150 s ago');
  v.run('STUB.now = STUB.now + 200'); // 350 s after the last use
  v.run('STUB.RunTimers()');
  assert.ok(prints(v).includes('[recap this session]'), 'offered once the window has been quiet for 5 minutes');
});

test('recap offer: every kind of window use counts, and an unused window does not delay it', () => {
  const uses = {
    open: 'WoWAI.Toggle(false); WoWAI.Toggle(true)',
    send: 'WoWAI.SendFromInput()',
    typing: 'WoWAIInput.hooks.OnTextChanged[1](WoWAIInput, true)',
    clickBox: 'WoWAIInput.hooks.OnEditFocusGained[1](WoWAIInput)',
    clickWindow: 'WoWAIFrame.hooks.OnMouseDown[1](WoWAIFrame)',
    replyShown: 'WoWAI.Toggle(true); WoWAI.internal.ActiveChat().pendingId = 99; WoWAI.internal.Finish(WoWAI.internal.ActiveChat(), "assistant", "hi")',
  };
  for (const [name, code] of Object.entries(uses)) {
    const v = vm();
    v.run('WoWAI.Toggle(true)');
    fight(v);
    v.run('STUB.now = STUB.now + 250');
    try { v.run(code); } catch (e) { assert.fail(`${name}: ${e.message}`); }
    v.run('STUB.now = STUB.now + 100; STUB.RunTimers()');
    assert.ok(!prints(v).includes('recap this session'), `${name} should delay the offer`);
  }
  // No window use: the normal offer.
  const v = vm();
  fight(v);
  v.run('STUB.now = STUB.now + 350; STUB.RunTimers()');
  assert.ok(prints(v).includes('recap this session'), 'no window use, normal offer');
});
