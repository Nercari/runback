'use strict';
// The one test entry point behind `npm test`. A new test file needs no list
// edit: any tests/**/*.test.js or tests/*_test.js is found here, so two PRs
// that each add a test no longer collide in package.json.
//
//   node tests/run_all.js
//
// Order: order_check.js (the addon parses), then every discovered file in one
// `node --test` run, then codec_test.js (it needs the plain-node entry and
// writes scratch images). Stops at the first failing step, like `&&`.
//
// Not run here: inject_test.js drives a real agent CLI (`npm run test:live`).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS = __dirname;
const SKIP_DIRS = new Set(['fixtures', 'tmp', 'node_modules']);
// Run by their own step (or by hand), never inside the `node --test` batch.
const SEPARATE = new Set(['codec_test.js', 'inject_test.js']);

// Sorted paths relative to the repo root, forward slashes.
function discover(dir = TESTS) {
  const found = [];
  const walk = (d, top) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, false);
      } else if (entry.name.endsWith('.test.js') || (top && entry.name.endsWith('_test.js'))) {
        if (!(top && SEPARATE.has(entry.name))) found.push(full);
      }
    }
  };
  walk(dir, true);
  return found.map(f => path.relative(path.join(dir, '..'), f).split(path.sep).join('/')).sort();
}

function run(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(TESTS, '..') });
  return r.status === null ? 1 : r.status;
}

function main() {
  const files = discover();
  if (!files.length) { console.error('no test files found'); return 1; }
  for (const args of [
    ['tests/order_check.js'],
    ['--test', ...files],
    ['tests/codec_test.js'],
  ]) {
    const code = run(args);
    if (code !== 0) return code;
  }
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { discover, SEPARATE };
