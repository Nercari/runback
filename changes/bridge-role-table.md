### Changed

- **Role table on the slot file.** The bridge maps Chat, Quick answer, Coach note, Deep review and Translate to each agent's models, with `cannotRun` reasons for agents that cannot run mentor jobs and `roleBlocked` rows where a role cannot run (for example Translate on agents with no tool-free mode). Override per agent with `agents.<id>.roles` in `bridge/config.json`.
