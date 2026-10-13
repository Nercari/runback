# VERIFY

Merge evidence for runback. This file lists the commands only; it never holds their results. Results go in the PR body, because a results section in this file is the same few lines every PR appends, and parallel PRs then conflict on it.

Run these from the repo root. CI runs the first three on Windows and Linux.

## Commands

- `npm ci`
- `node tools/safety-ci.js` (Blizzard-policy and safety checks; must exit 0)
- `npm test` (must end with `# fail 0` and `CODEC ROUND-TRIP PASS`)

## Proof in the PR body

Paste the real tail of each command's output in the PR body, under `PROOF OUTPUT:`, and write the head SHA it ran at on the first line (`PROOF OUTPUT: <full head SHA>`). Output from an older commit proves nothing about the head: after a push, re-run and update the SHA and the output. The `# tests` / `# pass` / `# fail` counts go there too.

When behavior changes, update this file only if a command changes (a new check to run), not to record a result.

In-game behavior cannot be verified by an agent. Only Nercari can run the game; a PR that changes the addon gives him a short checklist in the PR body and says the in-game part is unverified.
