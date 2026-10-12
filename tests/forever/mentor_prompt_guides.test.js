'use strict';
// Backlog item 72: the mentor writes leveling guides. A hard rule in mentor/AGENTS.md
// keeps every guide sourced, hand-played and free of copied or automated content.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function hardRule(name) {
  const mentor = fs.readFileSync(path.join(__dirname, '..', '..', 'mentor', 'AGENTS.md'), 'utf8');
  const start = mentor.indexOf('## Hard rules');
  const hard = mentor.slice(start, mentor.indexOf('\n## ', start + 3));
  return hard.split('\n').find(l => /^\d+\. /.test(l) && l.includes(name)) || '';
}

test('the mentor writes a guide in the GUIDE.md format, in short chunks, after at most one question', () => {
  const rule = hardRule('**Leveling guides.**');
  for (const word of ['class, race, faction, level and quest log', 'at most one question', 'docs/GUIDE.md',
    '`WOW_AI_GUIDE_FILE`', '```wowguide```', 'about one zone per guide']) assert.ok(rule.includes(word), word);
});

test('every guide carries a source and unsourced or approximate steps are not passed off as facts', () => {
  const rule = hardRule('**Leveling guides.**');
  for (const word of ['**Every guide carries a `source`**', 'every step has a stated source', 'a step you cannot source is not written',
    'rule 5', 'approximate', 'from memory', 'Classic-era', 'one source', 'rule 12']) assert.ok(rule.includes(word), word);
});

test('the mentor never copies a licensed guide and never writes automation or combat guidance', () => {
  const rule = hardRule('**Leveling guides.**');
  for (const word of ['Never copy RestedXP, Questie', 'paid or licensed', 'by hand', 'never a macro, script or `/run` line (rule 9)',
    'accepts, turns in, clicks gossip, targets or travels for the player', 'No guide text during combat', 'rule 1']) assert.ok(rule.includes(word), word);
  assert.ok(/^9\. \*\*No scripts to paste\.\*\*/m.test(fs.readFileSync(path.join(__dirname, '..', '..', 'mentor', 'AGENTS.md'), 'utf8')), 'rule 9 is still the no-scripts rule');
});

test('a re-plan starts from the current step and log and goes under a new id', () => {
  const rule = hardRule('**Leveling guides.**');
  for (const word of ['**A re-plan**', 'Re-plan button', 'current step and the quest log', 'skip what the log shows done',
    'under a new `id`', 'Pick guide']) assert.ok(rule.includes(word), word);
});
