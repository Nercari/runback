'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discover, SEPARATE } = require('../run_all');

test('run_all finds this file and the top-level and nested tests', () => {
  const files = discover();
  assert.ok(files.includes('tests/tools/run_all.test.js'));
  assert.ok(files.includes('tests/bridge_test.js'));
  assert.ok(files.includes('tests/forever/bridge.test.js'));
  assert.ok(files.includes('tests/probe/probe.test.js'));
  assert.deepEqual(files, [...files].sort(), 'sorted, so runs are repeatable');
});

test('run_all leaves out the codec and live-agent tests, which run on their own', () => {
  const files = discover();
  for (const name of SEPARATE) assert.ok(!files.includes(`tests/${name}`), name);
  assert.deepEqual([...SEPARATE].sort(), ['codec_test.js', 'inject_test.js']);
});

test('run_all skips fixtures and scratch folders, and *_test.js only counts at the top', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runall-'));
  try {
    const tests = path.join(root, 'tests');
    for (const rel of ['a_test.js', 'sub/b.test.js', 'sub/c_test.js', 'fixtures/x.test.js', 'tmp/y.test.js', 'codec_test.js', 'inject_test.js', 'notes.js']) {
      fs.mkdirSync(path.dirname(path.join(tests, rel)), { recursive: true });
      fs.writeFileSync(path.join(tests, rel), '');
    }
    assert.deepEqual(discover(tests), ['tests/a_test.js', 'tests/sub/b.test.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
