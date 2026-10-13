# WOW-09 / WOW-11 offline dry run, 2026-09-25

Synthetic fixture `tests/fixtures/dryrun/Logs/WoWCombatLog-092526_195800.txt` (Brakka-Testrealm, Warrior 18, vs Defias Pillager; not a real Forever log: WOW-02 has not run).
Each reply is one real `codex exec` run through `runAgentOnce` with the mentor guard, in a copy of `mentor/`.
The guard was verified live: `--dangerously-bypass-approvals-and-sandbox` removed, `-s workspace-write -C <mentor>` added, `-` kept last.
Citations checked with `tools/check-citations.js`; web sources re-fetched by Claude.

| Run | Covers | Verdict |
|---|---|---|
| review | F01, F05, F06, F15 / AC5, AC12, AC13 | PASS: checker verified 2 log lines + notebook scorecard; tamper test (80→60 damage) fails with exit 1. Claimed no missed interrupt because basic logging cannot show Rage (omission rule). Trend sentence present. Cited Shield Bash 12 s cooldown from wow-forever.gg (fetched and confirmed by Claude). Missed the 23.2→30.6 s swing gap. |
| death | F02 / AC9 | PASS: killing blow (Fireball 9053, 80 dmg, 21 overkill) and every incoming hit in the 15 s window quoted; checker verified 5 lines against the .death.txt. |
| brief | F07 / AC14 | PASS: 4 bullets (≤10), each cited, dps role, "may differ in Forever" label. |
| build | F10 / AC7 | PARTIAL: talents exist in the Forever calculator (Improved Tactical Mastery, Spearing Strike confirmed by Claude), but the point count is off by one (says 8 at level 18, lists 5+3; Classic gives 9). AGENTS.md now requires counting points first. |
| drill | F06 / AC13 | PASS: "good" grade moved the drill from 1 to 3 days, next due 2026-09-28, notebook updated. |
| quest | F16 / AC21 (text) | PASS: spoiler-free, asks for the objective because the title is shared by several steps; cited. |
| level | F14 / AC19 | PARTIAL: XP/hour math correct (4,600 XP at 9,100/h ≈ 30 min) and a cited route with ranges matching forever-codex.com build 1.60.1.70009, but `/played` was not reported. AGENTS.md now requires it. |

Not covered offline: F11 gear (needs a real gear snapshot), F13 AH (needs `bulk/ah.json` from a scan), F18 translator drafts, F20 council synthesis (bridge tests cover the mechanics).

## review

Reply (done):

```
Fight: Defias Pillager (20:00:10–20:00:42), died.

You interrupted the first Fireball:
9/25/2026 20:00:11.900  SPELL_INTERRUPT,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,72,"Shield Bash",0x1,9053,"Fireball",4

Five later Fireballs hit; the last dealt 80 and killed you:
9/25/2026 20:00:42.500  SPELL_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,9053,"Fireball",0x4,80,21,4,0,0,0,nil,nil,nil,nil

Since last review: the first interrupt improved. I can’t confirm a missed second interrupt: Shield Bash has a 12-second cooldown, but this log lacks your Rage and equipment state. No positional data either. Source, fetched today: https://wow-forever.gg/classes/warrior/protection/

Drill: On your next caster pull, check that you have a shield and enough Rage, then interrupt the next cast when Shield Bash is ready. Deaths remain 1 across the last two reviews.

TL;DR:
You stopped the first Fireball; later ones killed you. Practice checking shield and Rage before the next interrupt.
```

## death

Prompt:

```
[runback cmd=death]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
deaths=2026-09-25T20:00:42@Westfall
lastFight=start=2026-09-25T20:00:10,end=2026-09-25T20:00:42,ok=0
[End of context]

why did I die?
```

Reply (done, 81 s):

```
The Defias Pillager killed you with Fireball (spell 9053) at 20:00:42.5: 80 damage, 21 overkill. Its damage in the final 15 seconds was:

9/25/2026 20:00:30.400  SPELL_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,9053,"Fireball",0x4,78,0,4,0,0,0,nil,nil,nil,nil
9/25/2026 20:00:34.200  SPELL_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,9053,"Fireball",0x4,74,0,4,0,0,0,nil,nil,nil,nil
9/25/2026 20:00:35.300  SWING_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,12,0,1,0,0,0,nil,nil,nil,nil
9/25/2026 20:00:39.100  SPELL_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,9053,"Fireball",0x4,76,0,4,0,0,0,nil,nil,nil,nil
9/25/2026 20:00:42.500  SPELL_DAMAGE,Creature-0-4395-0-12-589-00001A2B3C,"Defias Pillager",0xa48,0x0,Player-4395-0ABC1234,"Brakka-Testrealm",0x511,0x0,9053,"Fireball",0x4,80,21,4,0,0,0,nil,nil,nil,nil

You interrupted the first Fireball. The log doesn’t show whether Shield Bash was available for the later ones, so I can’t call them missed interrupts. Next time, after two Fireballs land, retreat instead of continuing to trade hits.

TL;DR:
Repeated Fireballs killed you; the last hit for 80. Practice retreating after two land.
```

## brief

Prompt:

```
[runback cmd=brief The Deadmines]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
role=dps
[End of context]

brief me on The Deadmines, I am going as dps
```

Reply (done, 125 s):

```
Deadmines DPS brief (Classic-era guidance; may differ in Forever):

- At level 18, expect the final bosses to be harder. A Classic guide recommends a group mostly above 19 for the full clear. [Guide](https://www.icy-veins.com/wow-classic/deadmines-dungeon-guide)
- Let the tank pull, watch for patrols, and focus enemies that run away at low health; they can bring back more enemies. [Guide](https://www.icy-veins.com/wow-classic/deadmines-dungeon-guide)
- On Mr. Smite, help kill his two adds first. He stuns the group while changing weapons, so avoid drawing threat when damage resumes. [Guide](https://www.icy-veins.com/wow-classic/deadmines-dungeon-guide)
- On Captain Greenskin and VanCleef, follow the group’s add target. Both start with guards in the Classic guide. [Guide](https://www.icy-veins.com/wow-classic/deadmines-dungeon-guide)

TL;DR:
Follow the tank’s target and watch for fleeing enemies. At 18, take extra care on the final bosses.
```

## build

Prompt:

```
[runback cmd=build]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
talents=none spent
professions=Mining 60, Blacksmithing 55
[End of context]

what talents should I take while leveling solo?
```

Reply (done, 99 s):

```
For solo leveling, take Arms. You have 8 points at level 18 and none spent, so take these in order:

Arms / row 1 / Deflection / 5 points (levels 10–14)
Arms / row 2 / Improved Tactical Mastery / 3 points now (levels 15–18)

Next: finish Improved Tactical Mastery 5/5 at 19, take Anger Management at 20, Improved Overpower 2/2 at 21–22, Improved Charge 2/2 at 23–24, and Spearing Strike at 25. This builds toward steadier Rage and a two handed attack. The [Forever beta warrior calculator](https://classicwow.gg/forever/tools/talent-calculator/warrior) was checked September 25; beta talents may change.

TL;DR:
Spend your 8 points on Arms: Deflection 5/5, then Improved Tactical Mastery 3/5.
```

## drill

Prompt:

```
[runback cmd=drill]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
[End of context]

drill done, good
```

Reply (done, 51 s):

```
Marked your drill good and moved it to the 3-day interval. It’s next due September 28.

TL;DR:
Drill recorded as good. Practice it again September 28.
```

## quest

Prompt:

```
[runback cmd=quest]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
questDetail=The Defias Brotherhood
[End of context]

explain this quest without spoilers
```

Reply (done, 39 s):

```
“The Defias Brotherhood” is an investigation that starts with Gryan Stoutmantle at Sentinel Hill. In Classic, several steps share this exact title, so I can’t tell which destination is next from the title alone. Check the objective in your quest log; if you paste it, I’ll give you the exact route without story spoilers. Classic directions may differ in Forever. [Quest chain reference](https://warcraft.wiki.gg/wiki/Defias_Brotherhood_quest_chain)

TL;DR:
Check the quest objective and send it to me for the exact next stop.
```

## level

Prompt:

```
[runback cmd=level]
[Context from the Runback bridge, not written by the user]
character=Brakka-Testrealm class=Warrior level=18 zone=Westfall
logging=true
advLogging=false
xp=4200/8800 lvl 18, xph=9100
played=86400,7200
[End of context]

plan my leveling for the next few levels
```

Reply (done, 148 s):

```
Brakka, from 18 to about 22:

1. Finish any yellow Westfall quests near Sentinel Hill, then move on. Westfall’s current area range ends at 18.
2. Quest from Lakeshire in Redridge (15–25). Pick up the nearby quests and check enemy levels before each pull.
3. If you want a group, Deadmines is an option now (17–26).
4. Around 20–21, try the lower-level quests in Duskwood (19–30). If they’re too hard, stay in Redridge or try Wetlands (20–30).

At your current 9,100 XP/hour, the 4,600 XP left to level 19 is about 30 minutes. Later levels may take longer. I don’t have your quest list, so the exact quest order depends on what you’ve already completed.

Source: Forever Codex beta data, build 1.60.1.70009, checked Sep 25: https://forever-codex.com/zones/ and https://forever-codex.com/dungeons/

TL;DR:
Finish Westfall, quest in Redridge, then try Duskwood around 20–21. About 30 minutes to level 19 at your current pace.
```

