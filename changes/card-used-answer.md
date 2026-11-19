### Added

- **The coach card asks "Used the last note? Yes / No" (unit 1 of #165, #143).** The next note first asks whether you used the last one, out of combat only, then shows the new note. The card keeps one row per fight (the last 60) in the game's saved data, and `node tools/card-report.js --saved <Runback.lua>` now reads your Yes and No answers instead of the **Got it** count. `/ai card` prints them. The in-game look is still yours.

### Fixed

- **"Why?" no longer adds to the card count on every click.** It counts once per note.
