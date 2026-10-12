# Guide files

A **guide** is a named, ordered list of steps for the player to follow by hand: where to go, which quest to accept, what to do, when to turn in. The format is read-only data. **Every step is something the player does themselves.** No field in it triggers, queues or automates a game action (accepting, turning in, targeting, travelling, buying, training); a guide only says what to do and where. This keeps it inside `docs/COMPLIANCE.md`.

`bridge/guide.js` validates and sanitises guide files the way `bridge/protocol.js` does map layers: unknown fields are dropped, numbers are clamped, text is cleaned of control characters and `|` (so no WoW escape code such as `|c`, `|H` or `|T` survives), and bad input is dropped with a plain reason instead of throwing. Backlog item 67 (channel to the addon, below) is built; items 72 (the mentor writes guides) and 74 (starter guide) build on these field names.

A guide file is one guide as JSON, or a JSON list of guides.

## Guide

| Field | Type | Required | Limits | Meaning |
|---|---|---|---|---|
| `id` | string | yes | `^[A-Za-z0-9_.-]{1,32}$` | Stable name. A later guide with the same `id` replaces the earlier one. |
| `steps` | array of step | yes | 1 to 600 kept (extra steps are cut, with a reason) | The ordered list. |
| `title` | string | no | 80 chars, defaults to `id` | Name shown to the player. |
| `minLevel`, `maxLevel` | integer | no | 1 to 70, rounded; swapped if reversed | Levels the guide is meant for. |
| `faction` | string | no | `Alliance` or `Horde` (any case) | Whole guide is for one faction. |
| `source` | string | no | 120 chars | Where the facts came from (the player's data folder, a cited page, "written by us"). |

At most 12 guides are kept in a set. When more arrive, the newest (last) 12 stay.

## Step

| Field | Type | Required | Limits | Meaning |
|---|---|---|---|---|
| `kind` | string | yes | `accept`, `do`, `turnin`, `travel`, `train`, `buy`, `note` | What the player is asked to do. |
| `text` | string | yes | 200 chars, non-empty after cleaning | The instruction. Plain text only. |
| `quest` | string | no | 80 chars | Quest name the step is about. |
| `questId` | integer | no | positive, at most 2147483647 | Quest id, for ticking the step off from the player's quest log (item 70). |
| `points` | array of point | no | at most 8 per step; invalid points are dropped | Where on the map. |
| `level` | `{ min, max }` | no | each 1 to 70, one bound alone is fine | Show the step only in this level range. |
| `class` | array of string | no | at most 12 names, 24 chars each, letters, spaces, `'` and `-` | Show the step only to these classes (for example `["Mage","Druid"]`). |
| `race` | array of string | no | same as `class` | Show the step only to these races. |
| `faction` | string | no | `Alliance` or `Horde` | Show the step only to one faction. |
| `optional` | boolean | no | only `true` is kept | The player may skip it. |
| `sticky` | boolean | no | only `true` is kept | Stays shown until done, even when later steps come up. |
| `completewith` | integer | no | position of a later step | Closes this step when that step is reached. |
| `requires` | array of integer | no | at most 12 quest ids, positive, no repeats | Show the step only once every listed quest is turned in (prerequisites). A quest chain is `requires` with the previous quest of the chain. |
| `exclusive` | array of integer | no | same as `requires` | Close the step once any listed quest is turned in (quests that rule each other out). |
| `rep` | `{ faction, standing }` | no | `faction` a faction id 1 to 99999; `standing` 1 (Hated) to 8 (Exalted), or the name (`"Friendly"`), clamped | Show the step only at this reputation or better. An invalid `rep` is dropped with a reason. |
| `profession` | `{ name, skill }` | no | `name` as `class` (24 chars, letters); `skill` 1 to 450, 1 when not given | Show the step only with this profession at this rank or higher. An invalid `profession` is dropped with a reason. |

`completewith` is the 1-based position of a **later** step in the `steps` list as written. A value that is not later, is past the end, or points at a step that was dropped as invalid is removed (with a reason). After cleaning, the stored value is the target's position in the cleaned list.

Filters (`level`, `class`, `race`, `faction`) and availability rules (`requires`, `exclusive`, `rep`, `profession`) say who sees a step; a step without them is for everyone. Matching is the job of the panel (items 69 and 76), not of this module.

## Point

| Field | Type | Required | Limits | Meaning |
|---|---|---|---|---|
| `m` | integer | yes | 1 to 99999 | `uiMapID`. |
| `x`, `y` | number | yes | finite, clamped to 0 to 100, rounded to 2 decimals | Position in map percent, as in `docs/MAP.md`. |
| `radius` | number | no | clamped to 0.5 to 25, 2 decimals | Size of the area, in map percent, when the place is an area. |
| `label` | string | no | 60 chars | Short name for the pin. |

## Example

```json
{
  "id": "demo-start",
  "title": "Demo starter route",
  "minLevel": 1,
  "maxLevel": 3,
  "faction": "Alliance",
  "source": "Invented test guide, not a real route",
  "steps": [
    { "kind": "accept", "text": "Talk to the sample officer by the camp fire.", "quest": "Sample Task One", "questId": 90001,
      "points": [{ "m": 9990, "x": 45.5, "y": 60.25, "label": "Camp fire" }] },
    { "kind": "do", "text": "Defeat five practice dummies near the camp.", "quest": "Sample Task One", "questId": 90001,
      "points": [{ "m": 9990, "x": 47, "y": 62, "radius": 5 }], "sticky": true },
    { "kind": "turnin", "text": "Report back to the sample officer.", "quest": "Sample Task One", "questId": 90001 }
  ]
}
```

A larger one is in `tests/fixtures/guides/valid.json`. The shipped starter guide, written by us for Deathknell (Undead, levels 1 to 5), is `guides/starter-deathknell.json`; `tests/starter_guide_test.js` checks it.

## Using the module

```js
const { parseGuideText, validateGuide, validateGuideSet, GUIDE_LIMITS } = require('./bridge/guide');
const { guides, why } = parseGuideText(fileText); // guides: sanitised copies; why: plain reasons
```

- `validateGuide(raw, why?)` returns one sanitised guide or `null`.
- `validateGuideSet(list, why?)` returns `{ guides, why }` with at most 12 guides.
- `parseGuideText(text)` reads a JSON file (one guide or a list) and returns the same.

None of them throws, and none passes unknown fields, `__proto__` keys, escape codes or control characters through.

## Content rules

- Guide text is written by us or by the mentor from the player's own data folder (`docs/MAP.md`, "Where the data comes from"). Nothing is copied from RestedXP, Questie or any other paid or licensed guide.
- Steps are things the player does by hand, never macros, scripts or `/run` lines. Cleaning does not make a macro safe; the mentor's rules (item 72) keep them out.
- Every guide the mentor writes has a `source` (hard rule 13 in `mentor/AGENTS.md`), and a step that is approximate or single-source says so in its `text`. The validator keeps `source` as written; it cannot judge whether it is true.

## Channel to the addon

Same route as map layers (`docs/MAP.md`); nothing new is invented.

1. **The agent hands over a guide** in either of two ways, whatever the agent. The bridge sets `WOW_AI_GUIDE_FILE` in the environment of every run (a file under `bridge/guidejobs/`, one per job, deleted when the run ends); the agent writes one guide, or a JSON list of guides, to it. Or the agent ends its reply with a fenced block whose language tag is `wowguide`, holding one guide or a list. The system prompt that goes with the game context explains both ways, and says that every step is something the player does by hand.
2. **The bridge validates when the run ends.** The file and the blocks go through `validateGuideSet` above; a block is taken out of the text the player reads, valid or not. A guide that does not validate is dropped and never stored (the reason goes to `bridge.log`). The reply gets one plain line: `I saved the guide "<title>".`, `I saved N guides.` or `I could not save that guide.`
3. **The bridge keeps them in `state.json`** under `guides` as `{ epoch, version, guides }`. A guide with an `id` already held replaces it. At most 12 guides and 1500 steps in all are kept, the oldest dropped first (`GUIDE_STATE_STEPS` in `bridge/guide.js`); this keeps the slot files small. The version goes up only when something changed.
4. **The slot files carry the whole set** as `guides = { epoch, version, list }` for three minutes after a change (on progress publishes only while it is small), and again after every hello, exactly as the map does. The field names inside each guide and step are the ones in this document. The addon replaces its copy when the version is newer or the epoch is another (the bridge's state was reset), so a guide is never applied twice and a client that lost its saved data gets its guides back on its next hello.
5. **The addon only stores them.** `addon/WoWAI/Guide.lua` keeps the set in the `WoWAIGuideDB` saved variable and offers `WoWAIGuide.List()`, `Find(id)` and `Version()` for the guide panel (item 69). It shows nothing, prints nothing, reads no game state and calls no game action. The guide panel below reads from it. The panel ticks steps off from the quest log (item 70); there is no map point yet (item 71).

To remove a guide, send a guide with the same `id`; there is no clear command yet.

## Guide panel

`addon/WoWAI/Forever_Guide.lua` (backlog 69) is a small window with the current step of one guide and the next two. It only shows text: every step is still something you do by hand.

- **Previous / Next** move one step.
- **Progress from your quest log (item 70).** A step with a `questId` ticks itself off when your own quest log shows it done, and the panel moves on to the next step that is not done:

  | Step kind | Done when |
  |---|---|
  | `accept` | The quest is in your log, or already turned in. |
  | `do` | The quest is complete in your log (every objective finished), or already turned in. |
  | `turnin` | The game flags the quest completed, or you just turned it in. |

  Other kinds, and steps without a `questId`, are ticked by hand. A step with a `level` filter shows once you reach that level; reaching it does not tick it, because the step still asks you to do something (visit your trainer, take the road). Done steps show `(done)`.
- **Tick / Untick** marks the current step done or not done by hand, and ticking moves on. Your choice wins over the quest log until that quest's state changes (accepted, objectives complete, turned in, abandoned); then the log decides again. Previous onto a done step stays there.
- The panel reads the log when a quest is accepted, turned in, removed or updated and when you level up, then once more a second later, because objective data can arrive after the event. It never polls, and it only reads: it never accepts, turns in, abandons, picks a gossip option, targets or moves anything.
- **Why?** next to each step puts "Why this step, and what do I need?" with that step and its quest name in the WoW AI question box and opens the chat window (item 75), like the **[explain this quest]** link. Nothing is sent: you read it, change it if you like, and press Enter. The button does nothing in a fight (the panel is hidden then anyway).
- **Pick guide** (or **Next guide (N)** when there are several) switches to the next stored guide; each guide remembers its own step. A new set opens on the newest guide until you pick one.
- The **X** hides the window.
- **The guide fits your log (item 76).** When the panel loads and after every quest event it skips steps that are done and steps you cannot take. Next passes over done steps, and the two rows under the current step show the next steps that are not done. A step you cannot take is left out until that changes:

  | Rule | The step is left out while |
  |---|---|
  | `level`, `class`, `race`, `faction` | Your character does not fit. |
  | `requires` | A listed quest is not turned in. |
  | `exclusive` | A listed quest is turned in. |
  | `rep` | Your standing with that faction is lower (`GetFactionInfoByID`, or `C_Reputation.GetFactionDataByID` where the client has it). |
  | `profession` | Your rank is lower, or you do not have it (`GetProfessions` / `GetProfessionInfo`, else the skill lines `GetSkillLineInfo`). |

  The rules apply only while the step's own quest is neither in your log nor turned in. **Unknown never hides a step:** a missing API, a call that fails, an answer that is not a plain yes or no, a faction the client does not know or a collapsed skill header all count as "can take it". A step that becomes available behind the current one is not pulled back; Previous reaches it.
- **XP pace (item 76).** Under the steps one line says `About N min to level, from your last M minutes`, from the game's own `UnitXP` and `UnitXPMax`, read on `PLAYER_XP_UPDATE`. It shows once there are five minutes of readings from the last ten and some XP was gained in them, and counts XP across a level up. It hides with the panel in a fight.
- **Time per level (item 76).** The addon counts the minutes you play at each level (between XP, level-up and logout events, so also on `/reload`) and when you reached it, per character, in `WoWAIGuideDB.levels["Name-Realm"][level] = { at, sec }`. A session recap (`/ai recap`, item 40) carries `levelMinutes=24:38,25:12`: minutes at each of the last five levels the addon saw you reach, the last one still counting. A level reached before this version is not listed.
- Text is shown as plain text: a `|` in it shows as `|`, never as a game escape code. Text is shown as plain text: a `|` in it shows as `|`, never as a game escape code.
- **In combat, during an encounter or a challenge run the window hides**, and it comes back when the fight ends, like the chat window (item 31). Guide commands typed mid-fight only print "The guide shows when the fight ends."
- The window can be dragged. Its position, whether it is open, the chosen guide and the step in each guide are kept in `WoWAIGuideDB.panel`.

| Command | What it does |
|---|---|
| `/wow-ai guide` | Show or hide the panel. |
| `/wow-ai guide show` / `hide` | Show or hide it. |
| `/wow-ai guide next` / `prev` | Next or previous step (`back` and `previous` work too). |
| `/wow-ai guide tick` | Tick or untick the current step, like the **Tick** button. |
| `/wow-ai guide list` | Print the stored guides with their number and id. |
| `/wow-ai guide pick <n or id>` | Switch to that guide. |

Anything else after `guide` (`/ai guide me to Goldshire`) is a message for the agent, as with the other command words. `/ai` works the same as `/wow-ai`.
