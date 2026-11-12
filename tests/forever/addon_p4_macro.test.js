'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM } = require('../toc_load');

const MACRO_STUB = `
STUB.macros = {}
STUB.macroIndices = {}

function CreateMacro(name, icon, body, isLocal)
  table.insert(STUB.macros, { name = name, icon = icon, body = body, isLocal = isLocal })
  STUB.macroIndices[name] = #STUB.macros
  return #STUB.macros
end

function EditMacro(index, name, icon, body)
  STUB.macros[index] = { name = name, icon = icon, body = body }
  return index
end

function GetMacroIndexByName(name)
  return STUB.macroIndices[name] or 0
end
`;

function newVM(extra) {
  return createAddonVM({
    strictLoad: true,
    until: 'Forever_Banner.lua',
    chunkName: 'Runback',
    beforeLoad: extra ? `${MACRO_STUB}\n${extra}` : MACRO_STUB,
  });
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "Runback")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
}

function dispatchReply(vm, text) {
  vm.run(`
    for _, mod in ipairs(RunbackForever.modules) do
      if mod.name == "macro" and mod.onReply then
        mod.onReply({}, { status = "done", text = [=[${text}]=] })
      end
    end
  `);
}

function clickMacroButton(vm, index) {
  index = index || 1;
  vm.run(`
    local count = 0
    for _, child in ipairs(RunbackMacroFrame.children or {}) do
      if child.kind == "Button" and child.shown then
        count = count + 1
        if count == ${index} then
          child.scripts.OnClick(child)
          break
        end
      end
    end
  `);
}

test('macro block parse builds button and creates new macro', () => {
  const vm = newVM();
  login(vm);

  const reply = 'Here is your charge macro:\n```macro name=ChargeMe icon=Spell_Nature_Swiftness\n/cast Charge\n/startattack\n```\nEnjoy!';
  dispatchReply(vm, reply);

  assert.equal(vm.evaluate('RunbackMacroFrame.shown'), 'true');
  clickMacroButton(vm, 1);

  assert.equal(vm.num('#STUB.macros'), 1);
  assert.equal(vm.evaluate('STUB.macros[1].name'), 'ChargeMe');
  assert.equal(vm.evaluate('STUB.macros[1].icon'), 'Spell_Nature_Swiftness');
  assert.equal(vm.evaluate('STUB.macros[1].body'), '/cast Charge\n/startattack');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Created macro ChargeMe'));
});

test('macro creation refused in combat', () => {
  const vm = newVM();
  login(vm);

  const reply = '```macro name=CombatMacro\n/cast Bloodlust\n```';
  dispatchReply(vm, reply);

  // Set in combat
  vm.run('InCombatLockdown = function() return true end');
  clickMacroButton(vm, 1);

  assert.equal(vm.num('#STUB.macros'), 0);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes("Can't create macros in combat"));
});

test('macro body over 255 characters is refused', () => {
  const vm = newVM();
  login(vm);

  const longBody = '/cast Spell\n'.repeat(30); // > 255 chars
  const reply = '```macro name=BigMacro\n' + longBody + '\n```';
  dispatchReply(vm, reply);

  clickMacroButton(vm, 1);
  assert.equal(vm.num('#STUB.macros'), 0);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Macro body exceeds 255 characters'));
});

test('macro bodies with /run, /script, /console, /dump are rejected', () => {
  const vm = newVM();
  login(vm);

  for (const cmd of ['/run DoSomething()', '/script ReloadUI()', '/console fov 90', '/dump target']) {
    vm.run('STUB.prints = {}');
    const reply = '```macro name=Bad\n' + cmd + '\n```';
    dispatchReply(vm, reply);
    clickMacroButton(vm, 1);
    assert.equal(vm.num('#STUB.macros'), 0);
    assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Macro rejected: contains'));
  }
});

test('existing macro shows overwrite popup and updates on accept', () => {
  const vm = newVM();
  login(vm);

  // Pre-create macro "TestMacro"
  vm.run('CreateMacro("TestMacro", "INV_Sword_01", "/dance", nil)');
  assert.equal(vm.num('#STUB.macros'), 1);

  const reply = '```macro name=TestMacro icon=INV_Sword_02\n/cheer\n```';
  dispatchReply(vm, reply);

  clickMacroButton(vm, 1);
  // StaticPopup should be shown
  assert.equal(vm.evaluate('STUB.popup.which'), 'RUNBACK_OVERWRITE_MACRO');
  assert.equal(vm.evaluate('STUB.popup.data.name'), 'TestMacro');

  // Accept dialog
  vm.run('StaticPopupDialogs["RUNBACK_OVERWRITE_MACRO"].OnAccept({}, STUB.popup.data)');
  assert.equal(vm.evaluate('STUB.macros[1].body'), '/cheer');
  assert.equal(vm.evaluate('STUB.macros[1].icon'), 'INV_Sword_02');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Macro TestMacro updated'));
});
