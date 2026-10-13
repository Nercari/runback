# WOW-02 Forever probe session

1. Back up nothing. The probe writes only its own SavedVariables and a `WAIPROBE` macro that it deletes after the test.
2. Before starting the client, copy `probe/RunbackProbe` and `probe/RunbackProbe_LOD` into `<Forever>\Interface\AddOns\`.
3. Install unmodified upstream Runback and its bridge using `docs/INSTALL-WINDOWS.md` and the Claude agent. Try both upstream transports (reload and pixel tiers) as documented; note which work.
4. In game, `/reload` twice, then run `/runbackprobe`. Click each button out of combat. Enable Advanced Combat Logging under System > Network > Advanced Combat Logging, then `/combatlog`. Do one open-world fight and one dungeon boss; die once if convenient for F02; open a quest (QUEST_DETAIL) and the Auction House if nearby. Click “Show test strip” and take “Screenshot now” while the strip is visible.
5. Run `/reload` once to write SavedVariables.
6. On Windows, replace placeholders and run:

   ```powershell
   node probe/check-log.js --log "<Forever>\Logs\WoWCombatLog.txt" --player "Name-Realm" --json > check-log.json
   node probe/check-log.js --log "<Forever>\Logs\WoWCombatLog.txt" --player "Name-Realm" --fixture "probe-fixture.txt" --start "2026-09-25T12:00:00Z" --end "2026-09-25T13:00:00Z" --json > fixture-summary.json
   node probe/gate-table.js --sv "<Forever>\WTF\Account\<ACC>\SavedVariables\RunbackProbe.lua" --log-report check-log.json --out gate-table.md
   ```

   Send `check-log.json`, `fixture-summary.json`, `probe-fixture.txt`, and `gate-table.md` to Claude. The fixture includes only the requested time window, preserves your character name, and consistently anonymizes other players. The original combat log is never edited.

The screenshot strip has two variants at the top-left: 8×8 px cells followed by 2×2 px cells, each with eight color cells. Each cell's RGB is a byte encoding: R=`byte/255`, G=`(255-byte)/255`, B=`0x80/255`; the first four bytes spell `WAIP` (`57 41 49 50` hex). Remaining colors are red, green, blue and white. Screenshots normally land in `<Forever>\Screenshots\` (or the client’s configured screenshot directory).

No addon can be declared ban-proof; this probe uses only the public addon API, user clicks, and files the game writes.

## Result keys

`build`, `interface`, `api_auctionhouse`, `api_encounterjournal`, `api_challengemode`, `api_damagemeter`, `api_speaktext`, `tts_voices`, `api_createmacro`, `api_loggingcombat`, `api_traits`, `api_inventoryitemlink`, `api_questtext`, `api_loadaddon`, `api_screenshot`, `api_copytoclipboard`, `api_partyinfo`, `cvar_screenshotformat`, `cvar_advancedcombatlogging`, `cvar_screenshotquality`, `sv_readback`, `ev_regen`, `ev_encounter`, `ev_challenge`, `ev_questdetail`, `meter_after_combat`, `meter_in_combat`, `questtext_nonempty`, `screenshot_hw`, `screenshot_no_hw`, `png_set`, `strip_shown`, `speak`, `clipboard`, `createmacro`, `loggingcombat_call`, `loadaddon_lod`.

`check-log.js` reports the timestamp sample, event counts, advanced-field estimate and sample lines, player/GUID presence, and encounter records. `gate-table.js` uses the SavedVariables `report` plus optional check-log JSON; F25 remains UNKNOWN until the bridge decoder checks the screenshot bytes. `R3` event gates are based on in-game events and should be interpreted alongside the event counts.
