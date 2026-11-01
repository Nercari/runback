### Fixed

- **The AI sees your talent build on Forever again.** The game context has a `Talents:` line with the points spent per tree and the Legacy tree, read through the client's `C_ClassTalents` and `C_Traits` namespaces after the Classic talent tabs were removed in build 70532. It reads outside combat only and never changes a talent. `tests/addon_test.js` covers it; the in-game read still needs Nercari's look.
