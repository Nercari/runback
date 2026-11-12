'use strict';
// Backlog 80: `/ai look` with no text asks about the screen with a default question,
// typed or through the key binding, instead of printing a usage line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, orderedOnly } = require('../toc_load');

function vm() {
  return createAddonVM({
    strictLoad: true,
    files: orderedOnly('Codec.lua', 'Inbox.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua', 'Runback.lua', 'Forever_Keys.lua'),
    beforeLoad: 'unpack = table.unpack',
    afterLoad: 'STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers(); Runback.IsConnected = function() return true end',
  });
}
const sent = v => ({
  cmd: v.get('RunbackDB.outbox and RunbackDB.outbox.cmd'),
  text: Buffer.from(v.get('RunbackDB.outbox and RunbackDB.outbox.text or ""'), 'hex').toString(),
  prints: v.get('table.concat(STUB.prints, "|")'),
});

test('/ai look alone asks about the screen with a default question', () => {
  const v = vm();
  v.run('SlashCmdList.RUNBACK("look")');
  const out = sent(v);
  assert.equal(out.cmd, 'look');
  assert.equal(out.text, "What's on my screen?");
  assert.doesNotMatch(out.prints, /Usage: \/ai look/);
});

test('/ai look with text still sends that text', () => {
  const v = vm();
  v.run('SlashCmdList.RUNBACK("look what is this mob?")');
  assert.deepEqual([sent(v).cmd, sent(v).text], ['look', 'what is this mob?']);
});

test('the look key binding with nothing typed sends the default question', () => {
  const v = vm();
  v.run('RunbackForeverKeys.Run("look")');
  assert.equal(v.get('RunbackInput:GetText()'), '/ai look ');
  v.run('RunbackInput.scripts.OnEnterPressed(RunbackInput)');
  assert.deepEqual([sent(v).cmd, sent(v).text], ['look', "What's on my screen?"]);
});

test('/ai council alone still asks for its question', () => {
  const v = vm();
  v.run('SlashCmdList.RUNBACK("council")');
  assert.match(sent(v).prints, /Usage: \/ai council <text>/);
  assert.equal(sent(v).cmd, 'nil');
});

// Backlog 84: Nercari pressed Print Screen, typed "look!" in the box and pressed Send; it went to
// the agent as a plain message. A lone "look" in the box is the look command.
// A fresh client per line: one message in flight blocks the next send.
const typed = (v, line) => {
  v.run(`RunbackInput:SetText(${JSON.stringify(line)}); Runback.SendFromInput()`);
  const out = sent(v);
  return [out.cmd, out.text];
};

test('a lone "look" typed in the box asks about the screen', () => {
  for (const line of ['look', 'look!', 'Look.', '  LOOK?! ', 'look at this', 'Look at my screen!', 'look  at  my  screen']) {
    assert.deepEqual(typed(vm(), line), ['look', "What's on my screen?"], line);
  }
});

test('a message that only starts with "look" stays a message', () => {
  for (const line of ['look at the boss mechanics in Deadmines', 'looking for group', 'look at this mob?', 'lookup', 'where should I look for copper?']) {
    assert.deepEqual(typed(vm(), line), ['nil', line], line);
  }
});

test('/look in the box runs look, with or without a question', () => {
  assert.deepEqual(typed(vm(), '/look'), ['look', "What's on my screen?"]);
  assert.deepEqual(typed(vm(), '/LOOK what is this mob?'), ['look', 'what is this mob?']);
  const v = vm();
  typed(v, '/help');
  assert.match(v.get('Runback.internal.ActiveChat().history[#Runback.internal.ActiveChat().history].text'), /\/look \[question\]/);
});
