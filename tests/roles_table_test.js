'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../bridge/agents');
const M = require('../bridge/models');
const P = require('../bridge/protocol');
const cases = require('../tools/roles-gap-cases.json');

test('ROLE_IDS lists five roles with player-facing labels', () => {
  assert.deepEqual(M.ROLE_IDS, cases.roles);
  for (const r of cases.roles) {
    assert.equal(M.ROLE_LABELS[r], cases.roleNames[r]);
  }
});

test('roleRows: built-in defaults for Claude and empty lists for config-only agents', () => {
  const claude = M.roleRows({}, 'claude');
  assert.equal(claude.chat.model, 'fable');
  assert.equal(claude.quick.model, 'haiku');
  assert.equal(claude.coach.model, 'haiku');
  assert.equal(claude.deep.model, 'opus');
  assert.equal(claude.translate.model, 'fable');
  assert.equal(claude.translate.blocked, '');
  const codex = M.roleRows({}, 'codex');
  assert.equal(codex.translate.model, '');
  assert.ok(codex.translate.blocked.includes('translator'));
  assert.equal(M.roleRows({}, 'hermes').chat.model, '');
});

test('agents.<id>.roles overrides a row when the model is on the list', () => {
  const rows = M.roleRows({ roles: { coach: 'sonnet' } }, 'claude');
  assert.equal(rows.coach.model, 'sonnet');
});

test('roleRows: off-list translate override reports the same block as other roles', () => {
  const t = M.roleRows({ roles: { translate: 'nope' } }, 'claude').translate;
  assert.equal(t.model, '');
  assert.equal(t.blocked, 'Model not on this agent list.');
});

test('luaTable cannotRun reasons are not cut mid-word at the slot limit', () => {
  const why = A.agentCannotRun('hermes');
  const lua = P.luaTable('Runback_Inbox', [], { cannotRun: { hermes: why } });
  const m = lua.match(/cannotRun = \{ hermes = "([^"]*)"/);
  assert.ok(m, 'cannotRun row present');
  assert.ok(m[1].length <= 240);
  assert.ok(!m[1].endsWith(' fo'), 'Hermes reason must not end on a split word');
  assert.ok(m[1].endsWith('another'), 'Hermes reason ends on a whole word');
  const whyOc = A.agentCannotRun('opencode');
  const luaOc = P.luaTable('Runback_Inbox', [], { cannotRun: { opencode: whyOc } });
  const mOc = luaOc.match(/cannotRun = \{ opencode = "([^"]*)"/);
  assert.ok(mOc[1].endsWith('another'), 'OpenCode reason ends on a whole word');
});

test('agentCannotRun carries the mentor refusal for Hermes and OpenCode', () => {
  assert.ok(A.agentCannotRun('hermes'));
  assert.ok(A.agentCannotRun('opencode'));
  assert.equal(A.agentCannotRun('claude'), '');
});

test('luaTable carries roleNames, roles, cannotRun and roleBlocked', () => {
  const lua = P.luaTable('Runback_Inbox', [], {
    roleNames: M.ROLE_LABELS,
    roles: { claude: M.roleMap({}, 'claude') },
    cannotRun: { hermes: 'blocked' },
    roleBlocked: { codex: { translate: 'no tools off' } },
  });
  assert.ok(lua.includes('roleNames = { chat = "Chat"'));
  assert.ok(lua.includes('roles = { claude = { chat = "fable"'));
  assert.ok(lua.includes('cannotRun = { hermes = "blocked"'));
  assert.ok(lua.includes('roleBlocked = { codex = { translate = "no tools off" }'));
  assert.ok(P.luaTable('Runback_Inbox', [], {}).includes('roles = {  },'), 'empty roles clears stale cache');
});

test('roles ship in CONFIGURATION and a release fragment', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CONFIGURATION.md'), 'utf8');
  assert.match(doc, /`roles`/);
  assert.match(doc, /Coach note/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'changes', 'bridge-role-table.md')));
});
