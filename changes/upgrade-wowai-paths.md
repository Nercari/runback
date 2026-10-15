### Fixed

- **Chat works after upgrading from WoW AI.** `setup.js` now points `bridge/config.json` at `Runback\Inbox.lua` and `Runback.lua` when it still named the `WoWAI` folder or `WoWAI.lua`, and the bridge reads such a config the same way. Before, the bridge kept writing replies into the moved `WoWAI` folder and reading the old saved file, so the game and the bridge stopped hearing each other. The 200 `WoWAI_S###` reply-slot folders also move into `Runback-backup-YYYY-MM-DD`, so the AddOns list no longer shows them with a missing dependency.
