# WOW-11 acceptance coverage, 2026-09-25

Branch `forever`. How each acceptance criterion (spec v1 AC1–AC8, spec v2 AC9–AC34) is covered today:

- **Auto**: a test in `npm test` (file: test name).
- **Dry run**: a real `codex exec` transcript through `runAgentOnce` and the mentor guard. See `docs/forever-dryrun-2026-09-25.md` (first batch) and `docs/forever-dryrun2-2026-09-25.md` (gap batch).
- **Live**: needs the Forever client, installed on Pedro's PC on 2026-10-03. Pedro runs these with the WOW-02 probe kit (`probe/PROBE.md`); results go in the live log below.

Spec v2 accepts prompt-only features (F02, F05–F07, F10, F11, F13, F14, F16, F18 drafts, F19 text, F20 synthesis) by a dry-run transcript. Gated features pass their own AC or a documented fallback.

| AC | What | Auto | Dry run | Live (Pedro) |
|---|---|---|---|---|
| 1 | Four agents answer and resume after `/reload` | agents_test: each adapter's args, resume and stream parser; restore_test: slot file round-trip | review/death runs used codex through `runAgentOnce` | in-game chat with each agent, then `/reload` |
| 2 | Send in combat or encounter refused | addon_p3_behavior: lockouts; addon_test: Forever blocks sends | — | enter combat and try to send |
| 3 | `lastFight` after open-world fight and boss (encounter name) | addon_p3_behavior: one game context, encounter fields | — | one open-world fight and one dungeon boss |
| 4 | Slicer fixture test | slice-fight tests (synthetic log, 2 MB cap, header, yearless lines) | — | re-run on a real Forever log from WOW-02 T2 |
| 5 | ≤3 mistakes, each cited and verifiable | check-citations tests (tamper fails) | review: PASS, checker verified | — |
| 6 | Recurring-mistake row or improvement after two reviews | — | review: notebook row count 2, "Since last review" line | second real review |
| 7 | Build uses only calculator talents, correct rows, cited | — | build: first run PARTIAL (points 8 instead of 9); re-run: PASS (9 points) | — |
| 8 | No visible window; forbidden-API grep empty | launchers: hidden window style; safety-ci repo mode (grep plus hooks) | — | — |
| 9 | Autopsy cites killing blow and 15 s before | addon_p4_features: death shot button on click only | death: PASS, 5 lines verified | real death |
| 10 | Positional finding with coordinates; report HTML | — | not run: positions depend on WOW-02 (advanced logging) | gated on WOW-02 positions |
| 11 | `meter` after combat, absent in combat | addon_p3_behavior: meter absent then `meter=dps …` | — | real `C_DamageMeter` |
| 12 | Two scorecard rows and a trend | check-citations: scorecard row validation | review: 2 rows, trend sentence | — |
| 13 | Drill due on interval, grading updates | — | drill: PASS (1 → 3 days, due 09-28) | — |
| 14 | Briefing ≤10 cited bullets for the role | — | brief: PASS | — |
| 15 | TL;DR spoken; lockout replies spoken later | addon_p4_speech: queue during lockout then flush, TL;DR marker | — | Windows voices in game |
| 16 | Upgrades name sourced items and where to get them | — | gear: PASS (3 sourced items) | — |
| 17 | Macro Create out of combat, refused in combat, asks before overwrite | addon_p4_macro (5 tests) | — | create one macro in game |
| 18 | AH scan via BULK; advice cites prices | addon_p4_bulk: AH scan; p2: bulk writes | ah: PASS (scan time and prices cited) | open AH and Scan |
| 19 | XP/hour, `/played`, route | — | level: first run PARTIAL (no `/played`); re-run: PASS (`/played` reported) | — |
| 20 | Repeated question answered from cache with date; stale entry refetched | — | facts-fresh: PASS (cache hit, date worded "today"); facts-stale: PASS (refetched, file rewritten) | — |
| 21 | Spoiler-free quests; narration toggle | addon_p4_speech: narration on QUEST_DETAIL | quest: PASS | — |
| 22 | `/runback look` answer about the screenshot | p2: look attaches newest, refuses agy | — | take a screenshot and ask |
| 23 | Opted-in whisper translated, other channels never sent, reply only on Enter | addon_p4_features: never buffers non-opted channels, ≤1 per 10 s, never calls SendChatMessage | translate: PASS (fenced `reply` block) | whisper test with a friend |
| 24 | Logout writes a journal note with screenshots | addon_p4_bulk: journal events and logout flag; p2: logout journal handler | journal: PASS (48 words, screenshot linked) | real logout |
| 25 | Council shows answers and synthesis, survives a timeout | p2: council owns the job and tolerates a timeout | council: PASS (synthesis, missing grok named) | — |
| 26 | Job board status and done notice | addon_p4_features: job board transition, sound and speech once | — | — |
| 27 | Phone done notice; `/runback phone` continues in the folder | p2: phone intercept, notifier stub (never real hermes) | — | needs a hermes gateway; Pedro's phone |
| 28 | Lint blocks; pass → free slot; new slot per iteration; Promote loads after restart | p7_builder (7 tests), p7_install_user_slots, safety-ci untrusted mode | — | `LoadAddOn` and restart in game |
| 29 | Spoken question arrives after confirm; no keyboard hook | p7_ptt (recent strip, kill switch, stale drop); safety-ci forbids SetWindowsHookEx and SendKeys in `.ps1` | — | mic, speech recognizer, overlay |
| 30 | F25 screenshot transport round trip | — | — | DEFERRED: WOW-17 is built only if the F25 gate passes in WOW-02. Fallback in use: text over the strip, `look` for images |
| 31 | S2 fails on a planted call, passes clean code | safety-ci (15 tests, repo and untrusted modes) | — | — |
| 32 | Every outbound prompt in the audit log | p2: audit appends prompt fields, prunes old files | — | — |
| 33 | `/runback off` stops everything, stays off across `/reload` and restarts | p2: kill switch refuses jobs, stops capture and agents; p7: builder and PTT honor KILLED; addon_p3_behavior: off switch reaches the bridge in combat | — | addon-side state across `/reload` gated on WOW-02 SavedVariables read-back |
| 34 | Simulated policy diff → alert and banner | policy-watch: changed diff and alert, alert after 2 failures; addon_p4_features: policy banner | — | — |

## Live check log

| Date | Check | Result | Notes |
|---|---|---|---|
| 2026-10-03 | Addon installs and loads on Forever (Windows) | PASS | First login showed a Lua error at `Forever.lua:27` (retail-only AH search events in the bulk module). Fixed in PR #2; after updating and restarting the client, Pedro saw no error on login. |

## WOW-02 gate table
The gates (strip decode, SavedVariables read-back, `Screenshot()` and PNG decode, advanced-logging positions, `C_DamageMeter`, `C_AuctionHouse`, voices) are listed in `probe/PROBE.md`. None has run yet: the Forever beta client gets installed after 2026-10-02.

## Theorycraft (F10, F11 extension)
`tools/theorycraft.js` (scenario DPS, stat weights, compare, tank effective health) is covered by `tests/tools/theorycraft.test.js`, 13 tests with hand-computed values: Classic attack table vs a +3 boss (0.867 white multiplier), two-roll yellow hits, spell miss by level, armor K by level, tank crit at 400 defense (1.6%), data overrides.
