# Configuration reference

Everything the bridge reads: `bridge/config.json`, command-line flags, environment variables, and the files it writes next to itself. `node setup.js` writes a working `config.json` from `bridge/config.example.json` (and brings an older one up to date); this page explains each key so you can tune it by hand.

The bridge reads `config.json` once at start. Restart it after editing, including `allowedTools`: the game never changes permissions.

## Paths

| Key | Default (from `config.example.json`) | Meaning |
|---|---|---|
| `addonDir` | `…\World of Warcraft\_classic_beta_\Interface\AddOns` | The game's AddOns folder. The bridge writes the slot addons, `Inbox.lua` and every signal file under it. `setup.js` fills this in from the client it finds, and repoints it at the `_forever_` folder when the client moves. |
| `inboxFile` | `<addonDir>\Runback\Inbox.lua` | The file the game reads on `/reload` (fallback path). Normally derived from `addonDir`; only change it if you moved the addon. A value still naming the old `WoWClaude` addon is ignored in favour of the derived one. |
| `savedVariablesFile` | `…\WTF\Account\<account>\SavedVariables\Runback.lua` | The addon's saved data. The bridge polls it for the reload-path outbox. `setup.js` picks the first account under `WTF\Account`; pass `--account <name>` to choose another. |
| `defaultCwd` | empty | Folder for chats that have not chosen one with `/runback cd`, when the bridge is started from inside this repo (`npm start`). Empty means the mentor workspace. See [Which folder the agent works in](#which-folder-the-agent-works-in). |
| `allowedFolders` | `[]` | More folders a chat may work in, one path per entry (`~` is your home folder). The default folder is always allowed. A chat in any other folder is refused; the in-game **How to allow** button does not add one. |

## Extensions

`forever.disabled` is a list of bridge module filenames without `.js` to skip. Modules live in `bridge/forever/modules/`; see [FOREVER.md](FOREVER.md) for the hook contract.

## Agents

| Key | Default | Meaning |
|---|---|---|
| `agent` | `"claude"` | The agent for chats that have not picked one with `/runback agent`. One of `claude`, `codex`, `grok`, `agy`, `hermes`, `opencode`; the bridge refuses to start on anything else. |
| `agents.<id>` | one block per agent | That agent's settings, below. A missing block means the defaults. |

Keys under `agents.claude`, `agents.codex`, `agents.grok`, `agents.agy`, `agents.hermes` and `agents.opencode` (what each one means per agent is spelled out in [AGENTS.md](AGENTS.md)):

| Key | Default | Meaning |
|---|---|---|
| `permissionMode` | `"acceptEdits"` | `acceptEdits` auto-approves file edits inside the working folder; `bypassPermissions` approves everything; `default` approves nothing beyond what `allowedTools` names. Claude gets it as `--permission-mode`; for Codex it picks the sandbox (`read-only` / `workspace-write` / none); for Grok it becomes `--permission-mode dontAsk` plus allow rules, or `--always-approve`; for OpenCode `default` runs its read-only `plan` agent and `bypassPermissions` adds `--auto` (headless Grok runs ordinary commands on its own and blocks dangerous ones unless a rule allows them; see [AGENTS.md](AGENTS.md)). |
| `allowedTools` | git, npm, npx, node, python, pip, pytest, ls, dir, WebSearch, WebFetch | Rules in Claude Code's syntax: `Bash(git:*)` allows any command starting with `git`, `WebSearch` a tool. Passed to Claude as `--allowedTools`, translated to Grok's `--allow` globs, ignored by Codex. Only this file gives a rule: the game cannot add one (see [Permissions](#permissions)). Outside the mentor workspace the bridge replaces this list with read-only tools. |
| `deniedTools` | `[]` | Rules the agent may never use, same syntax. Claude: `--disallowedTools`; Grok: `--deny`, which wins over everything, `bypassPermissions` included; ignored by Codex. |
| `model` | `""` | Passed to the CLI (`--model` / `-m`) when non-empty. Empty uses the CLI's default. |
| `coachModel` | `""` | The model a coach note (a fight review, `/ai review`, and the between-pull card) runs on, whatever model the chat picked. Empty uses the agent's cheap model: `haiku` for Claude, which is the only agent whose list names one. Give a model this agent offers to change it; one it does not offer is ignored, so the cheap model still applies. An agent with no cheap model, or a `models` list that leaves it out, runs reviews on its normal model, with no error. |
| `models` | Built in (`bridge/models.js`): Claude `fable, opus, sonnet, haiku`; Codex its eight listed models (`gpt-6-astra` … `gpt-5.5`); Grok `grok-build`; agy, Hermes and OpenCode none | The models the in-game **AI** picker offers for this agent, as the CLI names them (`"gpt-5-codex"`, `"openrouter/x-ai/grok-4"`). Setting it replaces the built-in list. An item is a name, or `{ "id": "gpt-6-sol", "efforts": ["low", "high"], "defaultEffort": "low" }` to record the reasoning levels the CLI accepts for it (levels are lowercase letters, up to 16). A chat that picks one runs with it instead of `model`; a model not on this list is refused. Names are letters, digits and `. _ : / @ [ ] -`, up to 64 characters. |
| `path` | `""` | Full path to the executable. Empty means: look in the installer's folder, then (for Codex) `CODEX_BIN`, then `PATH`, then npm's launcher. A `.js` path is run with the bridge's Node. |
| `extraArgs` | `[]` | More command-line arguments, added verbatim (before Codex's `resume` subcommand). |
| `networkAccess` (codex only) | `false` | `true` lets commands inside Codex's `workspace-write` sandbox reach the network (`-c sandbox_workspace_write.network_access=true`). |

A `config.json` from before agents existed kept Claude's settings at the top level (`claudePath`, `model`, `permissionMode`, `allowedTools`). The bridge still reads them, under anything in `agents.claude`; `setup.js` moves them down.

### The model a coach note runs on

One coach note per pull has to cost about nothing, so a fight review and the between-pull coach card run on the agent's cheap model by default: `haiku` for Claude, set in `bridge/models.js` (the only agent whose model list names a small, fast one). Codex, Grok, agy, Hermes and OpenCode keep their normal model, and so does every chat.

- Change it per agent: `"coachModel": "sonnet"` under `agents.claude`. Give a model that agent offers.
- Turn the cheap default off: give `coachModel` the model you want reviews on, or remove `haiku` from `models` and reviews keep the agent's normal model.
- The chat's own model pick does not apply to a review, and the review takes the coach model's own reasoning level.

## Permissions

The game never changes what an agent may do. An `allow=` field on a strip or reload record is ignored, so an old addon cannot widen `config.json`. To add a rule, edit `agents.<id>.allowedTools` in `bridge/config.json` on the PC and restart the bridge.

A reply that was refused a tool offers **How to allow**. The button only explains that PC step; it sends no rule and writes no file.

The agent's tools also depend on the folder:

| Folder | `permissionMode` and tools |
|---|---|
| The mentor workspace (`forever.mentorDir`) | The coach's working set: `acceptEdits`, with `Read`, `Grep`, `Glob`, `Edit`, `Write`, web search and its own `tools/` scripts (see [AGENTS.md](AGENTS.md)). Hermes and OpenCode are refused there: the bridge cannot limit their tools, so game text could reach them. |
| Any other allowed folder | Read-only: `permissionMode` `default` and `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`. No command, edit or write tool, whatever `allowedTools` says. `WebFetch` is network egress, so it can send a page URL out. OpenCode runs its own read-only `plan` agent there; Hermes has no tool-limit flag in the bridge yet, so it is refused there. |

## Runs

| Key | Default | Meaning |
|---|---|---|
| `gameContext` | `true` | Put the character/zone context the addon sends into the agent's system prompt. `false` ignores it, for a bridge only ever used on unrelated projects. The addon has its own switch, `/runback context off`, which also clears what the bridge holds. |
| `primerFile` | `"docs/WOW-ADDON-PRIMER.md"` | A markdown file appended to the system prompt together with the game context, whatever folder the chat works in: how to write addons and macros for this client. Relative to the runback folder, or absolute. Re-read on every run, so edits count at once. `""` sends none. Off whenever the context is off. |
| `maxParallel` | `3` | How many chats may run an agent at the same time. Further messages queue per chat. |
| `timeoutMs` | `1800000` (30 min) | A run longer than this is killed (with its children) and reported as an error in game. |
| `progressWriteMs` | `3000` | Minimum gap between progress writes to the slot files. Final replies are written immediately. |
| `pollMs` | `750` | How often the bridge checks the SavedVariables file for a reload-path message. |

## Screen capture

Keys under `capture`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run `capture.ps1` (Windows) or `capture_x11.py` (Linux). With `false` only the reload path works (`/runback mode reload` in game). |
| `processName` | `"WowB"` | The game executable without `.exe`. `setup.js` sets it from the `Wow*.exe` it finds in the client folder. |
| `cellPx` | `4` | Pixel size of one strip cell. Must match `CELL` in `addon/Runback/Codec.lua`. |
| `cellsPerRow` | `200` | Cells per strip row. Must match the addon. |
| `maxRows` | `48` | Maximum strip rows captured. Must match the addon. |
| `intervalMs` | `250` | Capture period. Lower is more responsive and costs a little more CPU. |
| `python` | `"python3"` | Linux: interpreter for `capture_x11.py`. |
| `windowName` | `""` | Linux: find the game window by title substring instead of by WM_CLASS (`<processName>.exe`). |
| `keepComposited` | `false` | Linux: set `_NET_WM_BYPASS_COMPOSITOR=2` on the game window so the compositor keeps drawing it. Try it if `npm run probe` sees a black or stale strip in borderless fullscreen. |

The capture region is `cellsPerRow × cellPx` by `maxRows × cellPx` pixels (800 × 192 by default) at the top-left of the game's client area.

## Slot pool and signal files

These sizes are baked into the files `install-slots.js` creates, and the addon has matching constants at the top of `addon/Runback/Runback.lua` (`SLOT_COUNT`, `ACT_MAX`, `PRESENCE_MAX`). Change all three places together, re-run `node bridge/install-slots.js`, and restart the game.

| Key | Default | Meaning |
|---|---|---|
| `slots` | `200` | Reply-slot addons `Runback_S001` … `Runback_S200`. Each slot can be loaded once per UI session; `/reload` frees them all. |
| `slotWindow` | `16` | How many of those slots one publish writes: the ones after the slot the addon has loaded by then, which follows its poll cadence while a reply is pending (#144). All of them are written when the addon has not reported a slot (an older addon, or none loaded yet), and after a `/reload`. A larger window needs a new measured write count (`tests/bridge_test.js`). |
| `actMax` | `60` | Heartbeat files per message (`act/NNN/01..60.wav`). One flips per agent action. |
| `presenceMax` | `2000` | Presence files (`presence/0001..2000.wav`). One flips per `presenceIntervalMs`. |
| `presenceIntervalMs` | `30000` | How often the bridge flips a presence file so the in-game light stays green. |
| `tocInterface` | `"16001"` | `## Interface:` version written into every slot addon's `.toc`. `setup.js` raises it to the number in `config.example.json` (it never lowers it), and `bridge/install-slots.js` rewrites the line in the 200 existing slot `.toc` files when the number changes. Both this file and `addon/Runback/Runback.toc` move together. |

## Command line

`runback` (after `npm link`) and `node bridge/bridge.js` take the same flags. `npm start` runs `bridge/supervisor.js`, which restarts the bridge on crash and passes flags through.

| Flag | Meaning |
|---|---|
| `--project <dir>` | Default working folder for this run. Overrides everything else. |
| `--once` | Handle one pending reload-path message and exit. |
| `--inject "<text>"` | Pretend the strip said this, run the agent, publish the result, exit. Handy for checking a setup without the game. |
| `--agent <id>` | Which agent `--inject` uses (default: `agent` from the config). |
| `--help`, `-h` | Print usage. |

Exit codes: `0` normal, `1` the injected or one-shot job failed, `2` config missing, unreadable or naming an unknown agent. The supervisor only restarts on codes other than `0` and `2`.

## Environment

| Variable | Meaning |
|---|---|
| `WOW_AI_PROJECT` | Default working folder, below `--project` and above the start folder in precedence. |
| `CLAUDECODE` | Removed from Claude's environment so a bridge started from inside a Claude Code session can still launch `claude -p`. |
| `GROK_DISABLE_AUTOUPDATER` | Set to `1` for Grok runs, so a headless run never stops for an update. |
| `GROK_HOME` | Honoured when looking for `grok.exe` (`<GROK_HOME>\bin`); Grok's own setting. |
| `WOW_AI_MAP_FILE` | Set by the bridge for each run, whatever the agent: a file where the agent's tools append map commands, one JSON object per line (see [MAP.md](MAP.md)). |
| `WOW_AI_GUIDE_FILE` | Set by the bridge for each run, whatever the agent: a file where the agent writes a leveling guide as JSON, one guide or a list (see [GUIDE.md](GUIDE.md), "Channel to the addon"). |

## Which folder the agent works in

Each chat can pick its own folder with `/runback cd` or **Folder...** in the menu that opens when you right-click the chat in the left panel. Chats that have not are given the bridge's default folder, chosen in this order:

1. `--project <dir>`
2. `WOW_AI_PROJECT`
3. The folder the bridge was started from, unless that is inside this repo or a broad folder
4. `defaultCwd` in `config.json`, unless it is a broad folder
5. The mentor workspace (`forever.mentorDir`, by default `wow-mentor` next to this repo), created from the `mentor/` template on first use. Its `AGENTS.md` is refreshed from the template at each bridge start (the replaced copy is kept as `AGENTS.md.bak`); put your own notes in `LOCAL.md`, which is never overwritten

A broad folder is a drive root, your home folder or anything above it, or its Documents, Desktop or Downloads (also inside OneDrive): an agent working there reads unrelated files. The bridge refuses a chat there, even when the folder was named on purpose; start the bridge in a narrower folder or set `defaultCwd`.

A chat may work in the default folder and its subfolders, or in a folder listed in `allowedFolders`. Any other folder from the game is refused, and the reply says which folders are allowed. Only `config.json` adds one.

A relative `/runback cd` path is resolved against that default. `~` expands to your home folder. The agents keep sessions per folder, so a chat that changes folder starts a fresh session there; the same happens when a chat changes agent.

## Files the bridge writes next to itself

All of these are gitignored.

| File | Contents |
|---|---|
| `bridge/config.json` | Your configuration. |
| `bridge/state.json` | Agent session ids per chat, the folder and the agent each session ran with, handled message ids per addon session token, the presence counter, and the latest game context the addon sent (`context`). Delete it to forget all sessions. |
| `bridge/transcripts.json` | The last 200 messages of every chat, with the agent that wrote each reply, so the addon can recover its chats after the client wipes saved data. |
| `bridge/mapjobs/` | One map command file per running job (`WOW_AI_MAP_FILE`), read and deleted when the job ends. Map layers themselves live in `state.json` (`map`). |
| `bridge/guidejobs/` | One guide file per running job (`WOW_AI_GUIDE_FILE`), read and deleted when the job ends. Guides themselves live in `state.json` (`guides`). |
| `bridge/bridge.log` | Everything printed to the console, with timestamps. Grows without bound; delete it whenever you like. |
| `bridge/tmp/` | Prompt files for agents that read the prompt from disk (Grok). Each is deleted when its run ends. |

## `setup.js` flags

| Flag | Meaning |
|---|---|
| `--wow "<client folder>"` | The folder containing `Wow*.exe` and `Interface\`, when auto-detection fails. |
| `--project "<dir>"` | Written to `defaultCwd`. Left empty by default, which means the mentor workspace. |
| `--account <name>` | Which `WTF\Account\<name>` to use when there are several. |

Re-running `setup.js` re-copies the addon (except `Inbox.lua`, which the bridge owns once running), keeps an existing `config.json` (adding the `agents` blocks and fixing paths if it predates them), and only creates slot and signal files that are missing. An install under an old name is migrated: `WoWClaude.lua` and each account's `WoWAI.lua` are copied to `Runback.lua` when that file is absent (`WoWAI.lua` is left unchanged), and the old `WoWClaude`, `WoWClaude_S###` and `WoWAI` folders are moved to a dated backup outside `Interface\AddOns`. `WoWAI_Nodes` is not moved.

## Forever bridge modules

Keys under `forever` configure the bridge side of Forever modules. `disabled` skips module basenames.

| Key | Default | Purpose |
|---|---|---|
| `mentorDir` | `<repo>/../wow-mentor` | Mentor project root; its chats receive mentor agent restrictions. |
| `combatLogDir` | The `Combat logs:` line of `<mentorDir>/LOCAL.md` | Folder the review wait reads (read-only) to see whether the combat log has reached the end of the last fight. Empty and no such line: reviews start at once. |
| `reviewWait.timeoutMs` | `120000` | How long a review waits for the log before it starts anyway, saying so. `reviewWait.pollMs` (`2000`) is the check interval. |
| `coachGate.mode` | `"shadow"` | `off`, `shadow` or `on`. Decides whether a finished fight gets a review: clear cases by code, middle cases by one Jev question of numbers. `shadow` logs the decision and runs the mentor as before; `on` answers a quiet fight with one plain line. Also `coachGate.trivialSec` (45), `longSec` (180), `lowHpPct` (30), `dropRatio` (0.6), `askAbove` (0.5). |
| `clientDir` | Derived from `addonDir` | WoW client root used for screenshot and journal paths. |
| `screenshotsDir` | `<clientDir>/Screenshots` | Screenshot scan and watch directory. |
| `journal.enabled` | `true` | Generate a journal story on logout bulk data. |
| `journal.dir` | `<mentorDir>/journal` | Output directory for daily journal stories. |
| `journal.agent` | Empty (uses `agent`) | Optional agent override for journal generation. |
| `council.agents` | `["claude", "codex"]` | Agents that answer council questions. Unconfigured ids are skipped. |
| `council.synthesizer` | `"claude"` | Agent that synthesizes council answers. |
| `council.timeoutMs` | `240000` | Per-agent council timeout. |
| `phone.target` | `""` | Notification destination, such as `telegram` or `telegram:<chat>`; empty disables it. |
| `phone.command` | `"hermes"` | Executable used for phone sends. |
| `phone.notifyAfterMs` | `60000` | Minimum run time before ordinary completion notifications are sent. |
