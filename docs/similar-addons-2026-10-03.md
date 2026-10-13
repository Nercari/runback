# Ideas from similar addons (2026-10-03)

Pedro asked for addons similar to runback and for complementary ideas to borrow. Only ideas that stay out of combat, play nothing for the player and use the Forever client's APIs or the combat log file are kept. No code was copied; only ideas.

Sources: the CurseForge pages of WOWGPT, CombatAnalyzer, Localog and Mythic Raider Tools were opened. Details!, WoWAnalyzer, Wipefest, Warcraft Logs, Elitist Group, Questie, RestedXP and Zygor come from search results and general knowledge, not an opened page. None was checked on the Forever client.

| Idea | Seen in | runback today | Decision |
|---|---|---|---|
| Death recap: damage taken by source and spell, killing blow | Details!, Blizzard Death Recap, CombatAnalyzer, Mythic Raider Tools | `/ai death` slices the 15 s before the death; the mentor reads raw lines | Built: recap lines at the top of `.death.txt` |
| Health before each hit, overkill at death | Mythic Raider Tools | not shown | Backlog: needs a real Forever log with advanced logging (WOW-02) |
| Per-class checklist (uptime, cooldowns, idle time) | WoWAnalyzer | only `mentor/rubrics/_generic.md` | Backlog: warlock first, every rule cited |
| Practice on a target dummy, before and after | Localog | drills and scorecard exist, no comparison | Backlog |
| Avoidable damage counted across fights | Elitist Group, Wipefest | notebook tracks recurring mistakes by hand | Backlog, after the class rubric |
| Death file lists only damage done to the player | (bug found while building the recap) | outgoing hits by the player also land in `.death.txt` | Backlog: small fix |
| Personas per chat | WOWGPT | each chat already has its own agent, folder and name | Skip |
| Leveling route and goals | RestedXP, Zygor, Questie | `/ai level` plus map routes and the navigator | Skip |
| Rankings against other players | Warcraft Logs | none | Skip: needs uploading logs to a third party |
