'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stopBridge } = require('../../tools/stop-bridge');

test('stopBridge refuses non-Linux platforms', () => {
  assert.equal(stopBridge('win32'), 1);
});
