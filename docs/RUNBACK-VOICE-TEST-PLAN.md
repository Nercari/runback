# Test plan for dictated questions

Proposed behavior for Runback 0.4.0, based on the forever branch at `0505f7109797e13269d0acec5f683003249654f7`. The proposed tests below have not run.

## What the existing path proves

The Windows helper in `tools/ptt/ptt.ps1` starts recording on one hotkey press and stops on another. The user edits the transcript and clicks Send. The helper writes a JSON record containing text, time and recognition confidence.

The bridge in `bridge/forever/modules/70-ptt.js` checks the kill switch, strip age, transcript and last active chat before submitting. A recently seen strip shows activity. It does not identify the character that supplied the question's context. The helper's record has no character or snapshot identifier.

Typed questions use the slash command in `addon/Runback/Runback.lua`. The addon collects context in `addon/Runback/Forever_Context.lua`. Optional spoken replies use `addon/Runback/Forever_Speech.lua`. Speech defaults to off.

## Offline acceptance cases

Use synthetic characters, a fake clock, and a bridge that records submissions. Count submissions, attached snapshots, displayed replies, and speech calls.

| Case | Expected result |
|---|---|
| Hold the dictate control, speak, and release once outside combat. Repeat a keydown and deliver the same release twice. | Zero submissions while held. One question from the complete transcript on release. Repeat events add zero submissions. |
| Cancel the recording or release with no recognized words. | Zero submissions. The next recording begins with empty text. |
| Dictate as character A with a fresh snapshot for A. | One question carries A's snapshot. The fixture identifies its source and capture time. |
| Proposed offline comparison (not run). Use the same synthetic Horde character, spoken request for the nearest skinning trainer, Mulgore map, trainer list, and snapshot freshness. Change only the character's position in the snapshot. Both coordinate pairs are synthetic player positions. | Near `(44.6, 75.8)`, expect [Nawka Wildsong (267330)](https://foreverbase.org/en/db/npc/267330/). Near `(45.0, 62.4)`, expect [Yonn Deepcut (6290)](https://foreverbase.org/en/db/npc/6290/). See also the [Yonn Deepcut wiki entry](https://warcraftforever.wiki/wiki/Yonn_Deepcut). |
| Supply an expired snapshot, no snapshot, or a fresh snapshot for B. Switch characters between press and release in a separate case. | No question goes out with unverified context. A recent strip or a previous chat cannot substitute for a matching snapshot. |
| Enter combat or an encounter between press and release. Repeat with the kill switch set, then with a stale strip. | Zero submissions. Combat also prevents reply display and speech while the lockout holds. |
| Run the same reply with speech off and on outside combat. | The text remains available in both cases. Only opt-in speech plays a reply. |
| Send the same text through typed `/ai` with dictation disabled. Exercise the existing edit, Send and Cancel controls. | Existing controls retain their behavior. No synthetic keypress, click, window focus or gameplay action occurs. |

Before implementation, identify an existing permitted addon export that binds the snapshot to the character at release. Specify its freshness limit and test both sides of that limit. Follow `docs/COMPLIANCE.md`. Stop if the binding or a permitted release signal cannot be demonstrated offline.

## Existing regression check

From the pinned repository root, run:

```sh
node --test tests/forever/p7_ptt.test.js
```

The pinned check passed both tests. The first checks one file submission and removal. The second checks stale-strip and kill-switch refusal. Hold and release, character identity, microphone behavior, and live game operation remain unverified.
