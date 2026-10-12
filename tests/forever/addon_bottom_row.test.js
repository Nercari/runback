'use strict';
// Backlog 82: Reload and Resend never overlap, and the footer names only the agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
function vm() {
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
  for (const file of ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'WoWAI.lua']) run(fs.readFileSync(path.join(addon, file), 'utf8'));
  run(`-- Buttons are created once with their first label; Reload keeps its object when it reads "Get reply".
  function ANY_BUTTON(label)
    for _, f in ipairs(STUB.frames) do
      if f.kind == "Button" and f.text == label and f.parent == WoWAIFrame then return f end
    end
  end
  -- Every text the window shows right now, one per line (hidden frames skipped).
  function SHOWN_TEXTS()
    local out = {}
    local function walk(f)
      if not f.shown then return end
      if f.kind == "FontString" and f.text and f.text ~= "" then out[#out + 1] = f.text end
      for _, c in ipairs(f.children or {}) do walk(c) end
    end
    walk(WoWAIFrame)
    return table.concat(out, "\\n")
  end
  -- The status light: the frame whose texture carries the tooltip text.
  function LIGHT()
    for _, f in ipairs(STUB.frames) do
      if f.parent == WoWAIFrame and f.scripts.OnEnter and f.textures[1] and f.textures[1].tip then return f end
    end
  end`);
  return { run, get };
}

const slot = replies => `STUB.onLoadAddOn = function() WoWAI_SlotData = { now = time(), cwd = "C:\\\\Users\\\\pedro\\\\wow-mentor", agent = "agy", agents = { "claude", "agy" }, replies = { ${replies || ''} } } end`;

function connected() {
  const v = vm();
  v.run('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  v.run(slot());
  v.run('STUB.now = STUB.now + 6; STUB.Tick()');
  v.run('RESEND = ANY_BUTTON("Resend"); RELOAD = ANY_BUTTON("Reload")');
  return v;
}

test('Reload and Resend share one anchor, so they cannot overlap', () => {
  const v = connected();
  assert.equal(v.get('RESEND ~= nil and RELOAD ~= nil'), 'true');
  assert.equal(v.get('RESEND.anchor.point'), 'LEFT');
  assert.equal(v.get('RELOAD.anchor.point'), 'LEFT');
  assert.equal(v.get('RELOAD.anchor.rel == RESEND.anchor.rel'), 'true', 'same neighbour');
  assert.equal(v.get('RELOAD.x == RESEND.x and RELOAD.y == RESEND.y'), 'true', 'same offset');
  assert.equal(v.get('RELOAD.anchor.rel.text'), 'Combat log: ?', 'right of the Combat log button');
});

test('a message pending: Resend shows alone; when the slot pool runs out, Get reply replaces it', () => {
  const v = connected();
  v.run('WoWAI.Send("how do I get to Undercity?")');
  assert.equal(v.get('RESEND.shown'), 'true', 'Resend while the message is in flight');
  assert.equal(v.get('RELOAD.shown'), 'false', 'no Reload next to it');

  v.run('C_AddOns.IsAddOnLoaded = function() return true end');
  for (let i = 0; i < 10; i++) v.run('STUB.now = STUB.now + 30; STUB.Tick(); STUB.RunTimers()');
  assert.equal(v.get('RELOAD.shown'), 'true');
  assert.equal(v.get('RELOAD.text'), 'Get reply');
  assert.equal(v.get('RESEND.shown'), 'false', 'Get reply takes Resend\'s place');
});

test('the footer names only the agent; the folder and mode are in the light\'s tooltip', () => {
  const v = connected();
  v.run('WoWAI.Toggle(true)');
  const shown = v.get('SHOWN_TEXTS()').split('\n');
  assert.ok(shown.includes('Agent: Antigravity'), shown.join(' | '));
  for (const word of ['cwd:', 'mode:', 'pixel', 'C:\\Users', 'bridge default']) {
    assert.deepEqual(shown.filter(t => t.includes(word)), [], `${word} is not on the window`);
  }

  v.run('LIGHT().scripts.OnEnter(LIGHT())');
  const tip = v.get('GameTooltip.text');
  assert.ok(tip.includes('cwd: C:\\Users\\pedro\\wow-mentor (bridge default)'), tip);
  assert.ok(tip.includes('mode: pixel'), tip);
});
