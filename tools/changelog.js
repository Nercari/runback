#!/usr/bin/env node
'use strict';
// Release notes without merge conflicts.
//
// A PR never edits CHANGELOG.md. It adds one small file, changes/<slug>.md,
// so two PRs that run in parallel touch different files. CHANGELOG.md is
// built from those files only when a release is cut.
//
//   node tools/changelog.js release [<version>] [--date YYYY-MM-DD] [--dry-run]
//       Folds changes/*.md and the current [Unreleased] text into a new
//       "## [<version>] - <date>" section, leaves [Unreleased] empty, moves the
//       compare links, and deletes the folded fragments. The version comes from
//       the argument or from npm_package_version (set by `npm version`).
//   node tools/changelog.js notes <version>
//       Prints that version's section: the text for a release page.
//   node tools/changelog.js lint
//       Checks every fragment parses. `npm test` runs the same check.
//   node tools/changelog.js check [--base <git ref>]
//       Fails when CHANGELOG.md differs from <ref> (default origin/forever)
//       without a package.json version bump. A release bumps the version, a
//       normal PR does not.
//
// Fragment format (changes/README.md has an example): one or more
// "### <Section>" headings, then one "- " bullet per line. Sections are
// Added, Changed, Deprecated, Removed, Fixed, Security.
//
// Dependency-free on purpose, like the bridge.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

class ChangelogError extends Error {}

// A fragment's sections: [{ name, bullets: ['- ...', ...] }] in file order.
function parseFragment(text, label = 'fragment') {
  const out = [];
  let current = null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    const head = /^###\s+(.+?)\s*$/.exec(line);
    if (head) {
      if (!SECTIONS.includes(head[1])) {
        throw new ChangelogError(`${label}:${i + 1}: unknown section "${head[1]}" (use ${SECTIONS.join(', ')})`);
      }
      current = out.find(s => s.name === head[1]);
      if (!current) { current = { name: head[1], bullets: [] }; out.push(current); }
      return;
    }
    if (!current) throw new ChangelogError(`${label}:${i + 1}: text before the first "### Section" heading`);
    if (!line.startsWith('- ')) {
      throw new ChangelogError(`${label}:${i + 1}: every line under a section is one "- " bullet (keep each entry on one line)`);
    }
    current.bullets.push(line);
  });
  if (!out.length || out.every(s => !s.bullets.length)) throw new ChangelogError(`${label}: no entries`);
  return out.filter(s => s.bullets.length);
}

// Fragment files in changes/, sorted by name so a build is repeatable.
function loadFragments(dir = path.join(ROOT, 'changes')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map(f => ({ file: f, path: path.join(dir, f), sections: parseFragment(fs.readFileSync(path.join(dir, f), 'utf8'), `changes/${f}`) }));
}

// Splits CHANGELOG.md around its [Unreleased] section.
function splitChangelog(text) {
  const src = text.replace(/\r\n/g, '\n');
  const start = src.search(/^## \[Unreleased\]\s*$/m);
  if (start < 0) throw new ChangelogError('CHANGELOG.md has no "## [Unreleased]" heading');
  const afterHead = src.indexOf('\n', start) + 1;
  const next = src.slice(afterHead).search(/^## \[/m);
  const end = next < 0 ? src.length : afterHead + next;
  return { before: src.slice(0, start), unreleased: src.slice(afterHead, end), after: src.slice(end) };
}

// The text of [Unreleased] as { intro, sections }. Sections that repeat
// (a merge leftover) are joined in the order they first appear.
function parseUnreleased(body) {
  const intro = [];
  const sections = [];
  let current = null;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const head = /^###\s+(.+?)\s*$/.exec(line);
    if (head) {
      current = sections.find(s => s.name === head[1]);
      if (!current) { current = { name: head[1], bullets: [] }; sections.push(current); }
    } else if (line.trim()) {
      (current ? current.bullets : intro).push(line);
    }
  }
  return { intro, sections: sections.filter(s => s.bullets.length) };
}

function orderSections(sections) {
  const rank = n => { const i = SECTIONS.indexOf(n); return i < 0 ? SECTIONS.length : i; };
  return sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.name) - rank(b.s.name) || a.i - b.i).map(x => x.s);
}

function renderSection(version, date, intro, sections) {
  const lines = [`## [${version}] - ${date}`, ''];
  if (intro.length) lines.push(...intro, '');
  for (const s of orderSections(sections)) lines.push(`### ${s.name}`, '', ...s.bullets, '');
  return lines.join('\n');
}

// The compare links at the foot: [Unreleased] moves to the new tag and the
// new version gets a link from the previous one.
function moveLinks(after, version, previous) {
  const unreleased = /^\[Unreleased\]: (.*)\/compare\/v[^/]+\.\.\.HEAD\s*$/m.exec(after);
  if (!unreleased) return after;
  const repo = unreleased[1];
  const newLines = [`[Unreleased]: ${repo}/compare/v${version}...HEAD`];
  if (previous) newLines.push(`[${version}]: ${repo}/compare/v${previous}...v${version}`);
  return after.replace(unreleased[0], newLines.join('\n'));
}

// Pure: returns { text, section, used } without touching the disk.
function buildRelease(changelogText, fragments, { version, date }) {
  if (!SEMVER.test(version || '')) throw new ChangelogError(`"${version}" is not a version like 1.2.3`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new ChangelogError(`"${date}" is not a date like 2026-10-12`);
  const parts = splitChangelog(changelogText);
  if (new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\]`, 'm').test(parts.after)) {
    throw new ChangelogError(`CHANGELOG.md already has a section for ${version}`);
  }
  const { intro, sections } = parseUnreleased(parts.unreleased);
  // Fragment entries go above the entries already in [Unreleased], in file name order.
  const merged = [];
  const add = (name, bullets, front) => {
    let s = merged.find(x => x.name === name);
    if (!s) { s = { name, bullets: [] }; merged.push(s); }
    s.bullets = front ? [...s.bullets, ...bullets] : [...bullets, ...s.bullets];
  };
  for (const s of sections) add(s.name, s.bullets, true);
  for (const f of [...fragments].reverse()) for (const s of f.sections) add(s.name, s.bullets, false);
  if (!merged.length) throw new ChangelogError('nothing to release: no fragments in changes/ and [Unreleased] is empty');
  const section = renderSection(version, date, intro, merged);
  const previous = (/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(parts.after) || [])[1];
  const after = moveLinks(parts.after, version, previous);
  const text = `${parts.before}## [Unreleased]\n\n${section}${after}`;
  return { text, section, used: fragments.map(f => f.file) };
}

// The body of "## [version]" for a release page.
function releaseNotes(changelogText, version) {
  const src = changelogText.replace(/\r\n/g, '\n');
  const m = new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\][^\\n]*\\n`, 'm').exec(src);
  if (!m) throw new ChangelogError(`CHANGELOG.md has no section for ${version}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/^(## \[|\[[^\]]+\]: )/m);
  return rest.slice(0, next < 0 ? rest.length : next).trim() + '\n';
}

// The release marker: CHANGELOG.md may change only in a diff that also bumps
// the package.json version.
function changelogEditedWithoutRelease({ changedFiles, baseVersion, headVersion }) {
  return changedFiles.includes('CHANGELOG.md') && baseVersion === headVersion;
}

function git(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new ChangelogError(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function check({ base = 'origin/forever', cwd = ROOT } = {}) {
  const changedFiles = git(['diff', '--name-only', `${base}...HEAD`], cwd).split('\n').filter(Boolean);
  const version = text => JSON.parse(text).version;
  const baseVersion = version(git(['show', `${base}:package.json`], cwd));
  const headVersion = version(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  return !changelogEditedWithoutRelease({ changedFiles, baseVersion, headVersion });
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

function cli(argv, io = {}) {
  const root = io.root || ROOT;
  const out = io.out || (s => process.stdout.write(s));
  const [cmd, ...rest] = argv;
  const file = path.join(root, 'CHANGELOG.md');
  const dir = path.join(root, 'changes');
  if (cmd === 'release') {
    const version = rest.find(a => !a.startsWith('--') && a !== argValue(rest, '--date')) || process.env.npm_package_version;
    const date = argValue(rest, '--date') || new Date().toISOString().slice(0, 10);
    const fragments = loadFragments(dir);
    const built = buildRelease(fs.readFileSync(file, 'utf8'), fragments, { version, date });
    if (rest.includes('--dry-run')) {
      out(`${built.section}\nWould delete ${built.used.length} fragment(s): ${built.used.join(', ') || 'none'}\n`);
      return 0;
    }
    fs.writeFileSync(file, built.text);
    for (const f of fragments) fs.unlinkSync(f.path);
    out(`CHANGELOG.md: ${version} built from ${built.used.length} fragment(s) and the old [Unreleased] text\n`);
    return 0;
  }
  if (cmd === 'notes') {
    if (!rest[0]) throw new ChangelogError('usage: changelog.js notes <version>');
    out(releaseNotes(fs.readFileSync(file, 'utf8'), rest[0]));
    return 0;
  }
  if (cmd === 'lint') {
    out(`${loadFragments(dir).length} fragment(s) ok\n`);
    return 0;
  }
  if (cmd === 'check') {
    const ok = check({ base: argValue(rest, '--base') || 'origin/forever', cwd: root });
    out(ok ? 'CHANGELOG.md untouched (or a release): ok\n'
      : 'CHANGELOG.md changed without a version bump. Add changes/<slug>.md instead; see CONTRIBUTING.md.\n');
    return ok ? 0 : 1;
  }
  throw new ChangelogError('usage: changelog.js release [version] [--date D] [--dry-run] | notes <version> | lint | check [--base ref]');
}

if (require.main === module) {
  try { process.exit(cli(process.argv.slice(2))); }
  catch (err) {
    if (!(err instanceof ChangelogError)) throw err;
    process.stderr.write(`changelog: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  ChangelogError,
  SECTIONS,
  parseFragment,
  loadFragments,
  splitChangelog,
  parseUnreleased,
  buildRelease,
  releaseNotes,
  changelogEditedWithoutRelease,
  check,
  cli,
};
