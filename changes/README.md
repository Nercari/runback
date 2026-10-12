# Changelog fragments

A PR that players would notice adds one file here, `changes/<slug>.md`, and does not edit `CHANGELOG.md`. Two PRs then never touch the same file. `tools/changelog.js` folds the fragments into `CHANGELOG.md` when a release is cut (`npm version <x.y.z>`), and deletes them.

- Name: a short slug of the change, for example `guide-fits-log.md` or the backlog number, `backlog-85.md`. Any name ending in `.md` works; this file is skipped.
- Content: one or more sections, `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or `### Security`, and under each one `- ` bullet per line. Keep an entry on one line, like the entries in `CHANGELOG.md`.
- A change nobody would notice (tests, internal cleanup) needs no fragment.

Example, `changes/backlog-85.md`:

```
### Fixed

- **Bag question no longer lists soulbound items as sellable (backlog 85).** The bags answer skips them. `tests/forever/addon_bags.test.js` covers it.
```

`npm test` checks that every fragment here parses. CI fails a PR that changes `CHANGELOG.md` without a version bump.
