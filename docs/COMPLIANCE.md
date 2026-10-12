# Blizzard policy compliance

Permanent rule (Pedro, 2026-10-03): wow-ai must comply 100% with Blizzard's Terms of Service, EULA and UI add-on policy. Anything that could breach them is rejected; when in doubt, don't ship it and ask Pedro. Every PR is checked against this page.

## Sources

| Source | Version read | What it says that matters here |
|---|---|---|
| [Blizzard EULA](https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement) | last updated 2024-03-21, read 2026-10-03 | 1.C.ii: no cheats, no bots ("automated control of a Game ... e.g. the automated control of a character"), no hacks, no unauthorized software that "changes and/or facilitates the gameplay or other functionality". 1.C.vi: no unauthorized software that "intercepts, collects, reads, or 'mines' information generated or stored by the Platform", though Blizzard "may ... allow the use of certain third-party user interfaces". 1.C.i: no reverse engineering or modifying the client. |
| [UI Add-On Development Policy](https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534) | posted 2018-11-19, read 2026-10-03 | Add-ons must be free (1), have fully visible code (2), not harm realms or other players (3), carry no advertising (4) or donation requests (5), contain nothing offensive (6), and follow the ToU and EULA (7). Blizzard may disable add-on functionality (8). |
| [Prohibitions on third-party software](https://us.forums.blizzard.com/en/wow/t/prohibitions-on-third-party-software/2142972) | 2025-08-05, read 2026-10-03 | Third-party software that modifies the game client is against the ToS; restates EULA 1.C.ii. |
| [Support article 13078](https://us.battle.net/support/en/article/13078) | not readable | The page renders only with JavaScript, so neither a fetch nor `tools/policy-watch.js` sees its text. Unverified. |

`tools/policy-watch.js` watches the same list (`tools/policy-sources.json`) and alerts on change.

## What the rule means for this repo

| Area | Rule | Enforced by |
|---|---|---|
| Gameplay | Nothing casts, targets, moves, attacks, uses items, buys, sells, bids, posts auctions, trades, or accepts, turns in, abandons or picks a quest, gossip option, trainer service, flight path or talent for the player (backlog 68: `AcceptQuest`, `CompleteQuest`, `GetQuestReward`, `SelectGossipOption`, `C_GossipInfo.SelectOption` and the rest of the list in `tools/safety-ci.js`). Macros the agent suggests are created only when the player clicks, never in combat, and never with `/run`, `/script`, `/console` or `/dump`. | `LUA-PROTECTED-AUTOMATION` in `tools/safety-ci.js`; `Forever_Macro.lua` |
| Input | No generated keystrokes or clicks, no window focusing, no global keyboard hooks. The push-to-talk helper uses `RegisterHotKey` and never touches the game window. | `FORBIDDEN-API` |
| Memory and client | No reading or writing game memory, no code injection, no client modification. The addon is plain Lua in `Interface/AddOns`. | `FORBIDDEN-API` |
| Secure UI code | No replacing Blizzard functions or methods on Blizzard frames; react with `hooksecurefunc` or `HookScript`. Replacing them taints the game's secure code, and the game then blocks the player's own typed `/cast`, `/run` or settings changes and blames the addon. Protected and hardware-event calls (`ReloadUI` among them) run only from a real keypress or click, never from a timer or event. | `LUA-TAINT`; `tests/addon_test.js`, `tests/forever/addon_slot_pool.test.js` |
| Combat | No AI output or advice during combat or encounters: sends are blocked and replies are held until the fight ends. | `Forever_Lockout.lua`; tests in `tests/forever/` |
| Code and money | Code stays readable (no obfuscation), free, with no advertising or donation requests. | `OBFUSCATION`, `POLICY-SOLICIT` |
| Agent advice | The mentor gives settings as menu paths, not `/run` scripts, and never suggests anything that automates play. | `mentor/AGENTS.md` hard rule 9 and the game system prompt in `bridge/protocol.js`; `tests/bridge_test.js` |
| Agent-built addons | Addons the agent writes go through the untrusted lint before they can be loaded, and the player loads them by hand. | `tools/safety-ci.js --untrusted`; `bridge/forever/modules/60-builder.js` |

## Audit, 2026-10-03

Fixed in the PR that added this page:

1. **`/r` replaced three methods on every game chat box** (`ProcessChatType`, `SendMessage`, `SendText`). That tainted the box, so a `/run` typed there afterwards could be blocked with "WoWAI has been blocked from an action only available to the Blizzard UI", the popup seen in the 2026-10-03 video (backlog item 10). This is the likely cause but it is inferred, not confirmed in game. `/r` is back to the game's own whisper reply; the `[reply]` link answers the agent.
2. **A reload asked for in combat called `ReloadUI()` from the combat-end event**, which is not a keypress or click, so the game blocked it and blamed the addon. It now reloads on the first keypress after combat.

Checked and compliant:

- Auction house: the addon only reads search results (`SendSearchQuery` on a 1.5 s timer while the player has the auction house open, at most 50 items). It never bids, buys or posts. Whether the Forever client accepts `SendSearchQuery` from a timer is unverified in game.
- Key bindings: the addon never binds keys on its own. `/wow-ai bind <key>` binds one key to the addon's own button when the player types it, out of combat.
- Keypress reload: the hidden key catcher lets every key through to the game and only reloads the UI; it never acts in the world.
- Translation reads chat only on channels the player turns on (none by default) and pre-fills the reply box; the player presses Enter to send.
- Screenshots: only the game's own `Screenshot()` behind a button the player clicks.
- Reply slots (backlog 78): fewer `C_AddOns.LoadAddOn` calls on the addon's own slot addons and a grey status light while idle. No gameplay, targeting, input or protected API is touched.
- Combat log: `LoggingCombat(true)` runs only from the player's click on the **Combat log** button or the **[turn on combat log]** chat link, out of combat. The login reminder and the "This fight wasn't logged" note only read `LoggingCombat()` (backlog 58).

Decisions and open questions for Pedro (nercari-control #114):

1. **Screen reading of the message strip** (decided 2026-10-03: Pedro keeps it; revisit if Blizzard's policy or enforcement changes). The addon draws a strip of coloured squares and the bridge screen-captures it to read your messages. That is the addon's own output, nothing about the game is read, and companion apps that read what an addon exports (combat log uploaders, WeakAuras Companion) are widely used. But EULA 1.C.vi literally covers software that "reads ... information generated ... by the Platform", and Blizzard has never expressly authorized this method. Choices: keep the strip (the tool works as it does today), or switch the default to `mode reload` (messages leave through saved data on `/reload`, the same path as the tolerated companion apps, but every message needs a reload).
2. **Sending other players' chat to an AI service** (the opt-in translation feature). Not a Blizzard clause we found, but it sends other people's words off the machine. Keep opt-in, or remove.
