# Guide files

A **guide** is a named, ordered list of steps for the player to follow by hand: where to go, which quest to accept, what to do, when to turn in. The format is read-only data. **Every step is something the player does themselves.** No field in it triggers, queues or automates a game action (accepting, turning in, targeting, travelling, buying, training); a guide only says what to do and where. This keeps it inside `docs/COMPLIANCE.md`.

`bridge/guide.js` validates and sanitises guide files the way `bridge/protocol.js` does map layers: unknown fields are dropped, numbers are clamped, text is cleaned of control characters and `|` (so no WoW escape code such as `|c`, `|H` or `|T` survives), and bad input is dropped with a plain reason instead of throwing. Backlog items 67 (channel to the addon), 72 (the mentor writes guides) and 74 (starter guide) build on these field names.

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
| `questId` | integer | no | positive, at most 2147483647 | Quest id, for ticking the step off from the player's quest log (item 68). |
| `points` | array of point | no | at most 8 per step; invalid points are dropped | Where on the map. |
| `level` | `{ min, max }` | no | each 1 to 70, one bound alone is fine | Show the step only in this level range. |
| `class` | array of string | no | at most 12 names, 24 chars each, letters, spaces, `'` and `-` | Show the step only to these classes (for example `["Mage","Druid"]`). |
| `race` | array of string | no | same as `class` | Show the step only to these races. |
| `faction` | string | no | `Alliance` or `Horde` | Show the step only to one faction. |
| `optional` | boolean | no | only `true` is kept | The player may skip it. |
| `sticky` | boolean | no | only `true` is kept | Stays shown until done, even when later steps come up. |
| `completewith` | integer | no | position of a later step | Closes this step when that step is reached. |

`completewith` is the 1-based position of a **later** step in the `steps` list as written. A value that is not later, is past the end, or points at a step that was dropped as invalid is removed (with a reason). After cleaning, the stored value is the target's position in the cleaned list.

Filters (`level`, `class`, `race`, `faction`) say who sees a step; a step without them is for everyone. Matching is the job of the panel (item 69), not of this module.

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
