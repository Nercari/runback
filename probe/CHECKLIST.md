# Launch go/no-go checklist

15 minutes on the live Forever client (issue #141). Run it at launch or on the
pre-install build. Do not send input to the game and do not paste `/run` scripts:
the player clicks every button in the table.

Rows 3, 4, 5, 6 and 11 are one command in the addon: `/runback check`. It prints
one block and opens it selected, so Ctrl+C pastes the block into the issue. The
block gives the build and interface, whether the addon is out of date, the type of
each API the mentor reads, the `C_Secrets` answers (out of combat only) and the
combat-log state. Which client API each line stands for is in
`probe/PROBE.md` and the WOW-02 gate table.

| Min | Step | Pass | No-go action |
|---:|---|---|---|
| 0 | Start the game. Pick the Experience Preset (Enhanced is Blizzard's advice). Run `/console scriptErrors 1`. | Character screen | Note the preset |
| 1 | Find the exe and folder names. | Names match config, or `setup.js` finds them | Set `processName` and path by hand, re-run setup |
| 2 | `npm run doctor`, then log in. | Doctor is clean | Fix the named item |
| 3 | Log in, then `/runback check` (build and interface lines). | Build noted; interface equals the slot tocs | Update the tocs, restart client |
| 4 | `/runback check` (addon line), and the addon list. | Runback is loaded, not out of date | Tick "Load out of date addons", note it |
| 5 | `/runback check` (sound, talents and mouse lines). | Results noted against T3 | Log it; a nil `PlaySoundFile` means no signal channel |
| 6 | `/runback check` (secrets line) out of combat. | Results noted | `true` makes the StartHealth fix mandatory |
| 7 | `npm run probe`, per `probe/PROBE.md` | Gates logged in the Live check log | Log each failure |
| 9 | Send "hello" | Reply in the window | **Reply chain fail: no-go for the strip; use `mode reload`** |
| 10 | `/reload` | Chat restored; SavedVariables read back | Log it; no-go for restore |
| 11 | `/runback check` (combat log line), then turn the log on by click | `Logs/WoWCombatLog*.txt` grows | No-go for review |
| 12 | Pull one mob with the window open | Window folds; no Lua error; no reply text in combat | **Any Lua error or help in combat: no-go. Stop the bridge.** |
| 13 | After the fight: review | Review reads the real file and cites a line | Save the log; no-go for review |
| 14 | Check the capture: Windows, or `echo $XDG_SESSION_TYPE` on Linux | Windows or `x11` | Wayland: use `mode reload` |
| 15 | Write results in the Live check log | Row added | Go if rows 9 and 12 pass. Otherwise no-go for the strip. |

Row 8 does not exist. The source table skips it.

## The verdict

The verdict is **go** only when row 9 and row 12 pass. Any other bold row fails
means no-go. When row 9 fails, `/runback mode reload` takes over. When row 12
fails, stop the bridge.

## Where the result goes

1. One row in the Live check log (`docs/forever-coverage-2026-09-25.md`), with the
   date, `PASS` or `NO-GO`, and what failed.
2. One go or no-go line on issue #141, with the `/runback check` block pasted
   below it.
