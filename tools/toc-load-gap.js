#!/usr/bin/env node
'use strict';
// Unit 10 score: test files that still hand-write a Runback addon .lua load list.
// Locked baselines in tools/toc-load-gap-cases.json.

const fs = require('node:fs');
const path = require('node:path');
const cases = require('./toc-load-gap-cases.json');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const ADDON = path.join(ROOT, 'addon', 'Runback');

const SKIP = new Set([
  'toc_load.js',
  'toc_load_gap_test.js',
]);

function parseToc() {
  return fs.readFileSync(path.join(ADDON, 'Runback.toc'), 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.endsWith('.lua'));
}

function* walkTests(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkTests(full);
    else if (ent.name.endsWith('.test.js') || ent.name.endsWith('_test.js')) yield full;
  }
}

function isHandwrittenLoadList(src, tocSet) {
  const stripped = src.replace(/onlyFiles\s*\(\s*\[[\s\S]*?\]\s*\)/g, '');
  for (const arr of stripped.matchAll(/\[[\s\S]*?['"]Codec\.lua['"][\s\S]*?\]/g)) {
    const lua = [...arr[0].matchAll(/['"]([^'"]+\.lua)['"]/g)].map(m => m[1]);
    const inToc = lua.filter(f => tocSet.has(f));
    if (inToc.length >= 2) return true;
  }
  const runs = [...stripped.matchAll(/run\(read\(['"]([^'"]+\.lua)['"]\)\)/g)];
  if (runs.length >= 3 && runs.some(r => r[1] === 'Codec.lua')) return true;
  if (/for\s*\(\s*const\s+\w+\s+of\s+\[/.test(stripped) && /['"]Codec\.lua['"]/.test(stripped)) {
    const loops = [...stripped.matchAll(/for\s*\(\s*const\s+\w+\s+of\s+\[([\s\S]*?)\]/g)];
    for (const loop of loops) {
      const lua = [...loop[1].matchAll(/['"]([^'"]+\.lua)['"]/g)].map(m => m[1]);
      const inToc = lua.filter(f => tocSet.has(f));
      if (inToc.length >= 2) return true;
    }
  }
  return false;
}

function countHandwritten() {
  const tocSet = new Set(parseToc());
  const hits = [];
  for (const file of walkTests(TESTS)) {
    const rel = path.relative(TESTS, file).replace(/\\/g, '/');
    if (SKIP.has(path.basename(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (isHandwrittenLoadList(src, tocSet)) hits.push(rel);
  }
  return hits;
}

function verifyLocked(hits) {
  const locked = [...cases.lockedFiles].sort();
  const got = [...hits].sort();
  if (locked.length !== got.length) return false;
  for (let i = 0; i < locked.length; i++) if (locked[i] !== got[i]) return false;
  return true;
}

function main() {
  const hits = countHandwritten();
  const gap = hits.length;
  if (process.env.TOC_GAP_LOCK === '1' && !verifyLocked(hits)) {
    console.error('toc-load-gap: locked file list mismatch');
    for (const f of hits) console.error('  hit:', f);
    process.exit(2);
  }
  for (const f of hits) console.error(`hand-written load list: tests/${f}`);
  console.log(`toc-load-gap: ${gap}`);
  console.log(gap);
  process.exit(gap === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { countHandwritten, cases, verifyLocked };
