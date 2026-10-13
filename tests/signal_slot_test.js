// A bad message id must not become a signal file named null.wav.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../bridge/protocol');

function functionSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed function ' + name);
}

function loadSignalPaths() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
  const writes = [];
  const sandbox = {
    path,
    cfg: { addonDir: path.join('/addons'), actMax: 60 },
    pad3: P.pad3,
    slotNumber: (id) => P.slotNumber(id, 200),
    SILENT_WAV: Buffer.alloc(0),
    Buffer,
    atomicWrite: (file) => { writes.push(String(file)); },
  };
  sandbox.ACT_MAX = sandbox.cfg.actMax;
  const code = ['signal', 'actFile', 'resetBeats', 'beat'].map(name => functionSource(src, name)).join('\n');
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.signal = signal; this.actFile = actFile; this.resetBeats = resetBeats; this.beat = beat;', sandbox);
  return { signal: sandbox.signal, actFile: sandbox.actFile, resetBeats: sandbox.resetBeats, beat: sandbox.beat, writes };
}

test('a bad message id does not produce a null.wav path', () => {
  const { signal, actFile, resetBeats, beat, writes } = loadSignalPaths();
  for (const id of [0, -5, NaN]) {
    writes.length = 0;
    signal('sig', id, true);
    signal('ack', id, false);
    const act = actFile(id, 1);
    resetBeats(id);
    beat({ id });
    const paths = writes.concat(act == null ? [] : [String(act)]);
    assert.deepEqual(paths.filter(p => p.includes('null')), [], 'id ' + id);
  }
  writes.length = 0;
  signal('sig', 1, true);
  assert.ok(writes[0].endsWith(path.join('WoWAI', 'sig', '001.wav')));
  assert.ok(String(actFile(201, 3)).endsWith(path.join('WoWAI', 'act', '001', '03.wav')));
});
