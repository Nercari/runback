#!/usr/bin/env node
'use strict';
// Linux: stop this checkout's bridge supervisor (npm run stop).

const { stopLinuxSupervisor } = require('./doctor');

function stopBridge(platform = process.platform) {
  if (platform !== 'linux') {
    console.error('npm run stop is for Linux; on Windows use bridge\\stop-bridge.ps1');
    return 1;
  }
  stopLinuxSupervisor();
  console.log('bridge : supervisor stopped');
  return 0;
}

function main() {
  process.exit(stopBridge());
}

if (require.main === module) main();

module.exports = { stopBridge };
