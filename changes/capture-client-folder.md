### Fixed

- **The bridge reads the Forever window, not retail's.** The Forever release client and retail both run `Wow.exe`. On Windows the capture now only attaches to a game started from the client folder in `config.json` (`_forever_`), so with retail open too it no longer reads the wrong window. Ported from the original project (chelinho139/wow-ai 489ecae).
