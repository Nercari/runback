### Fixed

- **A pull no longer raises a Lua error when the game hides your health.** Forever can return your health as a secret value at a fight start; the addon now reads it only when it is not secret, and a health read that fails gives no start health instead of an error. The fight line, the low start count and the recap are unchanged when health is a plain number. `tests/forever/addon_low_health.test.js` covers it.
