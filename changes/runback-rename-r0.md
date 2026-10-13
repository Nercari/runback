### Changed

- **Addon renamed to Runback.** The in-game addon folder is `Runback` (`Runback.toc`, saved data `RunbackDB`, `RunbackMapDB`, `RunbackGuideDB`, `RunbackForeverDB`, `Runback_Bulk`). Primary slash command `/runback`; `/wowai`, `/wow-ai`, `/wow-claude`, `/ai` and `/ask` stay aliases; `/rb` registers when no other addon took it at load. Each new saved variable copies from its `WoWAI*` legacy table once on first load (`migratedFrom = "WoWAI"`). `node setup.js` migrates `WoWAI` installs and updates bridge paths.
