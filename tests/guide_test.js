// Guide files: validation, sanitising and limits (docs/GUIDE.md).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../bridge/guide');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'guides', name + '.json'), 'utf8');
const note = (text = 'x', extra = {}) => ({ kind: 'note', text, ...extra });
const guide = (steps, extra = {}) => ({ id: 'g', steps, ...extra });
const hasEscape = v => /[\x00-\x1f\x7f|]/.test(JSON.stringify(v).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\[ntr]/g, ''));

test('valid fixture passes through unchanged', () => {
  const r = G.parseGuideText(fixture('valid'));
  assert.deepEqual(r.why, []);
  assert.equal(r.guides.length, 1);
  assert.deepEqual(r.guides[0], JSON.parse(fixture('valid')));
});

test('hostile fixture: no throw, no escape codes, no pollution, junk dropped', () => {
  const r = G.parseGuideText(fixture('hostile'));
  assert.equal(r.guides.map(g => g.id).join(), 'evil,deep');
  assert.ok(!hasEscape(r.guides), 'no control chars or pipes survive');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const evil = r.guides[0];
  assert.deepEqual(Object.keys(evil).sort(), ['id', 'source', 'steps', 'title']);
  assert.ok(!evil.steps.some(s => s.kind === 'run_macro'));
  assert.ok(!evil.steps.some(s => s.text === '42'), 'a number is not text');
  assert.equal(evil.steps[0].questId, undefined, 'string questId dropped');
  assert.deepEqual(evil.steps[0].points.map(p => p.label), ['ok r']);
  assert.deepEqual(evil.steps.find(s => s.class).class, ['cffAAAAAAMage', 'Rogue', 'x'.repeat(24)]);
  assert.equal(evil.steps.find(s => s.class).faction, undefined);
  assert.equal(evil.steps.find(s => s.class).optional, undefined);
  assert.ok(r.why.some(w => /unknown kind/.test(w)));
  assert.ok(r.why.some(w => /bad id/.test(w)));
});

test('bad-coords fixture: clamped, rounded, invalid points dropped', () => {
  const g = G.parseGuideText(fixture('bad-coords')).guides[0];
  assert.deepEqual(g.steps[0].points, [
    { m: 1429, x: 100, y: 0 },
    { m: 1429, x: 33.33, y: 66.67, radius: 25 },
    { m: 1429, x: 10, y: 10, radius: 0.5 },
  ]);
});

test('non-JSON, non-object and odd inputs never throw', () => {
  assert.deepEqual(G.parseGuideText('{nope').guides, []);
  assert.deepEqual(G.parseGuideText(undefined).guides, []);
  for (const v of [null, undefined, 5, 'x', [], true, () => 1, Symbol('s')]) {
    assert.equal(G.validateGuide(v), null);
    assert.deepEqual(G.validateGuideSet(v).guides, []);
  }
  const proxy = new Proxy({}, { get() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } });
  assert.equal(G.validateGuide(proxy), null);
  const cyclic = { id: 'c', steps: [] }; cyclic.steps.push(cyclic);
  assert.equal(G.validateGuide(cyclic), null);
});

test('guide fields: id pattern, title fallback, levels, faction, source', () => {
  for (const id of ['', 'a b', 'x'.repeat(33), 'a|b', 5, null]) assert.equal(G.validateGuide(guide([note()], { id })), null);
  assert.equal(G.validateGuide({ id: 'A_b.c-1', steps: [note()] }).id, 'A_b.c-1');
  assert.equal(G.validateGuide(guide([note()])).title, 'g');
  assert.equal(G.validateGuide(guide([note()], { title: 'T'.repeat(500) })).title.length, 80);
  const g = G.validateGuide(guide([note()], { minLevel: 99.4, maxLevel: -5, faction: 'horde', source: 'S'.repeat(500), extra: 1 }));
  assert.deepEqual([g.minLevel, g.maxLevel], [1, 70]);
  assert.equal(g.faction, 'Horde');
  assert.equal(g.source.length, 120);
  assert.equal(g.extra, undefined);
  assert.equal(G.validateGuide(guide([note()], { faction: 'Neutral' })).faction, undefined);
  assert.equal(G.validateGuide(guide([])), null);
  assert.equal(G.validateGuide(guide([5, null])), null);
});

test('step fields: kinds, text cap, quest, questId, unknown fields dropped', () => {
  for (const kind of G.GUIDE_KINDS) assert.equal(G.validateGuide(guide([{ kind, text: 't' }])).steps[0].kind, kind);
  assert.equal(G.GUIDE_KINDS.size, 7);
  const s = G.validateGuide(guide([note('T'.repeat(900), { quest: 'Q'.repeat(900), questId: 12, macro: '/cast', run: true })])).steps[0];
  assert.equal(s.text.length, 200);
  assert.equal(s.quest.length, 80);
  assert.deepEqual(Object.keys(s).sort(), ['kind', 'questId', 'quest', 'text'].sort());
  for (const questId of [0, -1, 1.5, '3', NaN, Infinity, 2 ** 40]) assert.equal(G.validateGuide(guide([note('x', { questId })])).steps[0].questId, undefined);
  assert.equal(G.validateGuide(guide([note('   ')])), null);
  assert.equal(G.validateGuide(guide([note('x', { kind: 'cast' }), note('y')])).steps.length, 1);
});

test('points: cap per step, uiMapID range, label and radius', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ m: 1429, x: i, y: i }));
  const why = [];
  const s = G.validateGuide(guide([note('x', { points: pts })]), why).steps[0];
  assert.equal(s.points.length, 8);
  assert.ok(why.some(w => /first 8 points/.test(w)));
  const p = G.validateGuide(guide([note('x', { points: [{ m: 99999, x: 1, y: 1, label: 'a|b' + 'z'.repeat(200) }, { m: 100000, x: 1, y: 1 }, { m: 0, x: 1, y: 1 }] })])).steps[0].points;
  assert.equal(p.length, 1);
  assert.ok(p[0].label.length <= 60 && !p[0].label.includes('|'));
  assert.equal(G.validateGuide(guide([note('x', { points: [{ m: 1, x: NaN, y: 1 }] })])).steps[0].points, undefined);
  assert.equal(G.validateGuide(guide([note('x', { points: 'nope' })])).steps[0].points, undefined);
});

test('level, class, race and faction filters', () => {
  const s = G.validateGuide(guide([note('x', { level: { min: 90, max: 0 }, class: ['Mage', 'Mage', 'Druid', '1x', ''], race: 'Human', faction: 'ALLIANCE' })])).steps[0];
  assert.deepEqual(s.level, { min: 1, max: 70 });
  assert.deepEqual(s.class, ['Mage', 'Druid']);
  assert.equal(s.race, undefined);
  assert.equal(s.faction, 'Alliance');
  assert.deepEqual(G.validateGuide(guide([note('x', { level: { min: 12 } })])).steps[0].level, { min: 12 });
  assert.equal(G.validateGuide(guide([note('x', { level: { min: 'a' } })])).steps[0].level, undefined);
  const many = Array.from({ length: 40 }, (_, i) => 'Name' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)));
  assert.equal(G.validateGuide(guide([note('x', { class: many })])).steps[0].class.length, 12);
});

test('requires and exclusive: quest id lists, deduplicated, capped at 12, junk dropped', () => {
  const s = G.validateGuide(guide([note('x', { requires: [101, 101, 0, -3, 1.5, '102', 2 ** 31, 102], exclusive: [7, null, { id: 8 }] })])).steps[0];
  assert.deepEqual(s.requires, [101, 102]);
  assert.deepEqual(s.exclusive, [7]);
  const many = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.equal(G.validateGuide(guide([note('x', { requires: many })])).steps[0].requires.length, 12);
  for (const bad of [101, 'x', {}, [], [0, 'a'], { __proto__: [1] }]) {
    const t = G.validateGuide(guide([note('x', { requires: bad, exclusive: bad })])).steps[0];
    assert.equal(t.requires, undefined, JSON.stringify(bad));
    assert.equal(t.exclusive, undefined, JSON.stringify(bad));
  }
});

test('rep: faction id and a standing written as a number or a name, clamped to 1..8', () => {
  const rep = v => G.validateGuide(guide([note('x', { rep: v })])).steps[0].rep;
  assert.deepEqual(rep({ faction: 72, standing: 5 }), { faction: 72, standing: 5 });
  assert.deepEqual(rep({ faction: 72, standing: ' Honored ' }), { faction: 72, standing: 6 });
  assert.deepEqual(rep({ faction: 72, standing: 99, extra: '|cff' }), { faction: 72, standing: 8 });
  assert.deepEqual(rep({ faction: 72, standing: -4 }), { faction: 72, standing: 1 });
  const why = [];
  for (const bad of [{ faction: 'Stormwind', standing: 5 }, { faction: 0, standing: 5 }, { faction: 100000, standing: 5 },
    { faction: 72 }, { faction: 72, standing: 'Best friends' }, { faction: 72, standing: NaN }, 'Exalted', [72, 5]]) {
    assert.equal(G.validateGuide(guide([note('x', { rep: bad })]), why).steps[0].rep, undefined, JSON.stringify(bad));
  }
  assert.match(why[0], /step 1: dropped invalid rep/);
});

test('profession: a name and the rank needed, 1 when not given, clamped to 1..450', () => {
  const prof = v => G.validateGuide(guide([note('x', { profession: v })])).steps[0].profession;
  assert.deepEqual(prof({ name: 'First Aid', skill: 40 }), { name: 'First Aid', skill: 40 });
  assert.deepEqual(prof({ name: 'Herbalism' }), { name: 'Herbalism', skill: 1 });
  assert.deepEqual(prof({ name: 'Mining', skill: 9000 }), { name: 'Mining', skill: 450 });
  assert.deepEqual(prof({ name: 'Mining', skill: 0.2 }), { name: 'Mining', skill: 1 });
  for (const bad of [{ name: '|cffff0000Mining' }, { name: '' }, { name: 5 }, { name: 'Mining2' }, 'Mining', null]) {
    assert.equal(prof(bad), undefined, JSON.stringify(bad));
  }
});

test('flags are true or absent; completewith points at a later step', () => {
  const g = G.validateGuide(guide([
    note('a', { optional: true, sticky: 1, completewith: 3 }),
    note('b', { completewith: 2 }),   // not later
    note('c', { completewith: 99 }),  // past the end
    note('d'),
  ]));
  assert.equal(g.steps[0].optional, true);
  assert.equal(g.steps[0].sticky, undefined);
  assert.equal(g.steps[0].completewith, 3);
  assert.equal(g.steps[1].completewith, undefined);
  assert.equal(g.steps[2].completewith, undefined);
  for (const bad of [0, -1, 1.5, '2', NaN]) assert.equal(G.validateGuide(guide([note('a', { completewith: bad }), note('b')])).steps[0].completewith, undefined);
});

test('completewith follows its target when earlier steps are dropped, and is dropped with it', () => {
  const g = G.validateGuide(guide([5, note('a', { completewith: 4 }), note('b'), note('c')]));
  assert.equal(g.steps[0].completewith, 3);
  assert.equal(g.steps[2].text, 'c');
  const h = G.validateGuide(guide([note('a', { completewith: 2 }), { kind: 'bogus', text: 'x' }, note('c')]));
  assert.equal(h.steps[0].completewith, undefined);
});

test('oversized guide keeps the first 600 steps', () => {
  const steps = Array.from({ length: 700 }, (_, i) => note('s' + i));
  const why = [];
  const g = G.validateGuide(guide(steps), why);
  assert.equal(g.steps.length, 600);
  assert.equal(g.steps[599].text, 's599');
  assert.ok(why.some(w => /first 600 of 700/.test(w)));
  assert.equal(G.validateGuide(guide(Array.from({ length: 600 }, () => note()))).steps.length, 600);
});

test('a set keeps the newest 12 guides; a repeated id is replaced by its later copy', () => {
  const list = Array.from({ length: 15 }, (_, i) => ({ id: 'g' + i, steps: [note('n' + i)] }));
  const r = G.validateGuideSet(list);
  assert.deepEqual(r.guides.map(g => g.id), list.slice(3).map(g => g.id));
  assert.ok(r.why.some(w => /newest 12 of 15/.test(w)));
  const dup = G.validateGuideSet([{ id: 'a', steps: [note('old')] }, { id: 'b', steps: [note()] }, { id: 'a', steps: [note('new')] }]);
  assert.deepEqual(dup.guides.map(g => g.id), ['b', 'a']);
  assert.equal(dup.guides[1].steps[0].text, 'new');
  assert.deepEqual(G.validateGuideSet({ id: 'a' }).guides, []);
});

test('parseGuideText accepts one guide or a list, and ignores prototype keys', () => {
  assert.equal(G.parseGuideText(JSON.stringify(guide([note()]))).guides.length, 1);
  assert.equal(G.parseGuideText(JSON.stringify([guide([note()]), { ...guide([note()]), id: 'h' }])).guides.length, 2);
  const r = G.parseGuideText('{"id":"p","__proto__":{"polluted":1},"steps":[{"kind":"note","text":"x","__proto__":{"polluted":1}}]}');
  assert.equal(r.guides.length, 1);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.guides[0]), Object.prototype);
  assert.equal(Object.keys(r.guides[0].steps[0]).includes('__proto__'), false);
});
