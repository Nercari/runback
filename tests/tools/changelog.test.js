'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../../tools/changelog');

const REPO = path.join(__dirname, '..', '..');

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- old added one
- old added two

### Fixed

- old fixed

### Added

- old added three, from a merge leftover

## [0.4.0] - 2026-09-24

### Added

- shipped

[Unreleased]: https://github.com/example/runback/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/example/runback/compare/v0.3.0...v0.4.0
`;

function frag(file, text) {
  return { file, path: file, sections: C.parseFragment(text, file) };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseFragment reads sections and one-line bullets, joining a repeated section', () => {
  const s = C.parseFragment('### Fixed\n\n- **A.** one\n\n### Added\n- two\n### Fixed\n- three\n');
  assert.deepEqual(s, [
    { name: 'Fixed', bullets: ['- **A.** one', '- three'] },
    { name: 'Added', bullets: ['- two'] },
  ]);
});

test('parseFragment rejects what would corrupt the changelog', () => {
  assert.throws(() => C.parseFragment('- no heading\n'), /before the first/);
  assert.throws(() => C.parseFragment('### Misc\n- x\n'), /unknown section "Misc"/);
  assert.throws(() => C.parseFragment('### Added\nplain prose\n'), /one "- " bullet/);
  assert.throws(() => C.parseFragment('### Added\n- fine\n  continued line\n'), /one "- " bullet/);
  assert.throws(() => C.parseFragment('### Added\n\n'), /no entries/);
  assert.throws(() => C.parseFragment(''), /no entries/);
});

test('buildRelease puts fragment entries above the old ones, in file name order', () => {
  const fragments = [
    frag('a.md', '### Added\n\n- from a\n'),
    frag('b.md', '### Added\n- from b\n\n### Fixed\n- fix b\n'),
  ];
  const { text, section, used } = C.buildRelease(CHANGELOG, fragments, { version: '0.5.0', date: '2026-10-12' });
  assert.deepEqual(used, ['a.md', 'b.md']);
  assert.equal(section, [
    '## [0.5.0] - 2026-10-12',
    '',
    '### Added',
    '',
    '- from a',
    '- from b',
    '- old added one',
    '- old added two',
    '- old added three, from a merge leftover',
    '',
    '### Fixed',
    '',
    '- fix b',
    '- old fixed',
    '',
  ].join('\n'));
  assert.ok(text.startsWith('# Changelog\n\nIntro text.\n\n## [Unreleased]\n\n## [0.5.0] - 2026-10-12\n'));
  assert.ok(text.includes('## [0.4.0] - 2026-09-24\n\n### Added\n\n- shipped\n'), 'older releases are untouched');
});

test('buildRelease moves the compare links', () => {
  const { text } = C.buildRelease(CHANGELOG, [frag('a.md', '### Added\n- x\n')], { version: '0.5.0', date: '2026-10-12' });
  assert.ok(text.includes('[Unreleased]: https://github.com/example/runback/compare/v0.5.0...HEAD\n'));
  assert.ok(text.includes('[0.5.0]: https://github.com/example/runback/compare/v0.4.0...v0.5.0\n'));
  assert.ok(text.includes('[0.4.0]: https://github.com/example/runback/compare/v0.3.0...v0.4.0\n'));
});

test('buildRelease orders sections the Keep a Changelog way', () => {
  const md = '## [Unreleased]\n\n### Fixed\n- f\n\n### Added\n- a\n\n### Removed\n- r\n\n### Changed\n- c\n';
  const { section } = C.buildRelease(md, [], { version: '1.0.0', date: '2026-01-01' });
  assert.deepEqual([...section.matchAll(/^### (\w+)$/gm)].map(m => m[1]), ['Added', 'Changed', 'Removed', 'Fixed']);
});

test('buildRelease refuses a bad version, a bad date, a repeated version and an empty release', () => {
  const ok = [frag('a.md', '### Added\n- x\n')];
  assert.throws(() => C.buildRelease(CHANGELOG, ok, { version: 'v1', date: '2026-10-12' }), /not a version/);
  assert.throws(() => C.buildRelease(CHANGELOG, ok, { version: '0.5.0', date: 'today' }), /not a date/);
  assert.throws(() => C.buildRelease(CHANGELOG, ok, { version: '0.4.0', date: '2026-10-12' }), /already has a section for 0.4.0/);
  assert.throws(() => C.buildRelease('## [Unreleased]\n\n## [0.4.0] - x\n', [], { version: '0.5.0', date: '2026-10-12' }), /nothing to release/);
  assert.throws(() => C.buildRelease('# Changelog\n', ok, { version: '0.5.0', date: '2026-10-12' }), /no "## \[Unreleased\]"/);
});

test('releaseNotes returns one version without its heading or the link block', () => {
  const { text } = C.buildRelease(CHANGELOG, [frag('a.md', '### Added\n- new\n')], { version: '0.5.0', date: '2026-10-12' });
  assert.equal(C.releaseNotes(text, '0.5.0').split('\n')[0], '### Added');
  assert.ok(!C.releaseNotes(text, '0.5.0').includes('shipped'));
  assert.ok(!C.releaseNotes(text, '0.4.0').includes('[Unreleased]:'));
  assert.equal(C.releaseNotes(text, '0.4.0'), '### Added\n\n- shipped\n');
  assert.throws(() => C.releaseNotes(text, '9.9.9'), /no section for 9.9.9/);
});

test('the cli builds CHANGELOG.md from changes/ and deletes the fragments; a dry run changes nothing', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'changes'));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  fs.writeFileSync(path.join(root, 'changes', 'one.md'), '### Fixed\n- fix one\n');
  fs.writeFileSync(path.join(root, 'changes', 'README.md'), 'not a fragment\n');
  let said = '';
  const io = { root, out: s => { said += s; } };

  assert.equal(C.cli(['release', '0.5.0', '--date', '2026-10-12', '--dry-run'], io), 0);
  assert.ok(said.includes('## [0.5.0] - 2026-10-12') && said.includes('one.md'));
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
  assert.ok(fs.existsSync(path.join(root, 'changes', 'one.md')));

  assert.equal(C.cli(['release', '0.5.0', '--date', '2026-10-12'], io), 0);
  const built = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.ok(built.includes('### Fixed\n\n- fix one\n- old fixed\n'));
  assert.ok(!fs.existsSync(path.join(root, 'changes', 'one.md')), 'folded fragment is removed');
  assert.ok(fs.existsSync(path.join(root, 'changes', 'README.md')), 'the readme stays');
  assert.equal(C.cli(['notes', '0.5.0'], { root, out: s => { said = s; } }), 0);
  assert.ok(said.includes('- fix one'));
});

test('a release takes its version from npm_package_version when none is given', (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  const before = process.env.npm_package_version;
  process.env.npm_package_version = '0.6.0';
  t.after(() => { if (before === undefined) delete process.env.npm_package_version; else process.env.npm_package_version = before; });
  C.cli(['release', '--date', '2026-10-12'], { root, out: () => {} });
  assert.ok(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## [0.6.0] - 2026-10-12'));
});

test('the real CHANGELOG.md and every fragment in changes/ are accepted by the build', () => {
  const real = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const fragments = C.loadFragments(path.join(REPO, 'changes'));
  const probe = frag('zz-probe.md', '### Added\n- probe entry\n');
  const { section } = C.buildRelease(real, [...fragments, probe], { version: '99.0.0', date: '2026-01-01' });
  assert.ok(section.includes('- probe entry'));
  const old = C.parseUnreleased(C.splitChangelog(real).unreleased).sections.reduce((n, x) => n + x.bullets.length, 0);
  const folded = section.split('\n').filter(l => l.startsWith('- ')).length;
  assert.equal(folded, old + fragments.reduce((n, f) => n + f.sections.reduce((m, x) => m + x.bullets.length, 0), 0) + 1, 'no entry lost or added');
});

test('release marker: CHANGELOG.md may change only with a version bump', () => {
  const f = C.changelogEditedWithoutRelease;
  assert.equal(f({ changedFiles: ['CHANGELOG.md', 'x.js'], baseVersion: '0.4.0', headVersion: '0.4.0' }), true);
  assert.equal(f({ changedFiles: ['CHANGELOG.md', 'package.json'], baseVersion: '0.4.0', headVersion: '0.5.0' }), false);
  assert.equal(f({ changedFiles: ['changes/a.md', 'x.js'], baseVersion: '0.4.0', headVersion: '0.4.0' }), false);
});

function gitIn(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repoWith(t, scripts) {
  const dir = tmp(t);
  gitIn(dir, 'init', '-q', '-b', 'forever');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.mkdirSync(path.join(dir, 'changes'));
  fs.copyFileSync(path.join(REPO, 'tools', 'changelog.js'), path.join(dir, 'tools', 'changelog.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.4.0', scripts }, null, 2));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), CHANGELOG);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('check passes for a PR that only adds a fragment and fails when it edits CHANGELOG.md', (t) => {
  const dir = repoWith(t, {});
  gitIn(dir, 'checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(dir, 'changes', 'a.md'), '### Added\n- x\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'fragment');
  assert.equal(C.check({ base: 'forever', cwd: dir }), true);

  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '\nstray edit\n');
  gitIn(dir, 'commit', '-q', '-am', 'edit changelog');
  assert.equal(C.check({ base: 'forever', cwd: dir }), false);

  const r = spawnSync(process.execPath, ['tools/changelog.js', 'check', '--base', 'forever'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /changes\/<slug>\.md/);
});

test('check ignores edits that master has and the PR does not (three-dot diff)', (t) => {
  const dir = repoWith(t, {});
  gitIn(dir, 'checkout', '-q', '-b', 'pr');
  fs.writeFileSync(path.join(dir, 'changes', 'a.md'), '### Added\n- x\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'fragment');
  gitIn(dir, 'checkout', '-q', 'forever');
  fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '\nrelease edit on the base\n');
  gitIn(dir, 'commit', '-q', '-am', 'base moved');
  gitIn(dir, 'checkout', '-q', 'pr');
  assert.equal(C.check({ base: 'forever', cwd: dir }), true);
});

test('the real release path: `npm version` builds the changelog, drops the fragments and tags', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.version, /changelog\.js release/, 'package.json wires the build into the version step');
  const dir = repoWith(t, { version: pkg.scripts.version });
  fs.writeFileSync(path.join(dir, 'changes', 'one.md'), '### Fixed\n- fix one\n');
  fs.writeFileSync(path.join(dir, 'changes', 'two.md'), '### Added\n- add two\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'two PRs landed');

  // Windows needs a shell to find npm.cmd.
  const r = spawnSync('npm', ['version', 'minor'], {
    cwd: dir, encoding: 'utf8', shell: process.platform === 'win32',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.5.0');
  assert.equal(gitIn(dir, 'tag'), 'v0.5.0');
  assert.equal(gitIn(dir, 'status', '--porcelain'), '', 'the release commit holds the changelog and the deleted fragments');
  const built = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(built, /## \[0\.5\.0\] - \d{4}-\d{2}-\d{2}\n/);
  assert.ok(built.includes('- add two\n- old added one'));
  assert.ok(built.includes('- fix one\n- old fixed'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'changes')), []);
  assert.ok(gitIn(dir, 'show', '--stat', '--format=', 'HEAD').includes('changes/one.md'));
  assert.ok(C.releaseNotes(built, '0.5.0').includes('- add two'), 'the release page text is available after the build');
});
