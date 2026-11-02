### Added

- **A report for the coach card on real fights (launch 13, #143).** The bridge keeps one row per fight the card looked at (counts, check, whether the model or code wrote the note, and the cost when the agent reports it). `node tools/card-report.js` prints the 20-fight table and the verdicts: notes that kept their counted facts, the cost of each note (under $0.01), and your **Got it** count from the game's saved data. It reads files only. The five pulls and 20 fights themselves still need the game.
