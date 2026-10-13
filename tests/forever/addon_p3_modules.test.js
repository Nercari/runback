'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const luaparse = require('luaparse');

const addon = path.join(__dirname, '..', '..', 'addon', 'Runback');

test('P3 Forever modules parse as Lua 5.1 and contain no combat log hook', () => {
  for (const file of ['Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua']) {
    const source = fs.readFileSync(path.join(addon, file), 'utf8');
    assert.doesNotThrow(() => luaparse.parse(source, { luaVersion: '5.1' }), file);
    assert.doesNotMatch(source, /COMBAT_LOG_EVENT_UNFILTERED|loadstring|RunScript/);
    for (const line of source.split('\n')) assert.ok(line.length <= 160, `${file} line exceeds 160 chars`);
  }
});

test('TOC loads the modules after the Forever registry', () => {
  const toc = fs.readFileSync(path.join(addon, 'Runback.toc'), 'utf8');
  const start = toc.indexOf('Forever.lua');
  for (const file of ['Forever_Lockout.lua', 'Forever_Context.lua', 'Forever_Switch.lua', 'Forever_Commands.lua']) {
    assert.ok(toc.indexOf(file) > start, `${file} must follow Forever.lua`);
  }
});
