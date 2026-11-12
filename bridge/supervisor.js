#!/usr/bin/env node
'use strict';
// Keeps bridge.js running: restarts it 3 s after any exit. Ctrl+C stops both.
// This is also the `runback` command (package.json "bin"): arguments and the
// current folder pass straight through to bridge.js, so `cd proj && runback`
// makes proj the default folder for chats.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'supervisor.pid');

let child = null;
let stopping = false;

function writePidFile() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
}

function clearPidFile() {
  try {
    const text = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (Number(text) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}

writePidFile();

function start() {
  child = spawn(process.execPath, [path.join(__dirname, 'bridge.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    if (code === 2 || code === 0) { clearPidFile(); process.exit(code); } // config problem or --help/--once: don't loop
    console.log(`\nbridge exited (${code}); restarting in 3 s`);
    setTimeout(start, 3000);
  });
}

function killBridge() {
  if (!child) return;
  if (process.platform === 'linux') {
    try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
  }
  try { child.kill('SIGTERM'); } catch {}
}

function stop() {
  stopping = true;
  killBridge();
  clearPidFile();
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start();
