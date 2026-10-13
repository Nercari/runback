WHAT: one line, plain words
WHY: issue #N or Pedro's words
SAFETY FACT: the one fact that makes this change safe
PROOF CMD: a test name or path that the repo's own check script runs (not raw shell)
PROOF OUTPUT: <full head SHA it ran at>, then what the commands in VERIFY.md printed there (npm ci, node tools/safety-ci.js, npm test tails). Paste it here, not in VERIFY.md.
TESTS: what ran + result
CHANGELOG: the changes/<slug>.md fragment you added, or "none (nothing a player would notice)". Do not edit CHANGELOG.md.
