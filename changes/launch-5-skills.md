### Fixed

- **Professions in the game context and the guide on Forever (#135).** Both read the skill lines through `C_SkillInfo` only: the client has one table per line under `C_SkillInfo.GetSkillLineInfo` and no `GetNumSkillLines`/`GetSkillLineInfo` globals at build 70532. The context line is now `Skills:`, so a guide profession step and the agent see the same ranks.
