// Runs the real addon Lua (Codec.lua + Runback.lua) in a Lua VM with a stub
// WoW API (wow_stub.lua) and drives it through a session: login, hello, a sent
// message read back off the pixel strip, a reply delivered through a slot, the
// bridge's default folder and agent, a chat that picks another agent, a
// permission denial with Allow, and a restore.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'Runback');
const CELLS_PER_ROW = 200;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Evaluate an expression and bring it back as a string (or nil).
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'Inbox.lua', 'Forever.lua', 'Runback.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'Runback');
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm) {
  if (vm.evaluate('RunbackStrip and RunbackStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(RunbackStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7); assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
  assert.equal(bytes[6 + len], s1, 'fletcher s1'); assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripRecords(vm) {
  const frame = decodeStrip(vm);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    const withCtx = p[4].split(';').includes('c'); // a "c" flag means field 7 is the game context
    const rec = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F') };
    if (withCtx) rec.ctx = p[6];
    return rec;
  });
}

// Make the next LoadAddOn deliver this slot data (a Lua table literal body).
function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) Runback_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "Runback")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Let the bridge answer the login hello: its slot carries a fresh clock, which is
// what makes the addon consider itself connected (Send is gated on that).
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true', 'connected after the hello slot');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#RunbackDB.chats'), 1);
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('RunbackFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('RunbackMini ~= nil'), 'true');
  assert.equal(vm.num('#STUB.tickers'), 1);
  assert.equal(vm.evaluate('SlashCmdList.RUNBACK ~= nil'), 'true');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(i => vm.evaluate('SLASH_RUNBACK' + i)), ['/runback', '/wowai', '/wow-ai', '/wow-claude', '/ai', '/ask'], 'the old command name and the short forms are aliases');
  assert.equal(vm.evaluate('SlashCmdList.RUNBACKASK'), null, '/ai is an alias of the one command, not a handler of its own');
});

test('hello goes out on the strip after login', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  const recs = stripRecords(vm);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].flags, 'h;c', 'a hello always carries the game context');
  assert.equal(recs[0].text, '');
  assert.equal(recs[0].session, vm.evaluate('RunbackDB.session'));
});

test('outbound records replace field separators inside user text', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Send("wire" .. string.char(30, 31) .. "safe")');
  const rec = stripRecords(vm).find(r => r.text === 'wire  safe');
  assert.ok(rec, 'the record keeps the full message as one wire field');
});

test('the game context describes the character and rides on the hello, then only when it changes or is turned off', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm)[0];
  assert.deepEqual(hello.ctx.split('\n'), [
    'Game: World of Warcraft: Forever (client 1.60.1.69913, interface 16001)',
    'Character: Testchar on Test Realm, level 23 Night Elf Hunter (Alliance), guild <Test Guild>',
    'Location: Duskwood - Darkshire',
    'Position: 45.2, 67.8 (map 1431)',
    'Money: 1g 23s 45c; XP: 1234/5000',
    'Talents: Beast Mastery 10 / Marksmanship 5 / Survival 0',
    'Professions: Skinning 75/75, First Aid 40/75',
  ]);
  // The bridge answers the hello: the context is now known to be on its side.
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  vm.run('Runback.Send("hello world")');
  let rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.equal(rec.flags, '', 'unchanged context is not repeated');
  assert.equal(rec.ctx, undefined);
  assert.equal(vm.evaluate('RunbackDB.outbox.ctx'), null);
  // Moving to another zone changes it, so the next message (from another chat,
  // the first one is still waiting) carries the new version.
  vm.run('STUB.zone = "Elwynn Forest"; STUB.subzone = ""; STUB.posX = 0.1; Runback.NewChat("Second"); Runback.Send("where am I")');
  rec = stripRecords(vm).find(r => r.text === 'where am I');
  assert.equal(rec.flags, 'c');
  assert.ok(rec.ctx.includes('Location: Elwynn Forest\n'), rec.ctx);
  assert.ok(rec.ctx.includes('Position: 10.0, 67.8 on Duskwood (map 1431)'), 'the map name shows when it differs from the zone');
  assert.equal(Buffer.from(vm.evaluate('RunbackDB.outbox.ctx'), 'hex').toString('utf8'), rec.ctx, 'the reload path carries it too');
  // Turning it off sends an empty context at once (a hello), so the bridge drops what it had.
  vm.run('SlashCmdList.RUNBACK("context off")');
  assert.equal(vm.evaluate('RunbackDB.settings.context'), 'false');
  const off = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.equal(off.length, 1);
  assert.equal(off[0].ctx, '');
  assert.ok(vm.evaluate('RunbackDB.chats[2].history[#RunbackDB.chats[2].history].text').includes('Game context is OFF'));
  // Back on: another hello, with the context again.
  vm.run('SlashCmdList.RUNBACK("context on")');
  const on = stripRecords(vm).filter(r => r.flags === 'h;c');
  assert.ok(on.some(r => r.ctx.includes('Character: Testchar')));
  assert.ok(vm.evaluate('RunbackDB.chats[2].history[#RunbackDB.chats[2].history].text').includes('Game context is ON'));
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(`STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`);
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`RunbackInput:SetText("is this good for me? "); RunbackInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('RunbackInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`RunbackInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('RunbackInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('RunbackInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`RunbackInput:SetText("is this good for me? ${link}")`);
  vm.run('Runback.SendFromInput()');
  const expected = [
    'is this good for me? [Fine Longsword]',
    '',
    '--- Linked from the game ---',
    '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword',
    '  Main Hand  Sword',
    '  17 - 33 Damage  Speed 2.70',
    '  Requires Level 14',
  ].join('\n');
  const rec = stripRecords(vm).find(r => r.text.startsWith('is this good'));
  assert.equal(rec.text, expected);
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (Runback.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run('RESULT, COUNT = Runback.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('deleting a chat tells the bridge to forget it, and a restore never brings it back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.NewChat("Second")');
  assert.equal(vm.num('#RunbackDB.chats'), 2);
  const gone = vm.evaluate('RunbackDB.chats[2].id');
  vm.run(`Runback.DeleteChat("${gone}")`);
  assert.equal(vm.num('#RunbackDB.chats'), 1);
  // A forget record for that chat is on the strip and remembered until acked.
  const rec = stripRecords(vm).find(r => r.flags === 'd');
  assert.ok(rec, 'forget record on the strip');
  assert.equal(rec.chat, gone);
  assert.equal(rec.text, '');
  assert.equal(vm.evaluate(`RunbackDB.forget["${gone}"] ~= nil`), 'true');
  // A restore that still lists the chat is ignored for it.
  const token = vm.evaluate('RunbackDB.session');
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, restore = { token = "${token}", chats = { { id = "${gone}", name = "Second", cwd = "", messages = { { role = "user", text = "old", id = 1, t = 1 } } } } } }`);
  vm.run('Runback.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#RunbackDB.chats'), 1, 'deleted chat not restored');
  // The bridge acks the forget record: it leaves the strip and the memory.
  const slot = String(rec.id).padStart(3, '0');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\Runback\\\\ack\\\\${slot}.wav"] = true; STUB.Tick()`);
  assert.equal(vm.evaluate(`RunbackDB.forget["${gone}"]`), null, 'forgotten once acked');
  assert.ok(!stripRecords(vm).find(r => r.flags === 'd'), 'forget record left the strip');
});

test('until the bridge answers, Connect replaces Send and a message stays in the box', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'false');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('Not connected - start the bridge, then click Connect'));
  // Sending while disconnected puts the text back in the box and starts a connect attempt.
  vm.run('RunbackInput:SetText("fix the bug"); Runback.SendFromInput()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'nothing sent');
  assert.equal(vm.evaluate('RunbackInput:GetText()'), 'fix the bug', 'message kept in the box');
  const hello = stripRecords(vm);
  assert.equal(hello.length, 1);
  assert.equal(hello[0].flags, 'h;c', 'a hello went out instead');
  assert.ok(texts().includes('Connecting...'));
  assert.ok(texts().includes('your message goes out as soon as it answers'));
  // No answer within CONNECT_WAIT: the attempt is reported as failed, Connect is back.
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'false');
  assert.ok(texts().includes('No answer from the bridge'));
  assert.equal(vm.evaluate('RunbackInput:GetText()'), 'fix the bug', 'message still in the box after a failed attempt');
  // Click Connect again; this time the bridge answers the hello poll. Nothing was
  // queued by that click, so the message waits for the user.
  vm.run('Runback.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'a plain Connect sends nothing by itself');
  vm.run('Runback.SendFromInput()');
  assert.ok(vm.num('RunbackDB.chats[1].pendingId') >= 1, 'the kept message goes out once connected');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
});

test('a message sent while disconnected goes out by itself once the bridge answers', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  vm.run('RunbackInput:SetText("fix the bug"); Runback.SendFromInput()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'nothing sent yet');
  // The bridge answers the hello poll: the queued message follows without a second click.
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  assert.ok(vm.num('RunbackDB.chats[1].pendingId') >= 1, 'queued message went out on connect');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
  assert.equal(vm.evaluate('RunbackInput:GetText()'), '', 'box cleared after the auto-send');
  // Only once: a later reconnect sends nothing.
  vm.run('Runback.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(stripRecords(vm).filter(r => r.text === 'fix the bug').length, 1);
});

test('without the sound channel, idle time costs no slots and the light says it is not checking', () => {
  // The stub has no ctl/valid.wav, so the login self-test disables the sound
  // channel: the addon is in "slot checks only" mode, like a client whose
  // PlaySoundFile reports every file as playable.
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('Runback.BridgeState()'), 'ok');
  // 90 s of silence used to mean "stale"; with no beats to hear that is normal.
  vm.run('STUB.loadCount = 0; STUB.onLoadAddOn = function(name) STUB.loadCount = STUB.loadCount + 1; Runback_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.BridgeState()'), 'ok', 'still green after 200 s');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  // Past the 12-minute window, idle: no slot is read (the bridge's clock in it
  // would only repeat its last write), so the light says "not checked", not stale.
  vm.run('STUB.now = STUB.now + 1800; STUB.Tick()');
  assert.equal(vm.num('STUB.loadCount'), 0, 'no idle slot polls');
  assert.equal(vm.evaluate('Runback.BridgeState()'), 'idle');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true', 'Send stays; no Reconnect click');
  // A bridge that really is gone still shows once a message waits: no slot answers, and the light drops.
  vm.run('STUB.onLoadAddOn = function(name) Runback_SlotData = nil end');
  vm.run('Runback.Send("anyone there?")');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.BridgeState()'), 'down');
});

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /runback cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'RUNBACK_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.RUNBACK_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('RunbackDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('relative to'));
  vm.run('Runback.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('Runback.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('relative to'));
  vm.run('Runback.SetFolder("")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.RUNBACK("cd realms")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].cwd'), 'realms');
  vm.run('Runback.Send("hello world")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  assert.equal(rec.flags, '');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Hello world');

  vm.run('Runback.Toggle(false)'); // window closed: the reply is echoed to the game chat
  nextSlot(vm, `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "hi back", cwd = "x", session = "s" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('RunbackStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/runback cd" reports.
  vm.run('SlashCmdList.RUNBACK("cd")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('C:\\proj'));
});

test('while the agent works: one timer (the status line) and an action count that matches the listed actions', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Send("hello")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  vm.run('STUB.texts = {}');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "working", text = "read a\\nread b\\ngrep c\\nedit d\\nread e\\nread f" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const texts = vm.evaluate('table.concat(STUB.texts, "|")').split('|');
  const running = texts.filter(t => t.includes('running '));
  assert.ok(running.length > 0, 'the status line shows the timer');
  assert.ok(running.every(t => t.includes('is working - ')), 'only the status line carries a timer: ' + running.join(' / '));
  assert.ok(running.some(t => t.includes('6 actions')), running.join(' / '));
  assert.ok(!texts.some(t => t.includes('0 actions')), 'never "0 actions" above a list of six');
  assert.ok(texts.some(t => t.startsWith('working...') && t.includes('read a') && !t.includes('running ')), 'the working bubble lists the actions without a second timer');
  assert.ok(!texts.some(t => /is working|Sending|Waiting for/.test(t) && t.startsWith('working...')), 'the working bubble does not repeat the status line');
  assert.ok(!texts.some(t => /#\d/.test(t) && /working|Sending|Waiting/.test(t)), 'no internal ids in the status line');
  vm.run('STUB.texts = {}; STUB.now = STUB.now + 70; STUB.Tick()');
  const later = vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(!later.includes('no activity seen yet'), 'no "no activity seen yet" next to a listed action count');
});

test('a denied reply shows Allow, and Allow resends with the rules as flags', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Send("search for it")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = { "WebSearch", "Bash(cargo:*)" } } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].denied[2]'), 'Bash(cargo:*)');
  vm.run(`Runback.Allow("${chatId}", { "WebSearch", "Bash(cargo:*)" })`);
  const rec = stripRecords(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'allow record on the strip');
  assert.equal(rec.flags, 'allow=WebSearch,Bash(cargo:*)');
  assert.equal(rec.id, id + 1);
});

test('the Allow button names tools plainly, connector tools included (backlog 81)', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Toggle(true); Runback.Send("save it to my drive")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  const denied = '{ "PowerShell", "Bash(node:*)", "mcp__claude_ai_Google_Drive__create_file", "mcp__playwright__Browser_Click", "Read(//c/Users/x/**)" }';
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "need permission", denied = ${denied} } } }`);
  vm.run('STUB.texts = {}; STUB.now = STUB.now + 6; STUB.Tick(); Runback.Render()');
  const texts = vm.evaluate('table.concat(STUB.texts, "|")').split('|');
  assert.ok(texts.includes('Allow PowerShell, node, Google Drive (create file), playwright (browser click), Read & retry'),
    texts.filter(t => t.startsWith('Allow')).join(' / ') || 'no Allow label');
});

test('the window opens at the top centre on a fresh install and where it was left afterwards', () => {
  let vm = newVM();
  login(vm);
  assert.equal(vm.num('RunbackFrame.x'), 0);
  assert.equal(vm.num('RunbackFrame.y'), -40, 'clear of the game chat');

  vm = newVM();
  vm.run('RunbackDB = { settings = { point = "LEFT", relPoint = "LEFT", x = 30, y = 12 } }');
  login(vm);
  assert.equal(vm.num('RunbackFrame.x'), 30);
  assert.equal(vm.num('RunbackFrame.y'), 12);
});

test('an empty chat offers four starter questions fitted to class and level; a click types one, sends nothing', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.level = 4');
  const q = vm.evaluate('table.concat(Runback.StarterQuestions(), "|")').split('|');
  assert.equal(q.length, 4);
  assert.ok(q[0].includes('level 4 Hunter'));
  assert.ok(q[2].includes("I'm new to the game"), 'low level: setup question');
  vm.run('STUB.level = 30');
  assert.ok(vm.evaluate('Runback.StarterQuestions()[3]').includes('gear fine for level 30'));

  connect(vm);
  vm.run('Runback.Toggle(true); Runback.Render()');
  const first = vm.evaluate('Runback.StarterQuestions()[1]');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes(first), 'the questions are drawn as buttons');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'nothing is sent by itself');
});

test('the starter card offers the fast model for short questions, once; a click switches the chat and sends nothing', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", agent = "claude", agents = { "claude" }, models = { claude = { "opus", "sonnet", "haiku" } }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('Runback.Toggle(true); Runback.Render()');
  const hint = 'Short questions? Use the fast model (haiku)';
  const shown = () => vm.evaluate('table.concat(STUB.texts, "|")').includes(hint);
  assert.equal(vm.evaluate('Runback.FastModelOffer(RunbackDB.chats[1]) ~= nil'), 'true');
  assert.ok(shown(), 'the offer is drawn as a button');
  vm.run('Runback.SetPool(RunbackDB.chats[1], "claude", "haiku")');
  assert.equal(vm.evaluate('Runback.FastModelOffer(RunbackDB.chats[1])'), null, 'nothing to offer once on haiku');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'nothing is sent by itself');
});

test('each slash command in a reply gets a copy button that opens the copy box with only that line', () => {
  const vm = newVM();
  login(vm);
  const lines = t => vm.evaluate(`table.concat(Runback.CommandLines(${JSON.stringify(t)}), "|")`);
  assert.equal(lines('Try this:\n- `/runback help`\n/who Stormwind\nplain text'), '/runback help|/who Stormwind');
  assert.equal(lines('/usr/bin/node is a path\n/run print(1)\n/script x()\n/console foo 1\n/dump x'), '', 'no paths, no script lines');
  assert.equal(lines('/runscript x()\n/RUN x\n/who and then /run x\n/who then /Script y'), '', 'a script anywhere on the line means no button');
  assert.equal(lines('/a\n/b\n/c\n/d\n/e'), '/a|/b|/c|/d', 'capped at four');

  connect(vm);
  vm.run('Runback.Toggle(true); Runback.Send("hello")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "Type this:\\n/runback echo off" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('copy: /runback echo off'), 'the button is drawn');
});

test('a reply is shown once: no chat echo while its window is open', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Toggle(true); Runback.Send("hello")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const reply = (id, text) => `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}" } } }`;
  nextSlot(vm, reply(vm.num('RunbackDB.chats[1].pendingId'), 'seen in the window'));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text'), 'seen in the window');
  assert.ok(!vm.evaluate('table.concat(STUB.prints, "\\n")').includes('seen in the window'), 'window open: not repeated in the game chat');

  vm.run('Runback.Toggle(false); Runback.Send("again")');
  nextSlot(vm, reply(vm.num('RunbackDB.chats[1].pendingId'), 'seen in chat'));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('seen in chat'), 'window closed: echoed to the game chat');
});

test('a chat can pick its agent: the strip says so, replies are labelled by their writer, unknown names are refused', () => {
  const vm = newVM();
  login(vm);
  // The hello slot carries the bridge's default agent and the ones it knows.
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "claude", agents = { "claude", "codex", "grok" }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('Agent: Claude'), 'the footer names the bridge default agent');
  // Without an agent of its own the chat sends no agent flag, and the reply is labelled Claude.
  vm.run('Runback.Send("hello")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  let rec = stripRecords(vm).find(r => r.text === 'hello');
  assert.equal(rec.flags, '');
  assert.equal(vm.evaluate('RunbackDB.outbox.agent'), null);
  const id = vm.num('RunbackDB.chats[1].pendingId');
  vm.run('Runback.Toggle(false)'); // window closed: replies are echoed to the game chat
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "done", text = "hi", agent = "claude" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].agent'), 'claude');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Claude · '), 'the game chat echo names the agent');
  // Switch this chat to Codex: the next message carries agent=codex, on both transports.
  vm.run('SlashCmdList.RUNBACK("agent Codex")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('agent set to Codex'));
  vm.run('Runback.Send("now with codex")');
  rec = stripRecords(vm).find(r => r.text === 'now with codex');
  assert.equal(rec.flags, 'agent=codex');
  assert.equal(vm.evaluate('RunbackDB.outbox.agent'), 'codex');
  assert.ok(texts().split('|').includes('Agent: Codex'), 'the footer names the chat\'s agent');
  const id2 = vm.num('RunbackDB.chats[1].pendingId');
  vm.run('Runback.Toggle(false)');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, status = "done", text = "codex here", agent = "codex" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].agent'), 'codex');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Codex · '));
  // Resend keeps the agent flag.
  vm.run('Runback.Send("again")');
  vm.run('Runback.Resend()');
  assert.equal(stripRecords(vm).find(r => r.text === 'again').flags, 'agent=codex');
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // A name the bridge did not list is refused; "default" goes back to the bridge's.
  vm.run('SlashCmdList.RUNBACK("agent gemini")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('Unknown agent "gemini"'));
  vm.run('SlashCmdList.RUNBACK("agent default")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), '');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('agent reset to the bridge\'s default: Claude'));
  // The AI picker lists the bridge default and each agent the bridge has; one click switches.
  vm.run('Runback.SetAgent("grok"); Runback.AgentPrompt()');
  assert.equal(vm.evaluate('RunbackPoolPicker.shown'), 'true');
  assert.equal(vm.evaluate('#Runback.PoolChoices()'), '4');
  vm.run(`for _, r in ipairs(RunbackPoolPicker.rows) do if r.shown and r.agent == "codex" then r.scripts.OnClick(r) end end`);
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'codex');
  assert.equal(vm.evaluate('RunbackPoolPicker.shown'), 'false');
  // A new chat inherits the agent, like the folder.
  vm.run('Runback.NewChat("Second")');
  assert.equal(vm.evaluate('RunbackDB.chats[2].agent'), 'codex');
});

test('the AI picker switches between the agents installed on the PC and their models', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  // This bridge PC has Claude (three models) and Hermes (no model list); Codex is not installed.
  const slot = replies => `{ now = time(), cwd = "", agent = "claude", agents = { "claude", "hermes" }, models = { claude = { "opus", "sonnet", "haiku" }, hermes = { } }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  assert.equal(vm.evaluate('RunbackPoolButton.text'), 'AI: Claude');
  // Rows: bridge default, Claude, Claude · opus/sonnet/haiku, Hermes.
  vm.run('RunbackPoolButton.scripts.OnClick(RunbackPoolButton)');
  assert.equal(vm.evaluate('RunbackPoolPicker.shown'), 'true');
  const labels = () => vm.evaluate('(function() local t = {} for _, r in ipairs(RunbackPoolPicker.rows) do if r.shown then t[#t + 1] = r.label.text end end return table.concat(t, "\\n") end)()');
  const rows = labels().split('\n');
  assert.equal(rows.length, 6);
  assert.match(rows[0], /> Bridge default \(Claude\)/, 'the current choice is marked');
  assert.ok(rows.some(r => r.includes('Claude · sonnet')));
  assert.ok(!labels().includes('Codex'), 'agents the PC does not have are not offered');
  // Pick Claude · sonnet: the strip and the reload outbox carry agent and model.
  vm.run(`for _, r in ipairs(RunbackPoolPicker.rows) do if r.shown and r.model == "sonnet" then r.scripts.OnClick(r) end end`);
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'claude');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), 'sonnet');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('agent set to Claude · sonnet'));
  assert.equal(vm.evaluate('RunbackPoolButton.text'), 'AI: Claude · sonnet');
  vm.run('Runback.Send("which model?")');
  assert.equal(stripRecords(vm).find(r => r.text === 'which model?').flags, 'agent=claude;model=sonnet');
  assert.equal(vm.evaluate('RunbackDB.outbox.model'), 'sonnet');
  vm.run('Runback.Resend()');
  assert.equal(stripRecords(vm).find(r => r.text === 'which model?').flags, 'agent=claude;model=sonnet');
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // Reopened, the picker marks the new choice.
  vm.run('Runback.AgentPrompt()');
  assert.ok(labels().split('\n').find(r => r.includes('> ')).includes('Claude · sonnet'));
  vm.run('Runback.AgentPrompt()');
  assert.equal(vm.evaluate('RunbackPoolPicker.shown'), 'false', 'a second click closes it');
  // Typed: /runback agent <name> <model>; unknown models are refused, the agent alone drops the model.
  vm.run('SlashCmdList.RUNBACK("agent claude haiku")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), 'haiku');
  vm.run('SlashCmdList.RUNBACK("agent claude gpt-9")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), 'haiku');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('Unknown model "gpt-9" for Claude'));
  vm.run('SlashCmdList.RUNBACK("agent hermes x")');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('Models: only its default'));
  vm.run('SlashCmdList.RUNBACK("agent codex")');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('This PC has: claude, hermes'));
  vm.run('SlashCmdList.RUNBACK("agent hermes")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'hermes');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), '');
  vm.run('Runback.Send("hi hermes")');
  assert.equal(stripRecords(vm).find(r => r.text === 'hi hermes').flags, 'agent=hermes');
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // A sentence after "agent" is a message, not a switch.
  vm.run('SlashCmdList.RUNBACK("agent claude what is my best talent")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'hermes');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].role'), 'user');
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // A new chat inherits agent and model.
  vm.run('SlashCmdList.RUNBACK("agent claude opus")');
  vm.run('Runback.NewChat("Second")');
  assert.equal(vm.evaluate('RunbackDB.chats[2].model'), 'opus');
});

test('a box line starting with / never reaches the agent: known commands run here, unknown ones get one plain line (backlog 55)', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", agent = "claude", agents = { "claude", "hermes" }, models = { claude = { "opus", "sonnet", "haiku" }, hermes = { } }, replies = { } }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('Runback.IsConnected()'), 'true');
  const last = () => vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text');
  const lastRole = () => vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].role');
  const type = line => vm.run(`RunbackInput:SetText(${JSON.stringify(line)}); Runback.SendFromInput()`);
  const sent = () => stripRecords(vm).filter(r => !r.hello);
  // /model <name> takes effect locally, like the AI picker.
  type('/model sonnet');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'claude');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), 'sonnet');
  assert.ok(last().includes('agent set to Claude · sonnet'));
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'nothing is waiting on an agent');
  // The reported case: a model name the bridge does not list is refused, not sent, and the chat keeps its name.
  type('/model 3.8 flash');
  assert.equal(vm.evaluate('RunbackDB.chats[1].model'), 'sonnet');
  assert.ok(last().includes('Unknown model "3.8 flash" for Claude'));
  assert.equal(lastRole(), 'system');
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Chat 1');
  // /model alone lists them; /agent switches the AI.
  type('/model');
  assert.ok(last().includes('Models for Claude: opus, sonnet, haiku'));
  type('/agent hermes');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'hermes');
  // Anything else is unknown: one plain line, no user message, no agent run.
  type('/foo bar');
  assert.equal(last(), 'Unknown command /foo. Type /help to see what the box understands.');
  type('/run print(1)');
  assert.ok(last().startsWith('Unknown command /run.'), 'game commands are not run from the box');
  type('/help');
  assert.ok(last().includes('/model [name]'));
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('(function() for _, m in ipairs(RunbackDB.chats[1].history) do if m.role == "user" then return true end end return false end)()'), 'false', 'no slash line was sent as a message');
  assert.equal(sent().length, 0, 'nothing went out on the strip');
  assert.equal(vm.evaluate('RunbackInput:GetText()'), '', 'the box is cleared');
  // A plain line still goes out.
  type('what talent?');
  assert.ok(sent().some(r => r.text === 'what talent?'));
});

test('replies saved under the old "claude" role are read as assistant replies from Claude', () => {
  const vm = newVM();
  vm.run('RunbackDB = { chats = { { id = "c1", name = "Old", cwd = "", history = { { role = "user", text = "q", id = 1, t = 1 }, { role = "claude", text = "a", id = 1, t = 2 } }, unread = 0, created = 1 } }, activeChat = "c1", settings = {} }');
  login(vm);
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), '');
  // Before the bridge has said which agent it runs, the label falls back to "AI".
  vm.run('Runback.Toggle(true)');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('|Claude|'), 'the old reply is labelled Claude');
});

test('free text that starts with a command word is sent as a message; exact commands still run', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const sent = text => !!stripRecords(vm).find(r => r.text === text);
  const last = () => vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text');
  // "delete the unused imports" is a message, not /runback delete; "cancel" alone is the command.
  vm.run('SlashCmdList.RUNBACK("delete the unused imports")');
  assert.equal(vm.num('#RunbackDB.chats'), 1, 'no chat deleted');
  assert.ok(sent('delete the unused imports'));
  vm.run('SlashCmdList.RUNBACK("cancel")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null, 'cancel ran as a command');
  // "help me with this macro" is a message; "help" alone prints the help.
  vm.run('SlashCmdList.RUNBACK("help me with this macro")');
  assert.ok(sent('help me with this macro'));
  vm.run('SlashCmdList.RUNBACK("cancel")');
  vm.run('SlashCmdList.RUNBACK("help")');
  assert.ok(last().includes('/runback cd'));
  // One-word arguments keep their command; more words make it a message.
  vm.run('SlashCmdList.RUNBACK("agent codex")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'codex');
  vm.run('SlashCmdList.RUNBACK("agent smith says hi")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'codex');
  assert.ok(sent('agent smith says hi'));
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // Enumerated arguments: "context off" is the command, "context matters here" a message.
  vm.run('SlashCmdList.RUNBACK("context off")');
  assert.equal(vm.evaluate('RunbackDB.settings.context'), 'false');
  vm.run('SlashCmdList.RUNBACK("context matters here")');
  assert.ok(sent('context matters here'));
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // "reset the counter" and "clear the cache" are messages; the transcript survives.
  vm.run('SlashCmdList.RUNBACK("clear the cache")');
  assert.ok(sent('clear the cache'));
  assert.ok(vm.num('#RunbackDB.chats[1].history') > 1, 'clear did not run');
  vm.run('SlashCmdList.RUNBACK("cancel")');
  vm.run('SlashCmdList.RUNBACK("reset the counter")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].resetNext'), null);
  assert.ok(sent('reset the counter'));
  vm.run('SlashCmdList.RUNBACK("cancel")');
  // A chat can still be picked by number or name; "chat with me about it" is a message.
  vm.run('SlashCmdList.RUNBACK("new Realms")');
  vm.run('SlashCmdList.RUNBACK("chat 1")');
  assert.equal(vm.evaluate('RunbackDB.activeChat'), vm.evaluate('RunbackDB.chats[1].id'));
  vm.run('SlashCmdList.RUNBACK("chat realms")');
  assert.equal(vm.evaluate('RunbackDB.activeChat'), vm.evaluate('RunbackDB.chats[2].id'));
  vm.run('SlashCmdList.RUNBACK("chat with me about it")');
  assert.ok(sent('chat with me about it'));
  // /ai alone toggles the window.
  vm.run('Runback.Toggle(false); SlashCmdList.RUNBACK("")');
  assert.equal(vm.evaluate('RunbackFrame.shown'), 'true');
});

test('/runback reset marks the next message as a new session', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.RUNBACK("reset")');
  vm.run('Runback.Send("start over")');
  const rec = stripRecords(vm).find(r => r.text === 'start over');
  assert.equal(rec.flags, 'n');
  assert.equal(vm.evaluate('RunbackDB.chats[1].resetNext'), null);
});

test('game chat echo: the summary by default, the first lines without one, the whole reply with "echo full"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('RunbackDB.settings.echo'), 'summary', 'summary echo is the default');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")');
  const reply = (text, summary) => {
    vm.run('STUB.prints = {}');
    vm.run('Runback.Send("do it")');
    const id = vm.num('RunbackDB.chats[1].pendingId');
    const sum = summary === undefined ? '' : `, summary = "${summary}"`;
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude"${sum} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  };

  // With a summary only the summary is printed; the window keeps the whole reply.
  reply('Long line one\\nLong line two\\nLong line three\\n\\nTL;DR: Renamed foo.\\nTests pass.', 'Renamed foo.\\nTests pass.');
  let out = prints();
  assert.ok(out.includes('[Claude · ') && out.includes('Renamed foo.') && out.includes('Tests pass.'), 'summary lines printed: ' + out);
  assert.ok(!out.includes('Long line one'), 'the body stays out of the game chat');
  assert.ok(out.includes('[open]'), 'the open link is there');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text').includes('Long line three'), 'the window has the full reply');

  // Without a summary: the first two lines, then a hint that there is more.
  reply('Line one\\nLine two\\nLine three\\nLine four');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line two'), 'first two lines: ' + out);
  assert.ok(!out.includes('Line three'), 'third line held back');
  assert.ok(out.includes('click [open]'), 'hint to open the window');

  // A short reply without a summary needs no hint.
  reply('Just this');
  out = prints();
  assert.ok(out.includes('Just this') && !out.includes('click [open] to read'), out);

  // "echo full" prints everything, as before.
  vm.run('SlashCmdList.RUNBACK("echo full")');
  assert.equal(vm.evaluate('RunbackDB.settings.echo'), 'full');
  reply('Line one\\nLine two\\nLine three\\n\\nTL;DR: Short.', 'Short.');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line three') && out.includes('TL;DR: Short.'), out);
  vm.run('SlashCmdList.RUNBACK("echo summary")');
  assert.equal(vm.evaluate('RunbackDB.settings.echo'), 'summary');
  vm.run('SlashCmdList.RUNBACK("echo bogus")');
  assert.equal(vm.evaluate('RunbackDB.settings.echo'), 'summary', 'an unknown mode is ignored');

  // An install that still had the old default saved moves to summary once; a mode picked on purpose stays.
  const vm2 = newVM();
  vm2.run('RunbackDB = { settings = { echo = "full" } }');
  login(vm2);
  assert.equal(vm2.evaluate('RunbackDB.settings.echo'), 'summary');
  const vm3 = newVM();
  vm3.run('RunbackDB = { settings = { echo = "short" } }');
  login(vm3);
  assert.equal(vm3.evaluate('RunbackDB.settings.echo'), 'short');
  const vm4 = newVM();
  vm4.run('RunbackDB = { settings = { echo = "full", echoV2 = true } }');
  login(vm4);
  assert.equal(vm4.evaluate('RunbackDB.settings.echo'), 'full');
});

test('a restore bundle addressed to this session adds the missing chats once', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('Runback.Send("hi")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  const token = vm.evaluate('RunbackDB.session');
  const bundle = `restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "C:\\\\old", messages = { { role = "user", id = 1, t = 1, text = "q" }, { role = "claude", id = 1, t = 2, text = "a" } } } } }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok" } }, ${bundle} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#RunbackDB.chats'), 2);
  assert.equal(vm.evaluate('RunbackDB.chats[1].id'), 'old1');
  assert.equal(vm.num('#RunbackDB.chats[1].history'), 2);
  // An older bridge's transcript says "claude"; it is read as an assistant reply from Claude.
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[2].role'), 'assistant');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[2].agent'), 'claude');
  assert.equal(vm.evaluate('RunbackDB.restored'), 'true');
  // A second bundle with the same token is ignored.
  vm.run('Runback.Send("again")');
  const id2 = vm.num('RunbackDB.chats[2].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id2}, status = "done", text = "ok" } }, ${bundle.replace('old1', 'old2')} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#RunbackDB.chats'), 2);
});

test('chat management commands: new, chat, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("new Realms")');
  assert.equal(vm.num('#RunbackDB.chats'), 2);
  assert.equal(vm.evaluate('RunbackDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('RunbackDB.activeChat'), vm.evaluate('RunbackDB.chats[2].id'));
  vm.run('SlashCmdList.RUNBACK("chat 1")');
  assert.equal(vm.evaluate('RunbackDB.activeChat'), vm.evaluate('RunbackDB.chats[1].id'));
  vm.run('SlashCmdList.RUNBACK("rename Stuff")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.RUNBACK("help")');
  assert.ok(vm.evaluate('RunbackDB.chats[1].history[1].text').includes('/runback cd'));
  vm.run('SlashCmdList.RUNBACK("clear")');
  assert.equal(vm.num('#RunbackDB.chats[1].history'), 0);
  vm.run('SlashCmdList.RUNBACK("delete")');
  assert.equal(vm.num('#RunbackDB.chats'), 1);
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('Runback.ShowCopy("some reply")');
  assert.equal(vm.evaluate('RunbackCopy.shown'), 'true');
  assert.equal(vm.evaluate('RunbackCopyBox.text'), 'some reply');
  assert.equal(vm.num('RunbackCopyFill.color[4]'), 1, 'the copy box has a solid background');
});

test('the Clear button needs a second click ("Sure?") within 3 seconds, resets by itself, and has a tooltip', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  vm.run('Runback.internal.AddHistory(Runback.internal.ActiveChat(), "assistant", "keep me")');
  vm.run(`CLEAR = nil
    for _, f in ipairs(STUB.frames) do if f.kind == "Button" and f.text == "Clear" then CLEAR = f end end`);
  assert.equal(vm.evaluate('CLEAR ~= nil'), 'true', 'the Clear button exists');
  const history = () => vm.num('#RunbackDB.chats[1].history');
  assert.equal(history(), 1);
  // One click only arms it.
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  assert.equal(vm.evaluate('CLEAR.text'), 'Sure?');
  assert.equal(history(), 1, 'the first click clears nothing');
  // No second click: the timer puts the label back, and the next click arms again instead of clearing.
  assert.equal(vm.evaluate('STUB.timers[#STUB.timers].delay'), '3');
  vm.run('STUB.RunTimers()');
  assert.equal(vm.evaluate('CLEAR.text'), 'Clear', 'label resets after the timeout');
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  assert.equal(history(), 1, 'a click after the timeout only re-arms');
  assert.equal(vm.evaluate('CLEAR.text'), 'Sure?');
  // The second click clears and resets the label; the old timer must not disturb a later arming.
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  assert.equal(history(), 0, 'the second click clears the chat');
  assert.equal(vm.evaluate('CLEAR.text'), 'Clear');
  vm.run('Runback.internal.AddHistory(Runback.internal.ActiveChat(), "assistant", "again")');
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  vm.run('STUB.RunTimers()'); // the timers of the earlier armings fire; only the newest one counts
  assert.equal(vm.evaluate('CLEAR.text'), 'Clear');
  assert.equal(history(), 1);
  // Arming does not carry over to another chat.
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  vm.run('SlashCmdList.RUNBACK("new Other")');
  vm.run('CLEAR.scripts.OnClick(CLEAR, "LeftButton")');
  assert.equal(vm.num('#RunbackDB.chats[1].history'), 1, 'the first chat is untouched');
  // Tooltip.
  vm.run('CLEAR.scripts.OnEnter(CLEAR)');
  assert.equal(vm.evaluate('GameTooltip.shown'), 'true');
  assert.ok(vm.evaluate('GameTooltip.text').includes('Clear this chat'));
  vm.run('CLEAR.scripts.OnLeave(CLEAR)');
  assert.equal(vm.evaluate('GameTooltip.shown'), 'false');
});

test('the transcript keeps a scrolled-up position on resize and status refresh, and follows the bottom otherwise', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  const scrolled = () => vm.num('RunbackScroll:GetVerticalScroll()');
  const settle = () => vm.run('STUB.RunTimers()');
  const chatAddHistory = (text) => vm.run(`Runback.internal.AddHistory(Runback.internal.ActiveChat(), "assistant", "${text}")`);
  vm.run('RunbackScroll.vrange = 500');
  vm.run('Runback.Render()'); settle();
  assert.equal(scrolled(), 500, 'a fresh render starts at the bottom');
  // The player scrolls up to read; a refresh and a resize leave the position alone.
  vm.run('RunbackScroll:SetVerticalScroll(200)');
  vm.run('Runback.Render()'); settle();
  assert.equal(scrolled(), 200, 'status refresh does not yank the player down');
  vm.run('RunbackScroll.vrange = 450; RunbackScroll.hooks.OnSizeChanged[1](RunbackScroll, 500, 300)'); settle();
  assert.equal(scrolled(), 200, 'resize keeps the position');
  vm.run('RunbackScroll.vrange = 100'); vm.run('Runback.Render()'); settle();
  assert.equal(scrolled(), 100, 'a position past the new end is clamped, not lost');
  // A new message brings the view to the bottom.
  vm.run('RunbackScroll.vrange = 500; RunbackScroll:SetVerticalScroll(50)');
  chatAddHistory('hello'); vm.run('Runback.Render()'); settle();
  assert.equal(scrolled(), 500, 'a new message scrolls to the bottom');
  // At the bottom the view keeps following the content as it grows (or the window changes).
  vm.run('RunbackScroll.vrange = 700'); vm.run('Runback.Render()'); settle();
  assert.equal(scrolled(), 700, 'at the bottom, growth is followed');
  // Switching chat starts that chat at the bottom, even from a scrolled-up spot.
  vm.run('RunbackScroll:SetVerticalScroll(10)');
  vm.run('SlashCmdList.RUNBACK("new Other")'); vm.run('STUB.RunTimers()');
  vm.run('RunbackScroll:SetVerticalScroll(10)');
  vm.run('Runback.SwitchChat(RunbackDB.chats[1].id)'); settle();
  assert.equal(scrolled(), 700, 'switching chat goes to the bottom');
});

test('a message bubble has a copy icon (no mouse-following tooltip) that opens the copy box', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  vm.run('Runback.internal.AddHistory(Runback.internal.ActiveChat(), "assistant", "copy **me** `now`")');
  vm.run('Runback.Render()');
  vm.run('BUBBLE = RunbackContent.children[1]');
  assert.equal(vm.evaluate('BUBBLE.text'), 'copy **me** `now`');
  assert.equal(vm.evaluate('BUBBLE.scripts.OnEnter == nil'), 'true');
  vm.run('BUBBLE.copyBtn.scripts.OnClick(BUBBLE.copyBtn)');
  assert.equal(vm.evaluate('RunbackCopyBox.text'), 'copy **me** `now`');
  // The window shows the words without the markdown marks.
  assert.equal(vm.evaluate('BUBBLE.body.text'), 'copy me now');
});

test('an unnamed new chat reuses an empty one; a switch closes the AI menu', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("new Other")'); vm.run('STUB.RunTimers()');
  vm.run('Runback.internal.AddHistory(Runback.internal.ActiveChat(), "user", "hi")');
  const before = vm.evaluate('#RunbackDB.chats');
  vm.run('Runback.NewChat()');
  const after = vm.evaluate('#RunbackDB.chats');
  vm.run('Runback.NewChat()');
  assert.equal(vm.evaluate('#RunbackDB.chats'), after, 'a second unnamed chat reuses the empty one');
  assert.equal(Number(after), Number(before) + 0, 'an empty chat already existed');
  vm.run('Runback.ShowPicker(RunbackDB.activeChat, RunbackPoolPicker)');
  vm.run('Runback.SwitchChat(RunbackDB.chats[1].id)');
  assert.equal(vm.evaluate('RunbackPoolPicker:IsShown()'), 'false');
});

test('chat rows: right-click opens a menu that renames or sets the folder of that chat, the trash can asks before deleting', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("new Realms")');
  const first = vm.evaluate('RunbackDB.chats[1].id');
  const second = vm.evaluate('RunbackDB.chats[2].id');
  assert.equal(vm.evaluate('RunbackDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`Runback.ShowChatMenu("${first}", RunbackFrame)`);
  assert.equal(vm.evaluate('RunbackChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('RunbackChatMenu.chatId'), first);
  assert.equal(vm.evaluate('RunbackChatMenu.title.text'), 'Chat 1');
  vm.run(`Runback.ShowChatMenu("${first}", RunbackFrame)`);
  assert.equal(vm.evaluate('RunbackChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`Runback.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'RUNBACK_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.RUNBACK_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('RunbackDB.chats[2].name'), 'Realms');
  vm.run(`Runback.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'RUNBACK_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // The X asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`Runback.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'RUNBACK_DELETE');
  assert.equal(vm.num('#RunbackDB.chats'), 2);
  vm.run('StaticPopupDialogs.RUNBACK_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#RunbackDB.chats'), 1);
  assert.equal(vm.evaluate('RunbackDB.chats[1].id'), second);
  assert.equal(vm.evaluate('RunbackDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`Runback.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.RUNBACK_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#RunbackDB.chats'), 1);
  assert.equal(vm.evaluate('RunbackDB.chats[1].name'), 'Chat 1');
});

test('chat list: only the rows that fit the panel show, the wheel scrolls the rest into view, the active chat stays visible', () => {
  const vm = newVM();
  login(vm);
  for (let i = 2; i <= 12; i++) vm.run(`SlashCmdList.RUNBACK("new Room${i}")`);
  assert.equal(vm.num('#RunbackDB.chats'), 12);
  // Minimum window: the panel is 198px tall, which fits 7 rows of 21px under the New chat button.
  vm.run('RunbackChatPanel.height = 198');
  vm.run('RunbackChatPanel.hooks.OnSizeChanged[1](RunbackChatPanel, 150, 198)');
  const rows = () => vm.evaluate(`(function()
    local out = {}
    for _, b in ipairs(RunbackChatPanel.children) do
      if b.kind == "Button" and b.chatId then
        out[#out + 1] = b.shown and RunbackDB.chats[1].id and b.label.text or "-"
      end
    end
    return table.concat(out, "|")
  end)()`).split('|');
  assert.equal(rows().filter(r => r !== '-').length, 7, 'seven rows fit, the rest are hidden');
  // The newest chat is active, so the list was scrolled to put it in view.
  assert.equal(rows().filter(r => r !== '-').slice(-1)[0], 'Room12');
  assert.equal(rows().filter(r => r !== '-')[0], 'Room6');
  // Wheel up (delta 1) brings earlier chats back in, down goes the other way, both stop at the ends.
  for (let i = 0; i < 20; i++) vm.run('RunbackChatPanel.scripts.OnMouseWheel(RunbackChatPanel, 1)');
  assert.equal(rows().filter(r => r !== '-')[0], 'Chat 1');
  assert.equal(rows().filter(r => r !== '-').length, 7);
  vm.run('RunbackChatPanel.scripts.OnMouseWheel(RunbackChatPanel, -1)');
  assert.equal(rows().filter(r => r !== '-')[0], 'Room2');
  for (let i = 0; i < 20; i++) vm.run('RunbackChatPanel.scripts.OnMouseWheel(RunbackChatPanel, -1)');
  assert.equal(rows().filter(r => r !== '-').slice(-1)[0], 'Room12');
  // Switching to a chat that is off-screen scrolls it into view.
  vm.run('for i = 1, 20 do RunbackChatPanel.scripts.OnMouseWheel(RunbackChatPanel, 1) end');
  vm.run('Runback.SwitchChat(RunbackDB.chats[12].id)');
  vm.run('Runback.SwitchChat(RunbackDB.chats[1].id)');
  assert.equal(rows().filter(r => r !== '-')[0], 'Chat 1');
  // A taller window shows more rows; one tall enough for all of them shows all 12.
  vm.run('RunbackChatPanel.height = 420');
  vm.run('RunbackChatPanel.hooks.OnSizeChanged[1](RunbackChatPanel, 150, 420)');
  assert.equal(rows().filter(r => r !== '-').length, 12);
});

test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('Runback.Toggle(true)');
  assert.equal(vm.evaluate('RunbackFrame.shown'), 'true');
  vm.run('Runback.Minimize(true)');
  assert.equal(vm.evaluate('RunbackFrame.shown'), 'false');
  assert.equal(vm.evaluate('RunbackMini.shown'), 'true');
  assert.equal(vm.evaluate('RunbackDB.settings.minimized'), 'true');
  vm.run('Runback.Minimize(false)');
  assert.equal(vm.evaluate('RunbackFrame.shown'), 'true');
  assert.equal(vm.evaluate('RunbackMini.shown'), 'false');
  vm.run('Runback.Toggle(false)');
  assert.equal(vm.evaluate('RunbackFrame.shown'), 'false');
  assert.equal(vm.evaluate('RunbackMini.shown'), 'false');
  assert.equal(vm.evaluate('RunbackDB.settings.shown'), 'false');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.RUNBACK("mode reload")');
  vm.run('SlashCmdList.RUNBACK("reset")');
  vm.run('Runback.Send("via reload", { "WebSearch", "Bash(git:*)" })');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('RunbackDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('RunbackDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(Buffer.from(vm.evaluate('RunbackDB.outbox.allow'), 'hex').toString('utf8'), 'WebSearch\x1fBash(git:*)');
  assert.equal(decodeStrip(vm), null);
});


test('a reload asked for in combat waits for a keypress after combat, never fires from the combat-end event', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.combat = true; STUB.reloaded = nil');
  vm.run('SlashCmdList.RUNBACK("reload")');
  assert.equal(vm.evaluate('STUB.reloaded'), null, 'no reload in combat');
  vm.run('RunbackKeyCatcher.scripts.OnKeyDown(RunbackKeyCatcher, "W")');
  assert.equal(vm.evaluate('STUB.reloaded'), null, 'a keypress in combat does not reload');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.reloaded'), null, 'ReloadUI is blocked outside a hardware event, so the event must not call it');
  assert.equal(vm.evaluate('RunbackKeyCatcher.shown'), 'true');
  vm.run('RunbackKeyCatcher.scripts.OnKeyDown(RunbackKeyCatcher, "W")');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true', 'the next keypress reloads');
});

test('the addon leaves the game chat boxes alone (no replaced methods, so typed /run and /cast stay untainted)', () => {
  const vm = newVM();
  vm.run(`
    ChatFrame1EditBox = CreateFrame("EditBox", "ChatFrame1EditBox", UIParent)
    ORIG = {}
    for _, k in ipairs({ "ProcessChatType", "SendMessage", "SendText" }) do
      local fn = function() end
      ChatFrame1EditBox[k] = fn
      ORIG[k] = fn
    end`);
  login(vm);
  for (const k of ['ProcessChatType', 'SendMessage', 'SendText']) {
    assert.equal(vm.evaluate(`ChatFrame1EditBox.${k} == ORIG.${k}`), 'true', `${k} is untouched`);
  }
});

test('Forever blocks sends, dispatches commands, observes replies and supports cmd flags', () => {
  const vm = newVM();
  vm.run(`RunbackForever.Register({
    blocked = function() return STUB.blocked and "AI paused in combat" end,
    commands = { zzz = function(rest) STUB.command = rest end },
    onReply = function(chat, rec) STUB.replyStatus = rec.status end,
  })`);
  login(vm);
  vm.run('STUB.blocked = true; Runback.Send("blocked")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].text'), 'AI paused in combat');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  vm.run('SlashCmdList.RUNBACK("zzz hi there")');
  assert.equal(vm.evaluate('STUB.command'), 'hi there');
  vm.run('STUB.blocked = false');
  connect(vm);
  vm.run('Runback.Send("hello", nil, { cmd = "look" })');
  assert.match(stripRecords(vm).at(-1).flags, /cmd=look/);
  const id = vm.num('RunbackDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${vm.evaluate('RunbackDB.chats[1].id')}", id = ${id}, status = "done", text = "ok" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('STUB.replyStatus'), 'done');
});

test('stalled run: Stop and Ask Claude instead appear, and Ask Claude instead re-sends the same question to Claude', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "agy", agents = { "claude", "agy" }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('Runback.Send("how do I get to Undercity?")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  assert.equal(vm.evaluate('Runback.CanAskClaude(RunbackDB.chats[1])'), 'false', 'nothing to offer while the run is healthy');
  vm.run('STUB.texts = {}');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "working", text = "read a", stall = "quiet" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].stall'), 'quiet');
  assert.equal(vm.evaluate('Runback.CanAskClaude(RunbackDB.chats[1])'), 'true');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('Antigravity has gone quiet'), 'the status line says so');
  // Ask Claude instead: the old run is stopped on the bridge, the chat moves to Claude, the question goes again.
  vm.run('Runback.AskClaude()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), 'claude');
  const recs = stripRecords(vm);
  const stop = recs.find(r => r.flags === 's');
  assert.ok(stop, 'a stop record for the old run is on the strip');
  assert.equal(stop.text, '');
  assert.ok(Number(stop.id) !== id);
  const again = recs.find(r => r.text === 'how do I get to Undercity?');
  assert.ok(again, 'the same question is sent again');
  assert.equal(again.flags, 'agent=claude');
  assert.ok(Number(again.id) > Number(stop.id), 'the stop reaches the bridge before the new question');
  assert.equal(vm.evaluate('RunbackDB.chats[1].stall'), null);
  // Already on Claude: nothing to switch to.
  assert.equal(vm.evaluate('Runback.CanAskClaude(RunbackDB.chats[1])'), 'false');
});

test('stalled run: Stop gives up and tells the bridge; a no-reply run keeps the offer', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "agy", agents = { "claude", "agy" }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('Runback.Send("q1")');
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const id = vm.num('RunbackDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "working", text = "read a", stall = "long" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].stall'), 'long');
  vm.run('Runback.StopRun()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('RunbackDB.chats[1].agent'), '', 'Stop does not change the agent');
  assert.ok(stripRecords(vm).some(r => r.flags === 's'));
  // A run that ends with no reply.
  vm.run('Runback.Send("q2")');
  const id2 = vm.num('RunbackDB.chats[1].pendingId');
  vm.run('STUB.texts = {}');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, status = "done", text = "Antigravity finished without a reply. It did 3 actions:\\n- Read a", agent = "agy", stall = "noreply" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('RunbackDB.chats[1].stall'), 'noreply');
  assert.equal(vm.evaluate('Runback.CanAskClaude(RunbackDB.chats[1])'), 'true');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('Antigravity sent no answer'));
  // A new message clears the offer.
  vm.run('Runback.Send("q3")');
  assert.equal(vm.evaluate('RunbackDB.chats[1].stall'), null);
});

test('a bridge reply carries its follow-up questions into the history: strings only, at most two', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('RunbackDB.chats[1].id');
  const deliver = (extra) => {
    vm.run('Runback.Send("do it")');
    const id = vm.num('RunbackDB.chats[1].pendingId');
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", agent = "claude"${extra} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('RunbackDB.chats[1].pendingId'), null);
  };
  deliver(', followUps = { "a?", "", 5, "b?", "c?" }');
  assert.equal(vm.evaluate('table.concat(RunbackDB.chats[1].history[#RunbackDB.chats[1].history].followUps, "|")'), 'a?|b?');
  deliver('');
  assert.equal(vm.evaluate('RunbackDB.chats[1].history[#RunbackDB.chats[1].history].followUps'), null, 'no tag, none stored');
});
