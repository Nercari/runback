'use strict';
// Backlog item 59: a shared pin at 9.7, 63.9 came back as "around 10.5, 64.2", and
// Classic-era or one-page marks were not labelled. A hard rule in mentor/AGENTS.md
// keeps the player's coordinates verbatim and labels approximate or single-source points.
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

test('the mentor repeats the player\'s coordinates exactly as given', () => {
  const rule = hardRule('**Coordinates as given.**');
  for (const word of ['`/mappin`', 'exactly as given', 'never rounded', '"9.7, 63.9"']) assert.ok(rule.includes(word), word);
});

test('the mentor labels approximate, Classic-era and single-source points, in the reply and on the map', () => {
  const rule = hardRule('**Coordinates as given.**');
  for (const word of ['approximate', 'from memory', 'Classic-era', 'one source', 'map label']) assert.ok(rule.includes(word), word);
});
