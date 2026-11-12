#!/usr/bin/env node
'use strict';
// Score for unit 3: missing role-table rows in the bridge and transport, plus agents
// that offer a cheap tier but do not map coach note to it. Locked cases in
// tools/roles-gap-cases.json.

const path = require('node:path');
const fs = require('node:fs');
const cases = require('./roles-gap-cases.json');

const ROOT = path.join(__dirname, '..');

function loadBridge() {
  const modelsPath = path.join(ROOT, 'bridge', 'models.js');
  const protocolPath = path.join(ROOT, 'bridge', 'protocol.js');
  const bridgePath = path.join(ROOT, 'bridge', 'bridge.js');
  if (!fs.existsSync(modelsPath)) return { error: 'bridge/models.js missing' };
  delete require.cache[require.resolve(modelsPath)];
  delete require.cache[require.resolve(protocolPath)];
  delete require.cache[require.resolve(bridgePath)];
  const M = require('../bridge/models');
  const P = require('../bridge/protocol');
  let poolsHasRoles = false;
  try {
    const src = fs.readFileSync(bridgePath, 'utf8');
    poolsHasRoles = /\broles\b/.test(src) && src.includes('roleNames');
  } catch { /* ignore */ }
  return { M, P, poolsHasRoles };
}

function cheapOffered(M, acfg, id) {
  return Boolean(M.coachModel(acfg, id));
}

function countGap() {
  let gap = 0;
  const { M, P, poolsHasRoles, error } = loadBridge();
  if (error) return cases.roleCount + cases.agents.length;

  const roleIds = Array.isArray(M.ROLE_IDS) ? M.ROLE_IDS : [];
  if (roleIds.length < cases.roleCount) gap += cases.roleCount - roleIds.length;
  for (const r of cases.roles) {
    if (!roleIds.includes(r)) gap += 1;
  }

  if (typeof M.roleRows !== 'function') {
    gap += cases.roleCount * cases.agents.length;
  } else {
    for (const id of cases.agents) {
      const rows = M.roleRows({}, id);
      for (const r of cases.roles) {
        const row = rows && rows[r];
        if (!row || typeof row.model !== 'string') gap += 1;
        else if (r === 'translate' && cases.translateToolFree.includes(id) && !row.model) gap += 1;
      }
      for (const [aid, kind] of Object.entries(cases.cannotRunAgents)) {
        if (aid !== id || kind !== 'mentor') continue;
        if (typeof M.agentCannotRun !== 'function' || !M.agentCannotRun(id)) gap += 1;
      }
    }
  }

  if (!poolsHasRoles) gap += 2;

  const sample = P.luaTable('Runback_Inbox', [], {
    roles: { claude: { chat: 'opus', quick: 'haiku', coach: 'haiku', deep: 'opus', translate: 'opus' } },
    roleNames: cases.roleNames,
    cannotRun: { hermes: 'blocked' },
  });
  if (!sample.includes('roles =')) gap += 1;
  if (!sample.includes('roleNames =')) gap += 1;
  if (!sample.includes('cannotRun =')) gap += 1;

  for (const id of cases.agents) {
    if (!cheapOffered(M, {}, id)) continue;
    if (!M.CHEAP || !M.CHEAP[id]) {
      gap += 1;
      continue;
    }
    if (typeof M.roleRows === 'function') {
      const coach = M.roleRows({}, id).coach;
      const want = M.coachModel({}, id);
      if (want && (!coach || coach.model !== want)) gap += 1;
    }
  }

  return gap;
}

function main() {
  const gap = countGap();
  console.log(`roles-gap: ${gap}`);
  console.log(gap);
  process.exit(gap === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { countGap, cases };
