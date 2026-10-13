// End to end for backlog 49, 50 and 54: the real bridge runs a fake Claude CLI that
// does what the 2026-10-11 recordings showed (raw greps, a quoted combat-log line,
// map marks, a permission denial). What the game receives must be plain words.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const luaparse = require('luaparse');
const P = require('../bridge/protocol');

const LOG_LINE = '10/11/2026 17:41:56.311-3  SPELL_CAST_SUCCESS,Player-4613-01457956,"Nercari-Realm",0x511,0x0,Player-4613-01457956,"Nercari-Realm",0x511,0x0,687,"Demon Skin",0x20';

const FAKE = `
const fs = require('fs');
process.stdin.resume(); process.stdin.on('data', () => {});
const emit = (o) => console.log(JSON.stringify(o));
const tool = (name, input) => ({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', name, input }] } });
const steps = [
  tool('Grep', { pattern: '^10/11/2026 17:4(1:(2[5-9]|[3-5]\\\\d)|2:(0\\\\d|1[0-5]))' }),
  tool('Bash', { command: 'cd "C:/Users/x/wow-mentor" && node "C:/repo/tools/slice-fight.js" --start 1' }),
  tool('Glob', { pattern: '{characters,reviews}/' }),
  tool('Read', { file_path: 'C:/x/toolu_01GxbuPG6Cvh8vs1VMiofAJe.txt' }),
  tool('ToolSearch', {}),
  tool('Bash', { command: 'node "C:/repo/tools/check-citations.js" --review r.txt' }),
];
let i = 0;
(function next() {
  if (i < steps.length) { emit(steps[i++]); return setTimeout(next, 150); }
  fs.copyFileSync(process.env.FAKE_INBOX, process.env.FAKE_SNAPSHOT);
  const reply = [
    'Fight: Hogger, 2 mistakes.',
    '1. Demon Skin cast mid-fight - 17:41:56',
    '   Log: \`' + process.env.FAKE_LOG_LINE + '\`',
    '   Why: it left you with 23 mana.',
    '\`\`\`wowmap',
    '{"op":"set","layer":"wand","title":"Wands","points":[{"m":1420,"x":9.7,"y":63.9,"label":"Wand"},{"m":1420,"x":12,"y":40,"label":"Vendor"}]}',
    '\`\`\`',
  ].join('\\n');
  emit({ type: 'result', session_id: 's1', is_error: false, result: reply, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'ls | head' } }] });
})();
`;

function readReply(file, globalName) {
  const ast = luaparse.parse(fs.readFileSync(file, 'utf8'), { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === globalName);
  const fields = assign.init[0].fields.find(f => f.key.name === 'replies').value.fields;
  const rec = {};
  for (const g of fields[0].value.fields) {
    if (g.value.raw !== undefined) rec[g.key.name] = g.value.raw.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return rec;
}

test('the game receives plain progress phrases, one evidence line and no internal lines', () => {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'runback-plain-'));
  try {
    const repo = path.join(S, 'repo');
    fs.cpSync(path.join(__dirname, '..', 'bridge'), path.join(repo, 'bridge'), { recursive: true, filter: f => !/[\\/]bridge[\\/]tmp/.test(f) });
    fs.cpSync(path.join(__dirname, '..', 'mentor'), path.join(repo, 'mentor'), { recursive: true });
    fs.mkdirSync(path.join(S, 'addons', 'Runback'), { recursive: true });
    fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(S, 'addons', 'Runback', 'Runback.toc'), '## Interface: 16001\n');
    fs.writeFileSync(path.join(S, 'fake-claude.js'), FAKE);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'bridge', 'config.example.json'), 'utf8'));
    Object.assign(cfg, { addonDir: path.join(S, 'addons'), inboxFile: path.join(S, 'addons', 'Runback', 'Inbox.lua'), savedVariablesFile: path.join(S, 'nope.lua'), defaultCwd: path.join(S, 'proj'), slots: 5, progressWriteMs: 1 });
    cfg.agent = 'claude';
    cfg.agents = { ...(cfg.agents || {}), claude: { ...((cfg.agents || {}).claude || {}), path: path.join(S, 'fake-claude.js') } };
    cfg.forever = { ...(cfg.forever || {}), mentorDir: path.join(S, 'mentor-workspace') };
    fs.writeFileSync(path.join(repo, 'bridge', 'config.json'), JSON.stringify(cfg, null, 2));
    const env = { ...process.env, FAKE_INBOX: cfg.inboxFile, FAKE_SNAPSHOT: path.join(S, 'snapshot.lua'), FAKE_LOG_LINE: LOG_LINE };
    delete env.CLAUDECODE;
    const run = (args) => spawnSync(process.execPath, args, { cwd: path.join(repo, 'bridge'), encoding: 'utf8', env, timeout: 60000 });
    const inst = run(['install-slots.js']);
    assert.equal(inst.status, 0, inst.stderr);
    const r = run(['bridge.js', '--inject', 'review my last fight', '--agent', 'claude']);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // 49: while it worked, the window listed at most three phrases, none of them raw.
    const working = readReply(path.join(S, 'snapshot.lua'), 'Runback_Inbox');
    const final = readReply(cfg.inboxFile, 'Runback_Inbox');
    if (process.env.RUNBACK_DUMP) console.log('--- working ---\n' + working.text + '\n--- final ---\n' + final.text);
    assert.equal(working.status, 'working');
    const lines = working.text.split('\n');
    assert.ok(lines.length >= 1 && lines.length <= 3, working.text);
    for (const l of lines) assert.ok(P.PROGRESS_PHRASES.includes(l), `raw progress line: ${l}`);
    assert.doesNotMatch(working.text, /grep|glob|toolu_|node |\^10\/|C:\//i);

    // 50 and 54: the final reply.
    assert.equal(final.status, 'done');
    assert.doesNotMatch(final.text, /SPELL_CAST_SUCCESS|Player-4613|\d{2}\/\d{2}\/\d{4}/);
    assert.match(final.text, /Evidence: 17:41:56 Nercari cast Demon Skin/);
    assert.doesNotMatch(final.text, /\[bridge\]|\[Runback map\]|point\(s\)|layer wand|needs your OK/i);
    assert.match(final.text, /I marked 2 places on your map: open it with M\./);
    assert.doesNotMatch(final.text, /wowmap/);
  } finally {
    fs.rmSync(S, { recursive: true, force: true });
  }
});
