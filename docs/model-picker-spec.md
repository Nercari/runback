# Model and effort picker: match each CLI (backlog 41 to 46)

Pedro asked (2026-10-09): "the model selection inside the addon should be exactly like their respective CLIs, with model and reasoning level." This spec turns that into six tickets, one PR each. Each ticket is written to be picked up alone; its "Needs" line names the tickets that must be merged first.

## Where it stands (backlog 28, PR #35)

- `bridge/agents.js` `modelChoices()` offers `agents.<id>.models` from `config.json`. With no list, Claude gets `opus, sonnet, haiku` and every other agent gets nothing, only its own default.
- The bridge publishes `models = { claude = { "opus", ... } }` in the inbox (`protocol.luaTable`). The addon's AI picker lists one flat row per agent and per model, up to 24 rows (`WoWAI.PoolChoices`, `WoWAI.ShowPicker`).
- A chat sends `agent=<id>;model=<name>` in its strip flags (`protocol.parseFlags`). The bridge refuses a model not on the list and passes the rest as `--model` / `-m`.
- No reasoning or effort level exists anywhere: not in the flags, the inbox, the picker or the command lines.

## Goal

For each agent, the picker offers the same models the CLI's own picker offers, under the CLI's own names, and for each model the same effort levels the CLI accepts for it, with the CLI's default marked. The choice reaches the CLI as that CLI's own flag. Metric: models and effort levels the picker offers that the CLI also offers, out of what the CLI offers. Baseline today: Claude 3 aliases and 0 effort levels; every other agent 0 and 0. Target: every listed entry in the tables below, and 0 entries the CLI would reject.

## What each CLI offers (checked 2026-10-09)

Labels: OBSERVED (read in the CLI's own source or run here), DOCUMENTED (official docs), UNVERIFIED (third-party or inferred). Ticket 41 confirms every UNVERIFIED line on Pedro's PC. Until it has, the catalog (ticket 42) leaves those lines out and the bridge (ticket 43) passes no flag that depends on them.

### Claude Code (`claude`, 2.1.296 here)

- Models: the `--model` aliases `fable`, `opus`, `sonnet`, `haiku`, plus `opus[1m]`, `sonnet[1m]`, `fable[1m]` and `opusplan` when the account has them. No model flag means the CLI default. DOCUMENTED: https://code.claude.com/docs/en/model-config ; OBSERVED in `claude --help`.
- Effort: `--effort low|medium|high|xhigh|max`. OBSERVED in `claude --help`. Per model (DOCUMENTED, model-config page): Fable, Opus 5.x and Sonnet 5.x take all five; Opus 4.6 and Sonnet 4.6 take low, medium, high, max; Haiku takes none. Default high, except Opus 5.5 and Sonnet 5.5 (medium). An unsupported level is clamped down, not refused.
- Not offered: `--effort ultracode` (DOCUMENTED as "xhigh plus ultracode", Claude Code 2.1.203 or later, https://code.claude.com/docs/en/cli-reference ; not in `claude --help` here). UNVERIFIED: that ultracode starts multi-agent workflows that cost far more usage than a chat reply. Left out either way, since a chat reply does not need it.
- No machine-readable model list for the account (DOCUMENTED absence). The list stays built in.
- Bridge flag: `--effort <level>` next to `--model`.

### Codex (`codex exec --json`)

- Models and levels, OBSERVED in the CLI's bundled catalog `codex-rs/models-manager/models.json` (https://github.com/openai/codex), entries with `visibility: list`, in the CLI's order:

| Model | Effort levels | Default |
|---|---|---|
| gpt-6-astra | low, medium, high, xhigh, max, ultra | low |
| gpt-6.1-sol | low, medium, high, xhigh, max, ultra | low |
| gpt-6-sol | low, medium, high, xhigh, max, ultra | medium |
| gpt-6-luna | low, medium, high, xhigh, max | medium |
| gpt-5.6-sol | low, medium, high, xhigh, max, ultra | low |
| gpt-5.6-terra | low, medium, high, xhigh, max, ultra | medium |
| gpt-5.6-luna | low, medium, high, xhigh, max | medium |
| gpt-5.5 | low, medium, high, xhigh | medium |

- gpt-5.5 retires for ChatGPT sign-in on 2026-10-14 (DOCUMENTED, https://learn.chatgpt.com/docs/models). Max and Ultra depend on the account's plan (same page).
- The CLI keeps the live catalog for the signed-in account in `~/.codex/models_cache.json` (OBSERVED in `models-manager/src/manager.rs`; file shape UNVERIFIED). Ticket 46 reads it.
- Bridge flags: `-m <slug>` (DOCUMENTED, `codex exec -m gpt-6.1-sol` example on https://learn.chatgpt.com/docs/models) and `-c model_reasoning_effort=<level>` (key OBSERVED in `codex-rs/config/src/config_toml.rs`; behaviour through `exec` UNVERIFIED until ticket 41).

### Grok Build (`grok`)

- Models: `grok-build` (Grok 4.7) is the only id the docs name; `grok models` lists the rest, including custom models from `~/.grok/config.toml`. DOCUMENTED: https://docs.x.ai/llms-full.txt. The full list and its output format are UNVERIFIED.
- Effort: `--effort <level>` (DOCUMENTED, CLI reference in llms-full.txt; config key `[models] default_reasoning_effort`). Levels low, medium, high, xhigh are UNVERIFIED (third-party list); default UNVERIFIED.
- Bridge flags: `-m <id>` and `--effort <level>`; pass `--effort` only when the player picked one.

### Antigravity (`agy`)

- Models as its picker shows them (DOCUMENTED, https://antigravity.google/docs/models?app=cli): Gemini 3.8 Flash, 3.7 Flash and 3.6 Flash, each Fast, Low, Medium or High; Gemini 3.1 Pro, Low or High; Claude Sonnet 5.5 (Thinking); Claude Opus 5.5 (Thinking); Claude Sonnet 4.6 (Thinking) and Opus 4.6 (Thinking), both removed 2026-11-02; GPT-OSS 120B (Medium).
- The level is part of the model: ids look like `gemini-3.1-pro-high` (UNVERIFIED, third-party). `agy models --output-format json` lists the real ids (DOCUMENTED in release notes 1.1.12, https://github.com/google-antigravity/antigravity-cli/releases; shape UNVERIFIED). A separate `--effort` flag exists since 1.1.10 (same notes); its values are UNVERIFIED.
- Bridge flag: `--model <id>` with the level in the id, the way agy's own picker works. Do not add `--effort` unless ticket 41 shows a model that needs it.

### Hermes (`hermes chat`)

- Models: whatever the player configured; `-m <provider/model>` with an optional `--provider` (DOCUMENTED, https://hermes-agent.nousresearch.com/docs/reference/cli-commands). Default from `model.default` in `config.yaml`. No machine-readable list. The list stays `agents.hermes.models` in `config.json`.
- Effort: `agent.reasoning_effort` in `config.yaml`, values none, minimal, low, medium, high, xhigh, default medium (DOCUMENTED, `cli-config.yaml.example`). A per-run `--reasoning` option is UNVERIFIED (inferred): `hermes_cli/main.py` forwards `args.reasoning` to the chat, but the flag's spelling and values are not confirmed.
- Bridge flag: the per-run option only, after ticket 41 confirms it. Never write the player's `config.yaml` from the bridge; without a per-run option Hermes offers no effort in game.

### OpenCode (`opencode`, added 2026-10-11)

Pedro asked (2026-10-11): "I also want to be able to use my OpenCode models and choose reasoning just like in their respective CLIs." OpenCode is not a bridge agent yet. His PC has OpenCode 1.19 updating to 2.0 (recording B, 4:20 to 5:35), signed in on a free plan; `opencode auth login opencode` failed there with "fetch() URL is invalid". The paid OpenCode Go plan was cancelled on 2026-10-04 (nercari-control CLAUDE.md), so only models his sign-in already gives him are in scope; nothing here buys a plan.

- Run: `opencode run "<prompt>" --model <provider>/<model> --format json` for one non-interactive reply (UNVERIFIED for 2.0: confirm the flags and the JSON event shape on Pedro's PC).
- Models: `opencode models [provider] --verbose` lists the models his providers give him, with per-model details (UNVERIFIED: confirm the output and whether it shows reasoning variants).
- Reasoning: OpenCode calls effort levels "variants" per model (the TUI cycles them; recording B shows "OpenCode · high"). A per-run `--variant <name>` is UNVERIFIED; confirm it, and the variant names per model, before the bridge passes it.
- Bridge flag: `--model` always; `--variant` only after it is confirmed. Never write OpenCode's own config.

## Confirmed on Pedro's PC (ticket 41, 2026-10-09)

Read-only: help and list commands, plus one one-line Codex run. No saved setting was changed. Account data is left out.

| Line above | Result |
|---|---|
| Claude `--effort low\|medium\|high\|xhigh\|max` | Confirmed (`claude --help`, 2.1.295; the spec said 2.1.296). `--model` takes an alias such as `fable`, `opus`, `sonnet` or a full name. |
| Claude per-model levels, default | Not checkable without paid prompts; stays DOCUMENTED. |
| Codex `-m` and `-c key=value` | Confirmed (`codex exec --help`, codex-cli 0.159.0). |
| Codex `-c model_reasoning_effort=high` through `exec` | Not confirmed. The flags were accepted, but the run stopped on an expired ChatGPT sign-in (401), so no model replied. Needs `codex login`, then one rerun. |
| Codex `~/.codex/models_cache.json` shape | Confirmed: keys `fetched_at`, `etag`, `client_version`, `identity`, `models`; each model has `slug`, `visibility` (`list` or `hide`), `default_reasoning_level`, `supported_reasoning_levels[].effort`. The file here is from 2026-10-02 (client 0.159.2). |
| Codex table above | Wrong in three places, per that cache: gpt-6-astra default is medium, not low; `gpt-daybreak-blue-latest` (low, medium, high, xhigh, max, ultra; default low) is also `list`; gpt-5.5 is present. Re-read the cache after sign-in before ticket 42 copies the table. |
| Grok `grok`, `grok models`, `--effort`, levels, default | Not installed on this PC (no `grok` on PATH, no `~/.grok`). Stays UNVERIFIED. |
| agy `models --output-format json` | Wrong. `agy models` takes no flags and prints tab-separated `id<TAB>label` lines (agy 1.3.2). |
| agy ids look like `gemini-3.1-pro-high` | Confirmed. Live list: `gemini-3.8-flash`, `-3.7-flash`, `-3.6-flash` with `-high`, `-medium`, `-low` (no Fast); `gemini-3.1-pro-high` and `-low`; `claude-opus-5-5` and `claude-sonnet-5-5` with `-low`, `-medium`, `-high` (no "Thinking" in the label, no 4.6 models); `gpt-oss-120b-medium`. |
| agy `--effort` | Confirmed: `--effort low\|medium\|high\|xhigh\|max` for the session. Whether it applies to ids that already carry a level is not tested. |
| Hermes `--reasoning` | Confirmed (Hermes 0.21.5): `hermes chat --reasoning LEVEL`, values none, minimal, low, medium, high, xhigh, max, ultra; "overrides agent.reasoning_effort for this run only". The levels in the Hermes section above are missing max and ultra. `-m MODEL` and `--provider` confirmed. |

Effect on the tickets: 43 may use Hermes `--reasoning` (it is no longer conditional); 42 must take the agy list and Codex table from this section; 46 must read `agy models` as plain text, not JSON; Grok stays out of the catalog until it is installed.

## Design

- One catalog, in the bridge. `bridge/models.js` holds, per agent, an ordered list of `{ id, label, efforts, defaultEffort }` copied from the tables above, each agent with its source URL and checked date. `agents.<id>.models` in `config.json` still overrides it; a plain string means a model with no effort levels.
- Effort travels like model. Strip flag `effort=<level>`, the same token rule as `model=` but only `[a-z]{1,16}`. The bridge refuses a level the catalog does not list for that model, like it refuses an unknown model today, and passes nothing when the chat has no level (the CLI's own default applies).
- The inbox adds `efforts = { claude = { opus = { "low", ... } } }` and `defaults = { ... }` next to `models`. An older addon ignores them; an older bridge sends neither, and the newer addon then shows no effort row.
- The picker keeps one row per model and shows the effort levels of the chosen model as a second row of small buttons ("Effort: low medium [high] xhigh max"), default marked. The chat label becomes "Claude · opus · high". The typed form is `/wow-ai agent claude opus high`.
- A model or effort change keeps the conversation, as a model change does today.

## Blizzard policy and combat

Checked against `docs/COMPLIANCE.md`. Nothing here touches gameplay: the picker is a plain addon frame, the choice only changes which command line the bridge runs on the PC, and no protected or hardware-event API is called. The picker stays closed in combat (it closes on `PLAYER_REGEN_DISABLED` and cannot open while `InCombatLockdown()` is true), and a message sent in combat already waits for the fight to end (backlog 7). Each addon PR states this check in its body.

## Tickets

Each ticket: one PR into `forever`, `node tools/safety-ci.js` and `npm test` green, a test for every behaviour change, `CHANGELOG.md` and `docs/CONFIGURATION.md` updated when a player would notice.

### 41. Confirm the CLIs on Pedro's PC

- Needs: nothing. Runs on Pedro's PC through Remote Control; no game.
- Do: run and record the output (trimmed, no account data) of `claude --help`, `codex --version`, a one-line `codex exec --json -m gpt-6-sol -c model_reasoning_effort=high -` run, the head of `~/.codex/models_cache.json`, `grok --help`, `grok models`, `agy --version`, `agy --help`, `agy models --output-format json`, `hermes chat --help`. Missing CLIs are noted as missing.
- Done when: a "Confirmed on Pedro's PC" section in this file says, for every UNVERIFIED line above and every catalog row that ticket 42 left out, confirmed, wrong (with the real value) or not installed; and the catalog in `bridge/models.js` (if ticket 42 has merged) gains the confirmed rows in the same PR.

### 42. Built-in model catalog

- Needs: nothing. It ships only the OBSERVED and DOCUMENTED rows: Claude's aliases and levels, Codex's models and levels, Grok's `grok-build` with no levels. agy, Hermes and the UNVERIFIED rows wait for ticket 41.
- Do: add `bridge/models.js` with the catalog; `modelChoices()` reads it instead of `DEFAULT_MODELS`; `config.json` `models` still wins and accepts strings or `{ id, efforts, defaultEffort }` objects. Only listed models are included (no hidden Codex models). Update `docs/CONFIGURATION.md`.
- Tests: per agent, the catalog's ids and levels equal the OBSERVED and DOCUMENTED rows above; a config list overrides it; bad tokens are dropped as today.
- Metric: models offered per agent with no config, Claude 3 / others 0 → the table counts.

### 43. Effort on the command line

- Needs: 42; for the Codex, Grok and Hermes flags also 41 (until then those agents get no effort flag).
- Do: `parseFlags` and the reload job reader accept `effort=`; `runJob` refuses a level the catalog lacks for that model with a one-line reason; each agent's `args()` adds its flag: Claude `--effort`, Codex `-c model_reasoning_effort=`, Grok `--effort`, agy none (level is in the id), Hermes the per-run option. Each flag only once ticket 41 has confirmed it; Claude's is OBSERVED and goes in at once. No level means no flag.
- Tests: the argv of each agent with and without a level; an unknown level is refused; `ultracode` is refused for Claude.

### 44. Effort levels in the inbox

- Needs: 42.
- Do: `pools()` and `protocol.luaTable` publish `efforts` and `defaults` per agent and model; names and levels pass the same token rules.
- Tests: the Lua text for a catalog with and without levels; an older addon's reader still loads it (`tests/addon_test.js` fixture).

### 45. Effort row in the AI picker

- Needs: 44 for the list; 43 for the choice to take effect.
- Do: store `c.effort` per chat; send `effort=` in the flags; show the effort row for the chosen model with the default marked; label "Agent · model · effort"; `/wow-ai agent <name> [model [effort]]` with the same checks; close the picker on combat start and refuse to open it in combat. Add the policy check to the PR body.
- Tests: flags for a chat with a level; switching to a model without that level clears it; the typed command refuses an unknown level; the picker does not open while `InCombatLockdown()` is true.
- In game (Pedro): open the AI button, pick Codex, a model, then a level; send a question; the reply works and the chat label shows the level.

### 46. Read the CLI's own model list when it has one

- Needs: 42 and 41 (for the file and output shapes).
- Do: behind `config.json` `modelDiscovery` (`off` → `shadow` → `on`, default `off`; retire within 14 days of `on`), read Codex's `~/.codex/models_cache.json` and run `agy models --output-format json` and `grok models` at most once an hour; in `shadow` only log differences from the catalog; in `on` use the CLI's list, falling back to the catalog on any error.
- Tests: parsing recorded samples from ticket 41; a broken or missing file falls back to the catalog.
- Metric: catalog entries that differ from the CLI's own list, measured in `shadow`.

### 64. OpenCode as an agent

- Needs: nothing.
- Do: first, through Remote Control on Pedro's PC, record `opencode --version`, `opencode run --help`, `opencode models --verbose` and one `opencode run ... --format json` stream into `tests/fixtures/`; then add `opencode` to `bridge/agents.js` (detect, run, parse the JSON stream into reply, actions and errors), so it shows in the AI menu like the others. No spend: a model that needs a paid plan shows the CLI's own error.
- Tests: the recorded stream parses in `tests/agents_test.js`; missing CLI gives the install hint.
- Metric: OpenCode chats that return a reply in game, 0 → 1 (live check by Pedro).

### 65. OpenCode models and reasoning in the picker

- Needs: 64, 42, 44 and 45.
- Do: OpenCode's models come from `opencode models --verbose` (read at most once an hour, catalog fallback, same switch as ticket 46); each model's reasoning variants become the effort row; the choice is passed as `--variant` once ticket 64 has confirmed the flag.
- Tests: recorded `opencode models` sample parses; an unknown variant is refused with the model's valid list.
- Metric: OpenCode models and variants in the picker that `opencode` also offers, 0 → all.

## Not in scope

- Reading or changing the CLIs' own config files.
- Choosing a model automatically, or by fight or cost.
- Anything during combat.
