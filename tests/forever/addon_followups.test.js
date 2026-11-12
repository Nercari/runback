'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, onlyFiles } = require('../toc_load');

function vm() {
  return createAddonVM({
    strictLoad: true,
    only: onlyFiles(['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua', 'Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Commands.lua']),
    beforeLoad: 'unpack = table.unpack',
    afterLoad: `STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()
Runback.IsConnected = function() return true end
function CLICK(label)
  for _, f in ipairs(STUB.frames) do
    if f.kind == "Button" and f.text == label then f.scripts.OnClick(f); return true end
  end
  error("no button labelled " .. label)
end`,
  });
}
const outbox = v => v.get('RunbackDB.outbox and RunbackDB.outbox.cmd');
const reply = (v, followUps = ['What should I buy first?', 'Which talent next?']) => v.run(`local c = RunbackDB.chats[1]
  table.insert(c.history, { role = "assistant", text = "Use Shadow Bolt.", t = time(), followUps = { ${followUps.map(q => JSON.stringify(q)).join(', ')} } })
  Runback.Toggle(true); Runback.Render()`);
const shown = v => v.get('table.concat(STUB.texts, "|")');
const visible = (v, label) => v.get(`(function() for _, f in ipairs(STUB.frames) do if f.kind == "Button" and f.text == ${JSON.stringify(label)} and f.shown then return true end end return false end)()`);

test('follow-up buttons are the mentor\'s suggestions under the newest finished reply; a click fills the box and sends nothing', () => {
  const v = vm();
  reply(v);
  assert.equal(visible(v, 'What should I buy first?'), 'true');
  assert.equal(visible(v, 'Which talent next?'), 'true');
  assert.equal(visible(v, 'Review my last fight'), 'false', 'the old fixed buttons are gone');
  v.run('CLICK("Which talent next?")');
  assert.ok(shown(v).includes('Which talent next?'), 'typed into the box');
  assert.equal(v.get('RunbackDB.chats[1].pendingId'), 'nil', 'nothing sent by itself');
  assert.equal(outbox(v), 'nil');
});

test('a reply without suggestions shows no buttons; at most two show even if more arrive', () => {
  let v = vm();
  reply(v, []);
  assert.equal(visible(v, 'What should I buy first?'), 'false');
  v = vm();
  reply(v, ['one?', 'two?', 'three?']);
  assert.equal(visible(v, 'one?'), 'true');
  assert.equal(visible(v, 'two?'), 'true');
  assert.equal(visible(v, 'three?'), 'false');
});

test('no follow-ups in combat or while a reply is pending', () => {
  let v = vm();
  v.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  reply(v);
  const fb = () => visible(v, 'What should I buy first?');
  assert.equal(fb(), 'false');
  v.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED"); Runback.Render()');
  assert.equal(fb(), 'true', 'back after the fight');
});
