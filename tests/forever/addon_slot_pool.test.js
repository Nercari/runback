'use strict';
// Backlog 77: a reply must not be stranded when the slot pool runs out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddonVM, onlyFiles } = require('../toc_load');

function vm() {
  return createAddonVM({
    strictLoad: true,
    only: onlyFiles(['Codec.lua', 'Inbox.lua', 'Runback.lua', 'Forever.lua']),
    afterLoad: `function BUTTON(label)
    for _, f in ipairs(STUB.frames) do
      if f.kind == "Button" and f.text == label and f.shown then return f end
    end
  end`,
  });
}

const slot = replies => `STUB.onLoadAddOn = function() Runback_SlotData = { now = time(), cwd = "", agent = "agy", agents = { "claude", "agy" }, replies = { ${replies || ''} } } end`;

test('slot pool used up with a reply pending: the status says to click Get reply, the stall offer stays, only the click reloads', () => {
  const v = vm();
  v.run('STUB.FireEvent("ADDON_LOADED", "Runback"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  v.run(slot());
  v.run('STUB.now = STUB.now + 6; STUB.Tick()');
  v.run('Runback.Send("how do I get to Undercity?")');
  const chatId = v.get('RunbackDB.chats[1].id');
  const id = v.get('RunbackDB.chats[1].pendingId');
  v.run(slot(`{ chat = "${chatId}", id = ${id}, status = "working", text = "read a", stall = "quiet" }`));
  v.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(v.get('RunbackDB.chats[1].stall'), 'quiet');

  // Every slot addon is now loaded: the next poll finds no free slot.
  v.run('C_AddOns.IsAddOnLoaded = function() return true end; STUB.texts = {}');
  for (let i = 0; i < 10; i++) v.run('STUB.now = STUB.now + 30; STUB.Tick(); STUB.RunTimers()');

  const status = v.get('table.concat(STUB.texts, "\\n")').split('\n').filter(t => /slot/i.test(t)).at(-1);
  assert.equal(status, 'Antigravity has gone quiet. Out of reply slots: click Get reply to check for your reply (the game UI reloads)');
  assert.equal(v.get('BUTTON("Stop") ~= nil'), 'true', 'Stop still shows');
  assert.equal(v.get('BUTTON("Ask Claude instead") ~= nil'), 'true', 'Ask Claude instead still shows');
  assert.equal(v.get('BUTTON("Get reply") ~= nil'), 'true', 'a Get reply button shows');
  assert.equal(v.get('BUTTON("Reload") == nil'), 'true', 'no second reload button');
  assert.equal(v.get('STUB.reloaded == true'), 'false', 'timers and ticks never reload');

  v.run('BUTTON("Get reply").scripts.OnClick(BUTTON("Get reply"))');
  assert.equal(v.get('STUB.reloaded == true'), 'true', 'the click reloads');
});
