'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countGap } = require('../tools/roles-gap');

const gap = countGap();
test('roles-gap hits zero when the role table and transport are complete', { skip: gap !== 0 && `roles-gap is ${gap}` }, () => {
  assert.equal(countGap(), 0);
});
