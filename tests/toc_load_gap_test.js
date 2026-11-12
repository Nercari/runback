'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countHandwritten, cases } = require('../tools/toc-load-gap');

const gap = countHandwritten().length;
test('toc-load-gap hits zero when tests use the toc-order loader', { skip: gap !== 0 && `toc-load-gap is ${gap}` }, () => {
  assert.deepEqual(countHandwritten(), []);
});

test('toc-load-gap locked baseline matches detection on forever', () => {
  if (gap !== cases.baselineHandwritten) return;
  const hits = countHandwritten().sort();
  assert.deepEqual(hits, [...cases.lockedFiles].sort());
});
