// #144: a publish writes the inbox and only the window of reply slots the addon
// can still load (the ones after the slot it last reported on the strip), not all
// 200. These tests run the bridge's own writer; the promise is that a window of
// 16 loses no reply, and that an addon without the report still gets replies.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../bridge/protocol');

const SLOTS = 200, WINDOW = 16;

function functionSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

// The real noteAddonSlot/writeSlots from bridge.js, with the file write and the
// publish it triggers counted instead of run.
function loadWriters() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
  const w = { writes: [], publishes: 0, onWrite: file => w.writes.push(file) };
  const sandbox = {
    P, path, pad3: P.pad3, Number,
    cfg: { addonDir: '/addons' },
    SLOTS, SLOT_WINDOW: WINDOW,
    addonSlot: 0,
    atomicWrite: file => { w.onWrite(String(file)); },
    publishNow: () => { w.publishes++; sandbox.writeSlots('after a reset'); },
  };
  const code = ['noteAddonSlot', 'writeSlots'].map(name => functionSource(src, name)).join('\n');
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.noteAddonSlot = noteAddonSlot; this.writeSlots = writeSlots;', sandbox);
  w.noteAddonSlot = sandbox.noteAddonSlot;
  w.writeSlots = sandbox.writeSlots;
  w.slotOf = file => Number(/Runback_S(\d{3})/.exec(file)[1]);
  w.slotsWritten = () => w.writes.map(w.slotOf); // in write order
  w.reset = () => { w.writes.length = 0; w.publishes = 0; };
  return w;
}

test('a publish writes all slots until the addon reports one, then the 16 after it', () => {
  const w = loadWriters();
  w.writeSlots('body');
  assert.equal(w.writes.length, SLOTS, 'no report yet (an older addon, or none loaded): every slot');
  w.reset();
  w.noteAddonSlot(17);
  w.writeSlots('body');
  assert.deepEqual(w.slotsWritten(), Array.from({ length: WINDOW }, (_, i) => 18 + i));
  w.reset(); // the pool wraps at 200
  w.noteAddonSlot(195);
  w.writeSlots('body');
  assert.deepEqual(w.slotsWritten(), [196, 197, 198, 199, 200, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('a window of 16 loses no reply: the addon reads the reply on every poll it can still make', () => {
  const w = loadWriters();
  const files = new Map();
  w.onWrite = file => files.set(w.slotOf(file), w.content);
  const publish = content => { w.content = content; w.reset(); w.writeSlots(content); };
  // Login: nothing reported yet, so the first publish covers every slot.
  publish('hello');
  const loaded = [];
  const poll = () => {
    const next = [...Array(SLOTS).keys()].map(i => i + 1).find(i => !loaded.includes(i));
    loaded.push(next);
    return files.get(next);
  };
  assert.equal(poll(), 'hello'); // slot 1
  w.noteAddonSlot(1); // the strip says so
  publish('the reply');
  for (let i = 0; i < WINDOW; i++) {
    assert.equal(poll(), 'the reply', `poll ${i + 2} reads the reply`);
  }
  // 16 is the measured window: a reply that waits 17 polls is outside it and the
  // slot still holds the older snapshot. The issue stops and reports if the live
  // client ever shows that.
  assert.equal(poll(), 'hello', 'the 17th poll is past the window');
});

test('an old addon without the slot field still gets replies from any slot', () => {
  const w = loadWriters();
  w.writeSlots('reply'); // no noteAddonSlot call: an addon before #144 never reports
  assert.equal(w.writes.length, SLOTS);
  assert.deepEqual(w.slotsWritten(), Array.from({ length: SLOTS }, (_, i) => i + 1));
  assert.ok(w.writes.some(f => /Runback_S137[\\/]Inbox\.lua$/.test(f)));
});

test('a new slot pool (/reload) writes every slot again before the addon polls', () => {
  const w = loadWriters();
  w.noteAddonSlot(150);
  assert.equal(w.publishes, 0, 'a higher number is not a reset');
  w.noteAddonSlot(1); // the pool restarted: slot 1 is the first the addon loads again
  assert.equal(w.publishes, 1, 'the bridge says everything again at once');
  assert.equal(w.writes.length, SLOTS);
  w.reset();
  w.noteAddonSlot(0); // a session that has not loaded a slot yet
  w.writeSlots('body');
  assert.equal(w.writes.length, SLOTS, 'no slot reported: every slot');
});

test('an hour of work stays under the 30,300-write budget', () => {
  // The measured baseline (issue #144): 272,839 writes per hour, i.e. one full
  // publish of 200 slots every 2.64 s. Same cadence, now a window of 16.
  const publishes = Math.round(272839 / SLOTS);
  const w = loadWriters();
  w.noteAddonSlot(1);
  let slot = 1;
  for (let i = 0; i < publishes; i++) {
    w.writeSlots('body'); // one progress publish
    w.writes.push('/addons/Runback/Inbox.lua'); // and the inbox it always writes
    if (i % 60 === 0) { slot += 1; w.noteAddonSlot(slot); } // a poll a minute while a reply is pending
  }
  const perHour = w.writes.length;
  console.log(`slot and inbox writes per hour of work: ${perHour} (window ${WINDOW} of ${SLOTS}, ${publishes} publishes)`);
  assert.ok(perHour <= 30300, `${perHour} > 30300`);
});
