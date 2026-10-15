# runback maintenance spec

Goal: keep runback working on the current Forever client and agent CLIs, safe, and getting better, one small verified PR at a time. The feature spec it was built from (F01–F25, S1–S5, AC1–AC34) is spec v2 in Atlas (`atlas-vault/01_Inbox/spec-wow-forever-ai-mentor-v2-2026-09-25.md`); `docs/forever-coverage-2026-09-25.md` maps each AC to its test, dry run or live check.

Baseline (2026-10-03, `forever` at cbebd5a): `npm test` 187/187 pass, codec round-trip PASS, safety CI green. Live column of the coverage doc: empty.

## Standing goals (checked every maintenance pass)

1. **Green.** `node tools/safety-ci.js` and `npm test` pass on Windows and Linux CI for `forever` and every PR. A red `forever` is fixed before anything else.

2. **Safe and Blizzard-compliant.** 100% compliant with Blizzard's ToS, EULA and UI add-on policy (permanent rule, Nercari, 2026-10-03; see `AGENTS.md` and `docs/COMPLIANCE.md`): anything that could breach them is rejected. No feature plays for the player, reads memory, injects code, generates input or helps during combat. Safety CI rules only get stricter.

3. **Current agent CLIs.** Claude Code, Codex, Grok Build, agy and Hermes stream formats still parse. When a CLI release changes its stream, add the new sample to `tests/agents_test.js` and fix the parser.

4. **Current game and policy.** `tools/policy-watch.js` alerts on a Blizzard policy change; read the diff and say whether the tool is affected. A new Forever client build gets its TOC and API checks.

5. **Upstream.** Compare with `https://github.com/chelinho139/wow-ai` main; bring in useful upstream fixes by PR, keeping `forever` behaviour.

6. **Measured improvement.** Each improvement PR names one number (a test count, a gate passed, a failure fixed) before and after.

## Backlog (numbered; next free: 92)

1. **Live gates (WOW-02).** Nercari runs `probe/PROBE.md` on the installed Forever client; agents turn the results into the gate table and switch features to their fallback where a gate fails. Needs Nercari in game.

2. **Live column.** Fill the Live column of the coverage doc from Nercari's in-game checks, one short checklist per batch.

3. **F25 screenshot transport (WOW-17, AC30).** Build only if its WOW-02 gate passes; otherwise keep the text/`look` fallback.

4. **Facts cache wording.** A cached fact says "checked today" instead of its fetch date (dry run 2, AC20). Fix in `mentor/AGENTS.md` and re-run the dry run.

5. **Hotkeys** (decided 2026-10-09, Nercari delegated the call; done, no code change). Keep the menu bindings that ship today (plus the player-typed `/runback bind <key>`): the player assigns keys in Options > Keybindings > AddOns > Runback, with no default keys, so no existing binding is overwritten. The auto-bind variant is dropped: it would need a safety-CI exemption (never weakened), and silently rebinding a player's keys is the kind of behaviour the compliance rule rejects.

6. **Publish (WOW-12).** Public fork and the upstream adapters PR were approved by Nercari on 2026-09-25 (GitHub only, no forum post). Publishing is external: prepare, then Nercari confirms before anything goes public.

7. **Replies during combat** (done, PR #4). Video review 2026-10-03: two replies showed mid-fight (5:55, 6:45). Replies now wait for the fight to end.

8. **Mentor workspace by default** (done, PR #13). The bridge started in Documents, so the agent ran as a general coding assistant and read unrelated files (0:00, 2:25, 2:55, 6:45). Start in the mentor workspace by default and warn in the window when the folder is a broad one like Documents. Metric: unrelated files read, 3+ in the video, target 0.

9. **Permission text in game chat** (done, PR #11). A permission request prints the raw command in chat, seven lines of PowerShell (2:55, 5:55, 6:20). Show one short line instead. Metric: chat lines per request 7 → 1. Second video (2026-10-03, 17:17): still 5 chat lines with the raw command (7:42, 8:20); reopened as item 30.

10. **"Blocked from an action only available to the Blizzard UI" popup** (8:00), right after pasting the agent's `/run` settings line. Cause not confirmed. Likely cause: the old `/r` shortcut tainted the chat box, and it has since been removed. Needs Nercari in game: play normally on the current build and report whether the popup appears and what was done just before. Do not test by pasting a `/run` line; the player never pastes scripts. Related to item 1.

11. **No untested `/run` scripts from the mentor** (done, PR #15). The mentor handed out untested scripts, including key rebinding (4:55, 8:15). It should point to the game menus (Options > Keybindings) instead. Fix in the mentor prompt. Related to item 5.

12. **Status line while waiting** (done, PR #17). Two different timers ("running 25s" and "running 17s", 0:45) and "0 actions" while six are listed (2:25). Show one timer and the right count. Second video: still two timers and two counts (1:20, 2:10, 10:52); reopened as item 32.

13. **Reply popup covers the quest tracker** and stays up for minutes (2:55 to 4:50, 6:45 to 7:40); it also opens with a blank gap at the top. Close it by itself or keep it clear of the tracker. PR #18 stops it opening for ordinary replies (it was the translation popup); for real translations it still stays until closed.

14. **Same reply shown three times** (done, PR #18): window, chat and popup, even with the window open (0:00). Show it once when the window is open.

15. **Copy box is see-through** (done, PR #20; live look pending), so the selected text sits on top of the reply (7:45). Give it a solid background.

16. **Footer looks crossed out and the title runs into the frame border** (done, PR #22; live look pending) (all video). Fix the layout.

17. **Window opens on top of the game chat** (done, PR #22; live look pending) by default (0:00, 5:10). Pick a default position clear of the chat.

18. **Copy button per command line** (done, PR #26; live look pending). A small [copy] link next to each command opens the copy box with only that line (7:45).

19. **Settings as a menu checklist** (done, PR #15). The mentor gives settings as menu paths the player ticks ("Options > Controls > Auto Loot: on") instead of scripts. Avoids the popups at 7:55 and 8:00. Builds on item 11.

20. **Starter questions for a new character** (done, PR #30; live look pending). A first-run card with four questions fitted to class and level (0:00).

21. **Level-up nudge** (done, PR #29; live check pending). After the fight in which the player levels up, offer "what changes at this level?" (6:20). Out of combat only; extends the level re-run from WOW-11.

22. **Death recap** (from Details! and Blizzard's death recap; see `docs/similar-addons-2026-10-03.md`). Recap lines at the top of `.death.txt` (done, PR #6).

23. **Health before each hit.** Add the player's health before each hit and the overkill of the killing blow to the death recap, read from the advanced log block. Needs a real Forever log with advanced logging (item 1) to confirm the field layout.

24. **Death file shows only incoming lines** (done, PR #9). `.death.txt` also lists hits the player dealt (the destination test matches the player as source). Small fix with a real-format test fixture.

25. **Warlock rubric** (done, PR #10) (from WoWAnalyzer's per-spec checklists). `mentor/rubrics/warlock.md` with uptime, cooldown and idle-time checks the mentor can prove from a log slice, every rule cited. Other classes later.

26. **Dummy practice compare** (done, PR #12) (from Localog). `cmd=practice`: review two target-dummy sessions and compare active time and damage from their scorecard rows.

27. **One-click update and launch.** Nercari asked (2026-10-03) to install, update and start without terminal commands. `Runback.cmd` and its desktop icon do update, install, bridge start and the reload/relaunch advice. Metric: terminal commands per update, 2 (`git pull`, `node setup.js`) plus starting the bridge → 0. Live check pending (Nercari double-clicks it).

28. **Switch AI and model in game** (done, PR #35; live look pending). Nercari asked (2026-10-03) to pick between his available AIs from inside the game. An AI button lists the agents installed on the PC and their models; one click switches the chat. Metric: switching to another model, typed commands and a config edit plus a bridge restart → one click. Live look pending.


Items 29 to 40 come from the second video review (2026-10-03, recording of 17:17, 14 min 39 s; timestamps are accurate to about 5 seconds). Live looks passed in that video: starter questions (item 20, 0:30), level-up nudge (item 21, 14:27), AI switcher (item 28, 0:25 to 3:15), copy box (item 15, 1:20), footer, title and window position (items 16 and 17, 0:25).

29. **Fight review is reachable** (done, PR #38 addon; PR #40 mentor). Nercari asked for a review four times in four minutes and gave up (7:05 to 11:15): the mentor said "send the addon's review command" without naming it, the window had no Review button, and a typed "review" did not attach the fight times. PR #38 added the "Review last fight" button and treats a typed "review" as the command; PR #40 makes the mentor name `/ai review`. Metric: tries before a review starts, 4 failed → 1.

30. **Permissions for reading** (done: mentor part PR #43; reopened by item 48, PR #65; Allow covers every part of a piped command, chat shows one fixed line, Allow button shows plain names, PR #54). "Allow Bash(ls:*) & retry" did not unblock the agent (7:50, blocked again at 8:37, then "Allow PowerShell & retry" at 11:07); inferred cause: the rule does not cover a command with pipes. The mentor reads logs with its file tools, not shell commands; Allow really unblocks; chat shows one short line (reopens item 9). Metric: permission prompts in a session 3 → 0; chat lines per prompt 5 → 1.

31. **Minimise the window when a fight starts** (done, this PR; live look pending). The rotation reply stayed readable during a fight (5:15 to 5:20). Minimise on combat start, restore after. Metric: seconds of AI advice visible in combat, about 10 → 0.

32. **Status line** (done, this PR; live look pending) (reopens item 12): one timer, one action count, no "5 actions, no activity seen yet", and no internal words ("#13", "Sending #16...", 1:15, 7:52).

33. **Combat log status in the window** (done, this PR; live look pending). A line "Combat log: on / off" read from the game, with a button the player clicks out of combat to switch it on. `/combatlog` is a toggle and Nercari switched it off again without noticing (10:30, confirmed by Nercari). Check `docs/COMPLIANCE.md` before building.

34. **Small window fixes.** "Reply arrived. Your draft is back in the box" shows with an empty box and inside the AI's message (7:47, 7:52); the AI menu keeps the old chat name after a chat switch and is see-through (0:25, 0:30); the same reply shows in the window and in chat while the window is open (2:30); an empty chat is left behind each time an AI is tried (1:05).

35. **Copy icon per message** instead of the "Click to copy this message" tooltip that follows the mouse and hides the text (2:45, 5:05, 7:47, 10:07).

36. **Reply formatting and background.** Backticks and `**` show raw (7:47, 11:07); names and damage numbers show through the reply text (5:20, 7:47).

37. **Mentor wording** (done, PR #54). No developer talk to the player ("this folder is not a git repo", 7:02; "the shell command I tried was blocked", 8:37) and no listing of folders outside the workspace (7:42). Fix in `mentor/AGENTS.md`.

38. **New-quest nudge** (done, this PR; live look pending). After a quest is accepted out of combat (12:50, 14:30), a chat link "[explain this quest]", like the level-up nudge (item 21).

39. **Quest reward question** (done, this PR; live look pending). A button next to the reward window that puts the offered items into the question box (14:20); the player still chooses and clicks. Was: a link on the reward window that puts the offered items into the question box (14:20); the player still chooses and clicks.

40. **Follow-up buttons and session recap.** (follow-up buttons done; session recap done, this PR, live look pending: `/ai recap`, `tools/session-recap.js`, a chat offer after a fight and 5 quiet minutes) One-click follow-up questions under a reply (5:05), and a short recap of fights, deaths and time when the player stops. Split into two items when started.

Items 41 to 46 make the AI picker match each CLI's own models and effort levels (Nercari, 2026-10-09). Spec, sources and ticket details: `docs/model-picker-spec.md`.

41. **Confirm the CLIs on Nercari's PC.** (done, results in `docs/model-picker-spec.md`; Grok not installed, Codex sign-in expired) Record each CLI's real model list and effort flag on his PC, through Remote Control; no game.

42. **Built-in model catalog.** `bridge/models.js` with every CLI's models and effort levels. Metric: models offered with no config, Claude 3 / others 0 → the CLIs' own counts.

43. **Effort on the command line** (done for Claude `--effort` and Hermes `--reasoning`, this PR; Codex waits for `codex login` and one rerun, Grok for an install on Nercari's PC, agy keeps the level in the model id). `effort=` flag, checked per model, passed as each CLI's own flag.

44. **Effort levels in the inbox.** The bridge tells the addon which levels each model takes and its default.

45. **Effort row in the AI picker.** Pick a level after the model; chat label "Agent · model · effort"; closed in combat. Live look by Nercari.

46. **Read the CLI's own model list.** Codex cache, `agy models`, `grok models`, behind an off → shadow → on switch.

Items 47 to 63 come from the third video review (2026-10-11: recording A, 40 min, on Nercari's PC; recording B, 7:41, uploaded). Findings, timestamps and evidence: `runback-video-review-2026-10-11.md` in the project files. Live looks passed: combat fold (item 31), combat log button (item 33), status line (item 32), copy icon (item 35), and a useful review once the log had the fight (A 15:00 to 16:40).

47. **Review waits for the log** (done, PR #66; live look pending). Clicking Review right after a fight ran the agent for 1 m 30 s to say "the game has not saved it to the combat log" (A 8:30 to 15:00). The bridge compares the log's last line time with `lastFight.end` before starting the agent; if the log is behind, it says so in one line and starts the review by itself when the file catches up. Metric: agent runs ending in "not saved yet", 1 per review → 0.

48. **Mentor tools run without prompts.** (done, PR #65; live look pending) "Allow cd, node, echo, PowerShell & retry" still appears after a review, and "my automatic quote-checker could not run" twice (A 10:25, 15:00, 16:40). Inferred cause: `cd ... && node ...` does not match `Bash(node:*)`. The mentor calls `slice-fight.js` and `check-citations.js` as one plain `node <absolute path>` command; a bridge test checks those commands against the allowed rules. Reopens item 30. Metric: prompts per review 1 → 0.

49. **Plain-word progress lines** (done, PR #67; live look pending). The working list shows raw greps, regexes, paths and tool ids (A 9:20 to 16:10). Show at most three short phrases ("Reading your combat log"). Metric: raw command lines per review, about 10 → 0.

50. **Readable review evidence** (done, PR #67; live look pending). Replies quote whole combat-log lines (A 15:00, 16:40). The saved review keeps the quotes for `check-citations.js`; the reply shows one plain evidence line per mistake. Metric: raw log lines in a reply, 2 to 4 → 0.

51. **Fight questions in the player's words** (done, PR #68; live look pending). After a death, "what did i do wrong in my last fight?" got "I don't have the timestamps... click Review" (A 23:30). For 10 minutes after a fight or after a death, every message carries the `lastFight` and `deaths` lines. Extends item 29. Metric: replies asking for the button instead of answering, 1 → 0.

52. **Stalled or silent agent runs** (done, PR #72; live look pending). Antigravity ended with "(finished without a reply)", then ran 13 m 46 s with no answer (A 26:15, 40:00). After 3 minutes without a new action or 5 minutes in total, the status line offers Stop and "Ask Claude instead"; a run with no reply says what it did and offers the same. Add an agy sample to `tests/agents_test.js` if the stream shows a parse gap. Metric: longest wait with no way out, 13 m 46 s → 5 min.

53. **Solid window background, for real** (reopens the background part of item 36). After PR #51 the map and grass still show through the reply text (B, whole video). Inferred cause: `Forever_Skin.lua` swaps in the translucent `UI-DialogBox-Background`. Keep a solid fill under the content. (done, PR #76; live look pending) `Dialog()` now adds one opaque `0.03, 0.03, 0.05` fill inside the 11px border of every skinned window; the copy box reuses its own. Live look by Nercari.

54. **No internal lines in replies** (done, PR #67; live look pending). `[bridge] map: layer wand: 2 point(s)`, `[Runback map] ... 2 point(s)` and a leftover "[bridge] Claude needs your OK" with no button (B 7:38, A 16:10, 19:30). One plain line ("I marked 2 places on your map: open it with M"). Metric: `[bridge]` lines in replies, 4 → 0.

55. **Slash lines stay in the addon** (done, PR #74; live look pending). `/model 3.8 flash` typed in the box went to the agent as a prompt and renamed the chat (A 20:05). A box line starting with `/` runs locally or says it is unknown; it never reaches the agent. Builds on items 42 to 45. Metric: slash lines sent to an agent 1 → 0.

56. **Follow-ups that fit the reply.** (done, PR #78; live look pending) The same two buttons ("Review my last fight", "What should I buy first?") follow every reply, including routes and a model switch (B 2:00, A 18:05). The mentor may suggest up to two follow-ups in a tagged line the bridge turns into buttons; with none, show none. Metric: unrelated follow-ups, 5 of 5 → 0.

57. **Recap offer timing.** (done, PR #78; live look pending) "Done for now? [recap this session]" appeared while Nercari was using the window (A 19:35). Window use resets the quiet clock. Metric: offers within 5 minutes of window use, 1 → 0.

58. **Combat log reminder at login.** (done, this PR; live check pending) The log was off after login and Nercari fought for a minute before switching it on (A 1:15 to 2:45). One chat line with a clickable "[turn on combat log]" link when logging is off at login, and "This fight wasn't logged" on the small bar after an unlogged fight. Never switched on automatically. Check `docs/COMPLIANCE.md` before building. Metric: unlogged fights before the player is told, 3+ → 0.

59. **Honest map coordinates.** (done, PR #79) A shared pin at 9.7, 63.9 came back as "around 10.5, 64.2"; marks were "Classic-era positions, approximate"; place details came from one web page (B 5:10, 7:38; A 19:30). In `mentor/AGENTS.md`: use the player's coordinates verbatim and label approximate or single-source points. Metric: player coordinates restated wrongly 1 → 0.

60. **Tracked quests and shared pins in the context.** (done, this PR; live check pending) "The game does not report which one you currently have tracked", then five web searches to decode `/mappin 1420 9.7 63.9` (B 0:50 to 4:00). The context lists watched quests with objectives, and the addon turns a shared pin into "Tirisfal Glades 9.7, 63.9" with `C_Map.GetMapInfo`. Read-only UI API. Metric: searches to decode a map id 5 → 0.

61. **Known spells in the context.** (done, this PR; live check pending) A rotation answer hedged "if you have it" on Bane of Agony and Life Tap (A 18:05). Build, rotation and review requests carry the spellbook with ranks. Metric: "if you have it" hedges 2 → 0.

62. **"What can I sell or drop?"** (done, this PR; live check pending: `/ai bags`, a plain question about bags or selling, and a chat offer when the bags fill up) Nercari destroyed items one by one with full bags (A 28:40). A question that sends bag contents with vendor prices and quest flags; the mentor answers with a short list and the player does every action. Nothing is sold, dropped or moved by the addon. Check `docs/COMPLIANCE.md` before building.

63. **Low-health pulls in the recap.** (done, this PR; live check pending: a pull below half health, then `/ai recap` or `/ai review`) Several pulls in a row at low health from A 34:05. The session recap (item 40) and requested reviews add "fights started below 50% health: N" with one tip; never shown before a pull.

64. **OpenCode as an agent.** Nercari asked (2026-10-11) to use his OpenCode models in game. Record the CLI's real flags and output on his PC (version 2.0), then add `opencode` to the bridge so it shows in the AI menu. Ticket in `docs/model-picker-spec.md`. No spend: only models his sign-in already gives. Metric: OpenCode replies in game 0 → 1.

65. **OpenCode models and reasoning in the picker.** Same request: pick an OpenCode model and its reasoning level ("variant") like in the OpenCode CLI. Needs 64 and items 42, 44, 45. Ticket in `docs/model-picker-spec.md`.

Items 66 to 76 are Nercari's request of 2026-10-11: "a leveling guide just like RestedXP". The meaning of the extra word "REA" in his message is unclear; read as a typo for RestedXP, the product named in the same sentence (INFERRED, recorded so a wrong reading can be fixed). Nercari added: do not copy RestedXP, improve on it. Its code (github.com/RestedXP/RXPGuides) is CC BY-NC-SA 4.0, which an MIT project cannot reuse, so only ideas are taken. It accepts and turns in quests, clicks gossip, takes flights, confirms hearth binds and writes targeting macros for the player, most of it on by default; runback does none of that. Items 75 and 76 are the improvements: a guide that explains itself and adapts to the player's real quest log, which a fixed guide cannot. The guide is a read-only step list, like RestedXP's: it shows the next steps, ticks them off from the player's own quest log and points at the place on the map. Every action stays the player's. No guide text is copied from RestedXP or any other paid or licensed guide; steps are written by the mentor from the player's own data folder (`docs/MAP.md`, "Where the data comes from") or by us. Ticket details: `runback-leveling-guide-fix-threads-2026-10-11.md` in the project files.

66. **Guide file format and validator** (done, PR #81). A guide is a named, ordered list of steps: `kind` (`accept`, `do`, `turnin`, `travel`, `train`, `buy`, `note`), a short text, an optional quest name and id, optional map points (`uiMapID`, x, y), a level range, class, race and faction filters, and step flags `optional`, `sticky` (stays shown until done) and `completewith` (closes when a later step is reached), ideas taken from RestedXP's format. `docs/GUIDE.md` defines it; `bridge/guide.js` validates and sanitises it the way `protocol.js` does map layers (clamped coordinates, text length, at most 600 steps per guide, 12 guides). Pure code, no game. Metric: guide files the bridge can validate, 0 → a fixture set with valid, oversized and hostile inputs.

67. **Guide channel to the addon** (done, this PR). Same route as map layers (`docs/MAP.md`): the bridge sets `WOW_AI_GUIDE_FILE` for every run, takes a ```` ```wowguide ```` block out of a reply, keeps the guides in `state.json`, and sends them in the slot files with a version. Needs 66. Metric: guides that reach the addon, 0 → 1 (a test round-trips one through `Codec.lua`).

68. **Safety CI bans quest automation** (done, this PR). `tools/safety-ci.js` rejects the calls that would accept, turn in or pick a quest or gossip option for the player (`AcceptQuest`, `CompleteQuest`, `GetQuestReward`, `SelectGossipOption`, `SelectActiveQuest`, `SelectAvailableQuest`, `AcceptGossipQuest`, `C_GossipInfo.SelectOption` and their `C_QuestLog` equivalents; RestedXP's code adds `ConfirmAcceptQuest`, `C_GossipInfo.SelectAvailableQuest`, `C_GossipInfo.SelectActiveQuest`, `C_GossipInfo.SelectOptionByIndex`, `ConfirmBinder`, `TakeTaxiNode`, `BuyTrainerService`, `LearnTalent`, `PickupMerchantItem`, `DeleteCursorItem` and `AbandonQuest`), with one test per name. Questie's own auto-quest module calls exactly these, which is why the check exists. Land this before any guide code (item 69). Metric: quest-automation calls the checker rejects, 0 → every name listed, 0 false hits on today's addon.

69. **Guide panel (read only)** (done, this PR; live look pending). A small window `Forever_Guide.lua` showing the current step and the next two, with Previous / Next buttons the player clicks, a guide picker and a "hide" button; `/runback guide` commands. Collapses at combat start and returns after, like item 31 (the text is AI-written, so none shows during a fight). Own frame, no Blizzard function replaced. Needs 66, 67, 68. Metric: steps shown that the player did not have to ask for, 0 → 3. Live look by Nercari.

70. **Progress from the quest log** (done, PR #93; live look pending). The panel ticks a step off, and moves on, when the player's own quest log shows it done: quest accepted, objective complete, quest turned in, level reached. Read-only (`C_QuestLog`, `UnitLevel`, quest events, as `Forever_Bulk.lua` and `Forever_Nudge.lua` already read). It never accepts, turns in, targets or moves anything; the player can always tick or untick a step by hand. Needs 69. How (from a read of the installed Questie addon, 2026-10-11, ideas and API names only): key each step by quest id; done means in the log, objectives complete, or flagged completed (`IsQuestFlaggedCompleted`); react to `QUEST_ACCEPTED`, `QUEST_TURNED_IN`, `QUEST_REMOVED` and `QUEST_WATCH_UPDATE` instead of polling; snapshot the log on `QUEST_LOG_UPDATE` and retry, because objective data arrives late. Metric: manual clicks per quest (accept, objectives, turn-in), 3 → 0 when the log matches. Live look by Nercari.

71. **Step location on the map** (done, PR pending; live look pending). The current step's points go to the existing map layer `guide` and navigator (`Map.lua`), so the arrow and distance point at the step. A point may carry a radius: arriving inside it ticks that point off (RestedXP does the same). Display only: nothing moves the character. Needs 69. Metric: steps with a location the player can follow, 0 → all steps that carry a point.

72. **Mentor writes guides** (done, PR #83; hard rule 13 in `mentor/AGENTS.md`). `mentor/AGENTS.md`: for "make me a leveling guide" the mentor reads class, race, faction, level and quest log from the context, asks at most one question, and writes a guide into `WOW_AI_GUIDE_FILE` in short, bounded chunks (about one zone per file). Rules: use only the player's data folder or well-known facts it can cite; label approximate or single-source steps (as item 59); never copy a paid or licensed guide; steps are things the player does by hand, never macros or scripts (hard rule 9). Needs 66. Metric: guide steps with a stated source, 0 → all.

73. **Re-plan from here** (done, PR pending; live look pending). A button, out of combat, sends level, zone, quest log and the current step to the mentor and asks for a guide from there on, for the player who skipped steps or took another route. Needs 70 and 72. Metric: manual re-planning needed after a detour, a new chat question → one click.

74. **Original starter guide** (done, PR #87; live look pending). One short guide we write ourselves (levels 1 to 5, one starting zone) shipped as a test fixture and a demo, so the panel can be checked in game before the mentor writes any. No third-party data. Needs 66. Nercari's live check of 69 to 71 uses it.

75. **Explain this step** (done, PR pending; live look pending). A button on each step puts "why this step, and what do I need?" plus the step and quest name into the question box, like the quest nudge (item 38); the player sends it and the mentor answers out of combat. Needs 69. Metric: steps the player can get a reason for in one click, 0 → all.

76. **Guide fits the player's log** (done, PR #102; live look pending). On load and after each quest event the panel skips steps already done and steps whose quest the player cannot take (level too low, wrong faction), and shows an XP pace line ("about N min to level, from your last 10 minutes") from the game's own XP values, and keeps time per level, as RestedXP's leveling tracker does, for the session recap (item 40). Availability is a plain rule set (prerequisite and exclusive quests, race, class, level, reputation, profession, chain), as Questie checks it. Read-only, display only. Needs 70. Metric: steps the player has to skip by hand when the log already shows them done, every one → 0. Live look by Nercari.

Items 77 to 83 come from the fourth video review of 2026-10-11 (recording "Gravando 2026-10-11 201327", 6:58, level 10 Warlock in Tirisfal Glades). Findings with timestamps: `runback-video-review-2026-10-11-fourth.md` in the project files.

77. **Stranded reply when the slot pool runs out** (done; live check pending). "Slot pool used up this session - next keypress reloads to free it" showed for the last 4 m 46 s while "Antigravity working..." never turned into a reply (2:12 to 6:58). The slot line also hides the item 52 stall offer (`UpdateStatus`). With a reply waiting and no free slot, the window says "Your reply is ready on the PC" and shows a "Get reply" button whose click reloads the UI; the stall offer still shows. Never reloads from a timer or event. Shipped wording: "Out of reply slots: click Get reply to check for your reply (the game UI reloads)", since with no free slot the addon cannot tell whether the reply is finished. Metric: replies stranded after the pool ran out, 1 → 0.

78. **Fewer slots per reply** (done; live check pending). The sound-file signal channel fails its self-test on Forever ("an empty file reports as playable", 5:12), so every poll and idle check spends one of the 200 slots (INFERRED cause of 77). First report slots used per reply and per hour in `/runback diag` and the session recap, then spend slots only while a reply is pending, with a longer back-off. Metric: slots per reply, measured → halved. Shipped: 19 → 8.5 in the test evening (`tests/forever/addon_slot_budget.test.js`); the recap was left out, since it is a question to the coach, not a stats line.

79. **No reply text in a window opened mid-fight.** (done) Nercari opened the window in combat and read a talent build for about 27 s (3:12 to 3:39); `Forever_Calm.lua` lets a manual open win. While the lockout is on, the reply area shows one line "Replies are hidden during combat" and the text comes back after the fight; chat list, status and input stay. Safety gets stricter (goal 2). Metric: seconds of AI text visible in combat, about 27 → 0.

80. **Agents name only real controls** (done, PR #97; live check pending). Antigravity said "type /ai look (or click Look in the addon window)"; there is no Look button, and `/ai look` alone prints "Usage: /ai look <text>" (1:57 to 2:12). The game system prompt (`bridge/protocol.js`) lists the window's buttons and the `/ai` commands with their usage, checked by a bridge test against the addon; `/ai look` with no text looks with a default question. Metric: invented controls in replies 1 → 0; failed `/ai look` 1 → 0.

81. **Plain names for connector tools on Allow** (done, PR #97; live check pending). "Allow PowerShell, node, mcp__claude_ai_Google_Drive__create_file & retry" (3:36). An `mcp__<server>__<action>` rule reads "Google Drive (create file)"; other unknown rules show their first word. Extends item 30. Metric: raw tool ids on Allow buttons 1 → 0.

82. **Bottom row and footer** (done, PR #98; live look pending). Reload is drawn on top of Resend ("ResenReload", 2:12 to end), and the footer shows "cwd: C:\Users\... (bridge default) agent: Antigravity mode: pixel" all session. The two buttons never overlap; the footer details move to the light's tooltip or show only the agent name. Metric: overlapping buttons 1 → 0; developer words on screen 3 → 0. Live look by Nercari.

83. **Combat log button flips off by itself** (done, PR #98; live check pending). The button read "off" in single stills between "on" ones with no click (3:12, 5:12, 5:21). Cause unknown. Record each `LoggingCombat()` change with its time in the diag output and say once in chat when logging turns off without the player's click. Read-only; never switches logging on. Metric: unexplained flips, 3 in 7 min → cause named, or 0.

84. **"look" in the box, and no false look in Antigravity** (done, this PR; live check pending). Nercari pressed Print Screen, typed "look!" in the window box and pressed Send; it went to Antigravity as a plain message, which answered "No picture came through" and pointed at a Look button that does not exist (screenshot, 2026-10-12). `/ai look` in an Antigravity chat always fails, yet item 80's prompt told every agent it works. A lone "look" in the box ("look", "look!", "look at this", "look at my screen") runs `/ai look`, the box takes `/look [question]`, and a chat whose agent can't see screenshots is told so in its prompt and names the agents that can. One flag, `takesImages` in `bridge/agents.js`, decides both the prompt and the look error. Metric: lone "look" sent as a plain message 1 → 0; prompts that advertise a look that fails 1 → 0.

Items 85 to 91 are the Runback roadmap, requested by the Grok Director on nercari-control #97 (2026-10-13 08:18Z) for Nercari. Now: the rename. Next: the R1 must-fixes, mockups before code. Later: coaching. Rules for all seven: the optional `WoWAI_Nodes` data addon keeps its name; credit the owner as Nercari only; every PR passes `npm test` and `node tools/safety-ci.js` on node 22 and is checked against `docs/COMPLIANCE.md`; anything only the game can show goes on Nercari's live checklist (item 90). Baseline at `forever` 9bc2c87: `npm test` 637 pass, 0 fail (640 tests); safety CI exit 0.

85. **Rename to Runback (R0)** (done, PRs #113 and #115). The addon folder, TOC, saved variables and slash commands are Runback, the README shows the icon, and the GitHub repo is already `Nercari/runback` (checked 2026-10-13: `git ls-remote https://github.com/Nercari/runback HEAD` returns `forever` 9bc2c87, and pushes to the old `Nercari/wow-ai` URL redirect there). Goal 5 now compares with `https://github.com/chelinho139/wow-ai` main. Clone commands in the README, CONTRIBUTING and both install docs already use `https://github.com/Nercari/runback`; none still say `wow-ai`.

86. **R1 upgrade must-fixes** (done, PR #116; live check pending). Checked on `forever` 9bc2c87:
    - Old `WoWClaude`, `WoWClaude_Sxxx` and `WoWAI` folders are moved into `Runback-backup-YYYY-MM-DD`, never deleted (`setup.js` `moveAside`, line 83; caller line 132; no `rmSync` left in `setup.js`).
    - All five legacy saved variables (`WoWAIDB`, `WoWAIMapDB`, `WoWAIGuideDB`, `WoWAIForeverDB`, `WoWAI_Bulk`) are declared in the TOC and copied once into their Runback names (`Runback.toc` line 6, `MigrateAllLegacySaved` in `Runback.lua` line 267).
    - `SlashCmdList["WOWAI"]` stays as an alias (`Runback.lua` line 3805), with `/wowai`, `/wow-ai`, `/wow-claude`, `/ai` and `/ask`.
    - `/rb` is rechecked at login; when another addon owns it, one chat line says `/runback` still works (`RecheckRbSlash`, line 3584, called at line 3824).
    - One desktop shortcut, `Runback.lnk`, with `docs/assets/runback.ico` as its icon; this launcher's old shortcuts move into the backup folder (`tools/launch.js` lines 299 to 323).
    Icon v3, confirmed and left in place: `docs/assets/runback.ico`, `runback-icon.png` and `runback-social.png` are the files from ec13690, byte-identical to the v3 masters (sha1 prefixes fe904ba0, 0248e435, b6451974). The desktop shortcut already uses the `.ico` (`tools/launch.js`) and the README already shows `runback-icon.png`.

87. **Two-SHA install proof** (done, PR #120: `node tools/upgrade-proof.js [head] [old]`; on `forever` bba7a2c it failed 3 of 8 checks, the `WoWAI` config paths and slot folders, fixed in the same PR) (the gate for 86 and every later rename-related PR). Script it as `tools/upgrade-proof.js` so it runs the same way every time, in temporary folders, without touching a real client:
    - Clean install: run `setup.js` from the PR head into an empty client folder. Expect `Interface/AddOns/Runback` and no `WoWAI` folder.
    - Upgrade: install from `fdc5d0c` (the last commit before the rename), add sample `WoWAI*.lua` saved variables and a `WoWAI_Nodes` folder, then run `setup.js` from the PR head. Expect the old folders in the dated backup, each `Runback*.lua` present, every old file still on disk, and `WoWAI_Nodes` unchanged in place.
    The PR body pastes the script's output with both SHAs. Metric: install paths proven by a repeatable script, 0 → 2.

88. **Mockups before code.** Kern (Grok crew) draws the chat panel and the between-pull checklist before anyone writes code for them. Put them in `docs/mockups/` (images plus one short note per screen: what the player sees, what each control does, what hides in combat). Nercari approves the mockups; the code items that follow link them. Each mockup is also checked against `docs/COMPLIANCE.md`: no control that acts for the player.

89. **Colourblind-safe map pins with a toggle.** Today's colours (`KIND_COLOR`, `Map.lua` line 28) put red (kill), green (herb, vendor) and orange (ore, dungeon) side by side, which red-green colourblind players cannot tell apart. Add a colourblind-safe palette (Okabe-Ito based) used the same way on every layer, a toggle `/runback map colors safe|classic` saved in `RunbackMapDB`, and a matching line in `/runback help`. Default: safe. Test in `tests/map_addon_test.js`: under a simulated deuteranopia and protanopia transform, every pair of pin kinds shown together stays apart by a fixed minimum distance, and the toggle switches palettes and survives a reload. Metric: pin-kind pairs that collapse under the simulation, counted before → 0. Pins stay the addon's own textures, so no compliance change.

90. **Live-client checklist for Nercari.** One short list he runs after 86 and 89 land: upgrade on his PC with the shortcut; old chats and map marks still there; `/runback`, `/wowai` and `/rb` (or the one-line hint); the shortcut shows the Runback icon; pins readable with the safe palette and the toggle works. Results fill the Live column and close the "live check pending" notes on 85, 86 and 89.

91. **Coaching phases (later).** The between-pull coaching that the README promises. Not specified yet: it starts after 88's mockups are approved, as new numbered items, each with one metric.

Add new items at the end with the next number, one blank line between items (so parallel PRs append without touching each other's lines); mark done items `(done, PR #n)` instead of deleting them.
