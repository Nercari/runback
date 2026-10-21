# Runback (WoW: Forever mentor)

Nercari's Runback (`https://github.com/Nercari/runback`, MIT), forked from chelinho139: chat with local coding agents from inside World of Warcraft: Forever, plus an after-combat mentor. Goals and backlog: `docs/spec.md`. How it works: `docs/ARCHITECTURE.md`, `docs/FOREVER.md`. Conventions and the test table: `CONTRIBUTING.md`.

`mentor/AGENTS.md` and `docs/AGENTS.md` are product files (the in-game coach's prompt and the agent-CLI guide), not instructions for working on this repo.

## Blizzard policy (permanent rule, Nercari, 2026-10-03)

Runback must comply 100% with Blizzard's Terms of Service, EULA and UI add-on policy at all times. Any feature, change or idea that could breach them is rejected, however useful. When in doubt, don't ship it and ask Nercari on nercari-control #114.

- Check every PR against `docs/COMPLIANCE.md` and say in the PR that you did. It lists the sources, what each clause means for this repo, and the open questions waiting on Nercari.
- The addon only uses the game's own UI API, never replaces Blizzard functions or frame methods (hook them with `hooksecurefunc`), never calls protected or hardware-event actions outside a real keypress or click, and never performs gameplay, economy or targeting actions for the player.
- No advertising, donation requests, paid features or hidden code in the addon (UI add-on policy rules 1, 2, 4, 5).
- Agent replies never hand out code that plays for the player. Settings are given as menu paths, not `/run` scripts.
- `tools/safety-ci.js` enforces what it can (`LUA-TAINT`, `POLICY-SOLICIT`, protected automation, input and memory APIs, obfuscation). Where a new risk can be checked by code, add the check.

## Working here

- Default branch is `forever`. Every change is a PR into it, one change per PR, on a `claude/` / `cursor/` / `exec/` branch matching the issue's owner label, verified by the **other division** before merge.
- Work without check-ins (Nercari, 2026-10-03). Once CI is green and the required review returns PASS, merge the PR yourself and start the next backlog item; never ask Nercari to merge, approve or type "continue". The merge gate is the one in the `## Nercari HQ` block below: real `VERIFY.md` output in the PR body, green checks, not a draft, and for a risky PR `verify:grok` plus a signed `VERIFIER: PASS` from an agent that did not write it. Stop and ask only for: publishing or messaging outside GitHub, spending money, deleting data without a backup, force-push, or a goal/direction decision. Put those on nercari-control #114 and keep working on anything else.
- `npm ci`, then `node tools/safety-ci.js` and `npm test` must pass (CI runs both on Windows and Linux). Add or extend a test for every behaviour change; update `docs/` and add a `changes/<slug>.md` release-note fragment when users would notice; never edit `CHANGELOG.md` in a PR (`CONTRIBUTING.md`, "Release notes"). `VERIFY.md` holds commands only; results go in the PR body with the head SHA they ran at.
- The bridge stays dependency-free; the addon uses only APIs in the Forever client.
- Large work (several PRs or a new feature) starts as a numbered item in `docs/spec.md`.

## Never

- Add anything that plays for the player, reads game memory, injects code or generates input, or gives live combat help. Never weaken `tools/safety-ci.js`, `tools/safety-allow.json` or `tools/lua-allow.json` to get green.
- Commit personal data: character notebooks, combat logs, screenshots, `bridge/config.json`, the live `wow-mentor/` workspace.
- Publish (public fork, upstream PR, forum post) or message anyone outside GitHub without Nercari's OK.
- Claim an in-game result without a live check. Only Nercari can run the game; give him a short checklist.

## Nercari HQ

Managed by Nercari HQ; follow `hq/managed-projects.md` and `hq/claude.md` in `Nercari/nercari-control`. Report on nercari-control PR #97 with `@claude`, track tasks on #148, put Pedro's decisions on #114, and leave one line on #97 after each merge. Never merge, close, or edit #97. A PR merges when it is out of draft, conflict-free and green. The author or Director merges it. A review is optional; a FAIL with a BLOCKER line (`hq/rules/review-rubric.md`) blocks the merge until fixed or disputed. A `RISK: high` PR also needs a PASS from another harness. Pedro samples the default branch after merge. Hard stops stay with Pedro: secrets, extra spend, sending as him, settings or permissions changes, force-push, and deleting a shared repo or branch. Add `needs:pedro` only for one of those, any deletion, PR #97, or an explicit question to him; work that can proceed never gets it. Do not reinstall `guard-pr` or `guard-main`. `VERIFY.md` is the merge evidence: generate it with `create-verification-skill`, keep it current with `maintain-verification-skill`, and paste its real output. Every failure becomes a skill, lint, test, or CI check the same day. Ignore `Nercari/director-core`. Whoever Pedro talks to owns that request: search open issues, pull requests, and `cursor/` and `claude/` branches before starting a second one. A session he starts may push a branch or open a draft early. An ownership change is the line `OWNER-CHANGE: <old> -> <new>, <reason>`. Grok bots do not use `@cursor` comments to get work done, except `CLAUDE-OUT`. A Grok bot may hand his own request to Cursor only through a cloud agent, and before launch posts `@claude RELAY RELAY-YYYYMMDD-N` (or, at most once a night, `@claude NIGHTLY RELAY-YYYYMMDD-N`) on #97. It never assigns work HQ started; agy requests go to HQ on #97. Route work to the pool with the most room before its reset. Any agent at or near a usage limit posts one line on #97, `USAGE: <pool> <percent>, resets <date>`, at most once a day, from that tool's own usage command: Claude `/usage` or `scripts/claude_usage_line.py` on the status-line JSON, agy `agy /usage`. Nobody signs in to Claude or agy from a cloud browser. Reply in the language Pedro writes in.
