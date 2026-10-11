'use strict';
// Backlog 48 (reopens 30): the mentor's tool commands must match the Bash rules the
// bridge passes to Claude, or each review stops to ask for permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mentor = require('../../bridge/forever/modules/05-mentor-guard');

const ROOT = path.join(__dirname, '..', '..');
const REPO = '/home/me/wow-ai';

// Claude Code's Bash rule semantics: `Bash(prefix:*)` matches a command equal to the
// prefix or starting with `prefix `; any other `Bash(x)` is an exact match. A compound
// command (&&, ||, ;, |) needs every part allowed, so `cd X && node ...` is judged as
// `cd X` (no rule) and `node ...`.
function parts(cmd) { return cmd.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean); }
function ruleAllows(rule, cmd) {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const body = m[1];
  if (body.endsWith(':*')) { const p = body.slice(0, -2); return cmd === p || cmd.startsWith(p + ' '); }
  return cmd === body;
}
function allowed(rules, cmd) { return parts(cmd).every(p => rules.some(r => ruleAllows(r, p))); }

// The `node <repo>/tools/...` lines written in mentor/AGENTS.md, with placeholders filled in
// and the path in the platform's own form, as the bridge builds its rules.
function mentorCommands() {
  const text = fs.readFileSync(path.join(ROOT, 'mentor', 'AGENTS.md'), 'utf8');
  const out = [];
  for (const m of text.matchAll(/`(node <repo>\/tools\/(slice-fight|check-citations)\.js[^`]*)`/g)) {
    out.push(m[1].replace(/<repo>\/tools\//g, path.join(REPO, 'tools') + path.sep).replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, 'x').replace(/\s+/g, ' ').trim());
  }
  return out;
}
const guardRules = () => mentor.rewrite('claude', ['--allowedTools', 'Bash(*)'], '/mentor', REPO).filter(a => a.startsWith('Bash('));
const exampleRules = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'config.example.json'), 'utf8')).agents.claude.allowedTools;

test('mentor/AGENTS.md names both tool commands as one plain node command', () => {
  const cmds = mentorCommands();
  assert.equal(cmds.filter(c => c.includes('slice-fight.js')).length, 1);
  assert.equal(cmds.filter(c => c.includes('check-citations.js')).length, 1);
  for (const c of cmds) assert.ok(!/&&|\||;|\bcd\b|>/.test(c), `not a plain command: ${c}`);
  const text = fs.readFileSync(path.join(ROOT, 'mentor', 'AGENTS.md'), 'utf8');
  assert.match(text, /[Nn]ever (put|prefix)[^.]*`cd/);
});

test('the commands in mentor/AGENTS.md match the mentor chat rules and the example config', () => {
  for (const c of mentorCommands()) {
    assert.ok(allowed(guardRules(), c), `mentor-guard rules block: ${c}`);
    assert.ok(allowed(exampleRules(), c), `config.example.json rules block: ${c}`);
  }
});

test('the old cd ... && node form does not match (the cause of the repeated prompt)', () => {
  const rules = exampleRules();
  assert.ok(rules.includes('Bash(node:*)'));
  assert.ok(!rules.some(r => ruleAllows(r, `cd ${REPO}`)), 'no rule should allow cd');
  for (const c of mentorCommands()) {
    const old = `cd ${REPO} && ${c}`;
    assert.equal(allowed(rules, old), false, old);
    assert.equal(allowed(guardRules(), old), false, old);
  }
});

test('the example local file shows the plain unquoted slicer command', () => {
  const t = fs.readFileSync(path.join(ROOT, 'mentor', 'LOCAL.example.md'), 'utf8');
  assert.ok(!/node "/.test(t) && !/\bcd\b/.test(t));
});
