### Security

- **The game can no longer widen an agent's permissions.** A clicked Allow in game used to add tool rules to `bridge/config.json` from a record with no authentication. Now only `config.json` on the PC grants a rule: the old `allow=` field is ignored, and the button is **How to allow**, which explains the edit. A chat outside the mentor workspace runs with read-only tools, and a broad folder or one outside `allowedFolders` is refused.
