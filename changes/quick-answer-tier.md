### Changed

- **Quick answer tier for short questions.** The starter card can switch a chat to each agent's quick answer tier (Claude: the same cheap default as fight reviews). Set `agents.<id>.quickModel` in `bridge/config.json` to use another model on that agent's list.

- **Stalled runs offer another installed agent.** When a run goes quiet or runs long, the status line's "Ask … instead" button picks another agent on the bridge PC, not only Claude.
