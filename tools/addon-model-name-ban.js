#!/usr/bin/env node
'use strict';
// Counts pinned model-id strings in addon/Runback/*.lua (code and comments).
// The bridge owns model names; the addon uses roles and bridge-fed ids only.

const fs = require('node:fs');
const path = require('node:path');

const ADDON = path.join(__dirname, '..', 'addon', 'Runback');

// Catalog ids and common CLI aliases — not agent ids (claude, codex, grok).
const BANNED = [
  'haiku', 'sonnet', 'opus', 'fable', 'opusplan',
  'grok-build',
  'gpt-5', 'gpt-6', 'gpt-5.5', 'gpt-5.6', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
];

const bannedRe = new RegExp(`\\b(${BANNED.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.name.endsWith('.lua')) out.push(full);
  }
  return out;
}

function countFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    const re = new RegExp(bannedRe.source, bannedRe.flags);
    let m;
    while ((m = re.exec(line)) !== null) n += 1;
  }
  return n;
}

function countAddon(dir = ADDON) {
  return walk(dir).reduce((sum, f) => sum + countFile(f), 0);
}

function scanAddon(dir = ADDON) {
  const hits = [];
  for (const file of walk(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const re = new RegExp(bannedRe.source, bannedRe.flags);
      let m;
      while ((m = re.exec(line)) !== null) {
        hits.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

function main() {
  const hits = scanAddon();
  for (const h of hits) console.error(`${path.relative(path.join(__dirname, '..'), h.file)}:${h.line}: ${h.text}`);
  const total = hits.length;
  console.log(`model-name matches in addon: ${total}`);
  console.log(total);
  process.exit(total === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { countAddon, scanAddon, BANNED, bannedRe };
