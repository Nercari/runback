'use strict';
// Backlog 80: the game system prompt names only controls the addon really has. These
// tests read the addon's Lua, so a renamed button or command fails here first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GAME_CONTROLS, systemPrompt } = require('../../bridge/protocol');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');
const read = file => fs.readFileSync(path.join(addon, file), 'utf8');
const luaFiles = fs.readdirSync(addon).filter(f => f.endsWith('.lua'));

// The keys of the Lua table that starts at `start` (the index of its "{"), depth 1 only.
function tableKeys(src, start) {
  const keys = [];
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { if (--depth === 0) break; }
    else if (depth === 1 && /[\w]/.test(ch) && !/[\w.:]/.test(src[i - 1])) {
      const m = /^(\w+)\s*=(?!=)/.exec(src.slice(i));
      if (m) keys.push(m[1]);
      while (/\w/.test(src[i + 1])) i++;
    }
  }
  return keys;
}

// Every command word the addon handles: the core table in Runback.lua and each module's commands.
function handledCommands() {
  const handled = new Set();
  const core = read('Runback.lua');
  tableKeys(core, core.indexOf('local COMMAND_ARGS = {') + 'local COMMAND_ARGS = '.length).forEach(k => handled.add(k));
  for (const file of luaFiles) {
    const src = read(file);
    for (const m of src.matchAll(/(?<!local )\bcommands = \{/g)) {
      tableKeys(src, m.index + 'commands = '.length).forEach(k => handled.add(k));
    }
  }
  const list = /local commands = \{([^}]*)\}/.exec(read('Forever_Commands.lua'))[1];
  for (const m of list.matchAll(/"(\w+)"/g)) handled.add(m[1]);
  return handled;
}

const foreverCommands = () => [.../local commands = \{([^}]*)\}/.exec(read('Forever_Commands.lua'))[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
const needsText = () => [.../if \(([^)]*)\) and rest == ""/.exec(read('Forever_Commands.lua'))[1].matchAll(/cmd == "(\w+)"/g)].map(m => m[1]);

test('every /ai command the prompt names is one the addon handles', () => {
  const handled = handledCommands();
  assert.ok(handled.has('review') && handled.has('guide') && handled.has('off') && handled.has('copy'), 'parser sees the addon commands');
  assert.ok(!handled.has('rest') && !handled.has('pixel'), 'parser skips nested tables and function bodies');
  const unknown = GAME_CONTROLS.commands.map(([name]) => name).filter(name => !handled.has(name));
  assert.deepEqual(unknown, []);
});

test('every Forever command is in the prompt, with the argument it really takes', () => {
  const listed = new Map(GAME_CONTROLS.commands.map(([name, arg]) => [name, arg]));
  const required = needsText();
  assert.deepEqual(required.sort(), ['brief', 'council']);
  for (const cmd of foreverCommands()) {
    assert.ok(listed.has(cmd), `/ai ${cmd} missing from GAME_CONTROLS`);
    if (cmd === 'phone') continue;
    if (required.includes(cmd)) assert.match(listed.get(cmd), /^</, `/ai ${cmd} needs text`);
    else assert.match(listed.get(cmd), /^\[/, `/ai ${cmd} works alone`);
  }
  assert.equal(listed.get('look'), '[question]');
});

test('every button the prompt names is a label in the addon', () => {
  const src = luaFiles.map(read).join('\n');
  const missing = GAME_CONTROLS.buttons.map(([label]) => label).filter(label => !src.includes('"' + label));
  assert.deepEqual(missing, []);
  assert.ok(!src.includes('"Look"'), 'there is no Look button');
});

test('the game system prompt carries the controls and the no-invention rule', () => {
  const prompt = systemPrompt('level 5 warrior');
  assert.match(prompt, /never invent a button, menu or command/);
  assert.match(prompt, /^\/ai look \[question\]: /m);
  assert.match(prompt, /^\/ai council <question>: /m);
  assert.match(prompt, /Review last fight \(same as \/ai review\)/);
  assert.match(prompt, /Never give the player \/run, \/script, \/console or \/dump lines/);
  assert.doesNotMatch(systemPrompt(''), /never invent a button/, 'unrelated projects do not get the game controls');
});

// Backlog 84: /ai look always fails in an Antigravity chat, so its prompt must not offer it.
test('an agent that cannot see screenshots is not told /ai look works', () => {
  const { lookFor } = require('../../bridge/agents');
  const agy = systemPrompt('level 10 warlock', '', lookFor('agy'));
  assert.doesNotMatch(agy, /^\/ai look/m);
  assert.match(agy, /You can't see screenshots in this chat, so \/ai look does not work here\./);
  assert.match(agy, /they pick Claude, Codex, Grok or Hermes with the AI button, press Print Screen, then type look in the box\./);
  assert.match(agy, /^\/ai review \[question\]: /m, 'the other commands stay');
  for (const agent of ['claude', 'codex', 'grok', 'hermes']) {
    const prompt = systemPrompt('level 10 warlock', '', lookFor(agent));
    assert.match(prompt, /^\/ai look \[question\]: asks about the newest screenshot/m, agent);
    assert.doesNotMatch(prompt, /can't see screenshots/, agent);
  }
});
