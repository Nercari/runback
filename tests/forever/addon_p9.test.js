'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const addon = path.join(__dirname, '..', '..', 'addon', 'WoWAI');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
function vm(skinOn = true, missingTexture = '', startCombat = false) {
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
  run('unpack = table.unpack; STUB.gear = {}; GetInventoryItemLink = function(_, slot) return STUB.gear[slot] end');
  const modules = ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'Forever_Lockout.lua',
    'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua'];
  for (const file of modules) run(read(file));
  run(read('WoWAI.lua')); run(read('Forever_Skin.lua')); run(read('Forever_Keys.lua'));
  run(`
    STUB.FireEvent("ADDON_LOADED", "WoWAI")
    STUB.missingTexture = [=[${missingTexture}]=]
    STUB.bindings["CTRL-SHIFT-R"] = "EXISTING_ACTION"
    STUB.combat = ${startCombat}
    WoWAIForeverDB = { skin = { enabled = ${skinOn} } }
    STUB.FireEvent("PLAYER_LOGIN")
    STUB.RunTimers()`);
  return { run, get };
}

test('skin applies classic frame art and missing textures safely fall back', () => {
  const v = vm(true, 'Interface\\DialogFrame\\UI-DialogBox-Header');
  assert.match(v.get('WoWAIFrame.backdrop.edgeFile'), /UI-DialogBox-Border/);
  assert.equal(v.get('STUB.missingHit'), 'true');
  assert.equal(v.get('WoWAIForeverMinimap ~= nil'), 'true');
  assert.equal(v.get('WoWAIForeverMinimap.unreadDot.shown'), 'false');
  // The copy box's solid fill sits inside the wider dialog border.
  v.run('WoWAI.ShowCopy("x")');
  assert.equal(v.get('WoWAICopyFill.x'), '-11');
});

test('skinned windows keep a solid opaque fill under the content (backlog 53)', () => {
  const v = vm(true);
  for (const name of ['WoWAIFrame', 'WoWAIMini']) {
    assert.equal(v.get(`${name}.wowaiSolidFill ~= nil`), 'true', `${name} has a solid fill`);
    assert.equal(v.get(`${name}.wowaiSolidFill.color[4]`), '1', `${name} fill is opaque`);
    assert.equal(v.get(`${name}.wowaiSolidFill.x`), '-11', `${name} fill sits inside the dialog border`);
  }
  // A re-skin (login again) must not stack a second fill.
  const before = v.get('#WoWAIFrame.textures') + '/' + v.get('#WoWAIMini.textures');
  v.run('STUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(v.get('#WoWAIFrame.textures') + '/' + v.get('#WoWAIMini.textures'), before);
  // The copy box reuses its own fill instead of adding another.
  v.run('WoWAI.ShowCopy("x")');
  assert.equal(v.get('WoWAICopy.wowaiSolidFill == WoWAICopyFill'), 'true');
  assert.equal(v.get('WoWAICopy.wowaiSolidFill.color[4]'), '1');
  // With the skin off, nothing is added.
  const off = vm(false);
  assert.equal(off.get('WoWAIFrame.wowaiSolidFill == nil'), 'true');
});

test('speakers use class, gold and system colours', () => {
  const v = vm();
  v.run(`
    local c = WoWAI.internal.ActiveChat()
    WoWAI.internal.AddHistory(c, "user", "hello")
    WoWAI.internal.AddHistory(c, "assistant", "reply")
    WoWAI.internal.AddHistory(c, "system", "note")
    WoWAI.Render()`);
  assert.equal(v.get('WoWAIContent.children[1].who.textColor[1]'), '0.67');
  assert.equal(v.get('WoWAIContent.children[2].who.textColor[2]'), '0.82');
  assert.equal(v.get('WoWAIContent.children[3].who.textColor[1]'), '1');
  assert.equal(v.get('WoWAIContent.children[3].who.textColor[2]'), '1');
});

test('minimap toggles, opens mentor chat, saves drag angle and clears unread on open', () => {
  const v = vm();
  v.run('WoWAIForeverMinimap.scripts.OnClick(WoWAIForeverMinimap, "LeftButton")');
  assert.equal(v.get('WoWAIFrame:IsShown()'), 'true');
  v.run('SlashCmdList.WOWAI("minimap off")');
  assert.equal(v.get('WoWAIForeverMinimap:IsShown()'), 'false');
  v.run('SlashCmdList.WOWAI("minimap on")');
  assert.equal(v.get('WoWAIForeverMinimap:IsShown()'), 'true');
  v.run('WoWAI.NewChat("Mentor"); WoWAIForeverMinimap.scripts.OnClick(WoWAIForeverMinimap, "RightButton")');
  assert.equal(v.get('WoWAIDB.chats[2].id == WoWAIDB.activeChat'), 'true');
  v.run(`WoWAIForeverMinimap.x = 0
    WoWAIForeverMinimap.y = 20
    WoWAIForeverMinimap.scripts.OnDragStop(WoWAIForeverMinimap)`);
  assert.equal(v.get('math.floor(WoWAIForeverDB.skin.minimapAngle)'), '90');
  v.run(`
    WoWAI.Toggle(false)
    for _, mod in ipairs(WoWAIForever.modules) do
      if mod.name == "skin" then mod.onReply({}, { status = "done" }) end
    end`);
  assert.equal(v.get('WoWAIForeverMinimap.unreadDot.shown'), 'true');
  v.run('WoWAI.Toggle(true)');
  assert.equal(v.get('WoWAIForeverMinimap.unreadDot.shown'), 'false');
});

test('the minimap button sits on the rim at any minimap size', () => {
  const v = vm();
  const radiusOf = () => Math.hypot(Number(v.get('WoWAIForeverMinimap.x')), Number(v.get('WoWAIForeverMinimap.y')));
  // The default 140px minimap keeps the old radius of 80.
  v.run('Minimap.width = 140; WoWAIForeverMinimap.scripts.OnShow(WoWAIForeverMinimap)');
  assert.ok(Math.abs(radiusOf() - 80) < 1e-6);
  // A bigger or smaller minimap moves the button with the rim (re-placed when shown again).
  v.run('Minimap.width = 200; WoWAIForeverMinimap.scripts.OnShow(WoWAIForeverMinimap)');
  assert.ok(Math.abs(radiusOf() - 110) < 1e-6);
  v.run('Minimap.width = 100; WoWAIForeverMinimap.scripts.OnShow(WoWAIForeverMinimap)');
  assert.ok(Math.abs(radiusOf() - 60) < 1e-6);
  // A minimap that reports no size yet (early at login) falls back to the default rim.
  v.run('Minimap.width = 0; WoWAIForeverMinimap.scripts.OnShow(WoWAIForeverMinimap)');
  assert.ok(Math.abs(radiusOf() - 80) < 1e-6);
  // Dragging re-places it on the rim of the current size, at the saved angle.
  v.run('Minimap.width = 200; WoWAIForeverMinimap.x = 0; WoWAIForeverMinimap.y = 20; WoWAIForeverMinimap.scripts.OnDragStop(WoWAIForeverMinimap)');
  assert.ok(Math.abs(radiusOf() - 110) < 1e-6);
  assert.equal(v.get('math.floor(WoWAIForeverDB.skin.minimapAngle)'), '90');
});

test('skin off leaves upstream backdrop and creates no minimap button', () => {
  const v = vm(false);
  assert.match(v.get('WoWAIFrame.backdrop.edgeFile'), /UI-Tooltip-Border/);
  assert.equal(v.get('WoWAIForeverMinimap == nil'), 'true');
  v.run('WoWAI.ShowCopy("x")');
  assert.equal(v.get('WoWAICopyFill.x'), '-4');
});

test('keys never bind anything; the hint names free and taken defaults once', () => {
  const v = vm();
  assert.equal(v.get('STUB.bindings["CTRL-SHIFT-A"] == nil'), 'true');
  assert.equal(v.get('STUB.bindings["CTRL-SHIFT-R"]'), 'EXISTING_ACTION');
  const all = v.get('table.concat(STUB.prints, " ")');
  assert.match(all, /Keybindings > AddOns > WoW AI/);
  assert.match(all, /Suggested \(free\): Ctrl\+Shift\+A Open or close the AI window/);
  assert.match(all, /Already in use: Ctrl\+Shift\+R Review my last fight/);
  assert.equal(v.get('WoWAIForeverDB.keys.hinted'), '1');
  const before = Number(v.get('#STUB.prints'));
  v.run('for _, mod in ipairs(WoWAIForever.modules) do if mod.name == "keys" then mod.init() end end');
  assert.equal(Number(v.get('#STUB.prints')), before);
  v.run('STUB.bindings["CTRL-SHIFT-A"] = "WOWAI_TOGGLE"; SlashCmdList.WOWAI("keys")');
  assert.match(v.get('table.concat(STUB.prints, " ")'), /Open or close the AI window: CTRL-SHIFT-A/);
});

test('bindings XML names each known action and input cycles chats and message history', () => {
  const xml = read('Bindings.xml');
  const names = [...xml.matchAll(/<Binding name="WOWAI_([A-Z]+)"/g)].map(m => m[1].toLowerCase());
  assert.deepEqual(names.sort(), ['death', 'focus', 'look', 'mentor', 'review', 'send', 'switch', 'toggle'].sort());
  assert.match(xml.trim(), /^<Bindings>[\s\S]*<\/Bindings>$/);
  const v = vm();
  for (const name of names) assert.equal(v.get(`_G["BINDING_NAME_WOWAI_${name.toUpperCase()}"] ~= nil`), 'true');
  v.run(`WoWAIInput:SetText("remember me")
    WoWAIInput.scripts.OnEnterPressed(WoWAIInput)
    WoWAIInput.scripts.OnArrowPressed(WoWAIInput, "UP")`);
  assert.equal(v.get('WoWAIInput:GetText()'), 'remember me');
  v.run(`WoWAIForeverKeys.Run("look")
    WoWAIInput:SetText("/ai look what is this?")
    STUB.combat = true
    WoWAIInput.scripts.OnEnterPressed(WoWAIInput)`);
  assert.match(v.get('WoWAIDB.chats[1].history[#WoWAIDB.chats[1].history].text'), /AI paused in combat/);
  v.run('WoWAI.NewChat("second"); WoWAIInput.scripts.OnTabPressed(WoWAIInput)');
  assert.equal(v.get('WoWAIDB.chats[1].id == WoWAIDB.activeChat'), 'true');
});
