### Changed

- **Addon renamed to Runback.** The in-game addon folder is `Runback` (`Runback.toc`, saved data `RunbackDB`). Primary slash command `/runback`; `/wowai` stays an alias; `/rb` registers when no other addon took it at load. Legacy `WoWAIDB` copies into `RunbackDB` on first load. `node setup.js` migrates `WoWAI` installs and updates bridge paths.
