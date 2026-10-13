### Changed

- **Addon renamed to Runback.** The in-game addon folder is `Runback` (`Runback.toc` lists `Runback*` and legacy `WoWAI*` saved variables). Primary slash command `/runback`; `/wowai`, `/wow-ai`, `/wow-claude`, `/ai` and `/ask` stay aliases; `/rb` registers when no other addon took it at load. Each `Runback*` table copies from its legacy `WoWAI*` table once on first load (`migratedFrom = "WoWAI"`). Copy `WoWAI.lua` to `Runback.lua` manually (README); `setup.js` does not delete or rewrite `WoWAI` data.
