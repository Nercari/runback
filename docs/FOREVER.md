# Forever extension hooks

The mentor's deterministic theorycraft calculator is `tools/theorycraft.js`; scenarios live in its mentor theorycraft folder and report coefficient provenance.

Bridge modules live in `bridge/forever/modules/*.js`, load by filename, and can be disabled by basename in `forever.disabled`. Throwing hooks are logged and skipped. `intercept(job, ctx)` runs after dedup for ordinary jobs; a truthy result owns the job and must eventually call `ctx.finish`. `augment(job, runInfo, ctx)` is synchronous and may edit `args`, `input.stdin`, or `env`. `onRun` runs after spawn; `onFinish` runs from finish; `stop` runs on process exit.

Bridge `ctx` exposes `cfg`, `log`, `HERE`, `REPO`, `state`, `saveState`, `atomicWrite`, `submit(job)`, `finish(job,status,text)`, `publish(key,record,urgent)`, `chatKey(job)`, and `runAgentOnce({agentId,cwd,prompt,timeoutMs})`, which resolves to `{status,text}` without changing a chat transcript or session.

`06-review-wait.js` holds a review (`cmd=review`) while the newest combat log ends more than 3 seconds before `lastFight.end`: it sends one plain line to the window ("Waiting for the game to save the fight to the combat log..."), checks every 2 seconds, and lets the review start when the file catches up or after 2 minutes (then says it starts anyway). It only reads the log. Settings: `forever.combatLogDir`, `forever.reviewWait` (`docs/CONFIGURATION.md`).

```js
module.exports = {
  init(ctx) { ctx.log('sample ready'); },
  intercept(job, ctx) { if (job.cmd !== 'sample') return false; ctx.finish(job, 'done', 'handled'); return true; },
  augment(job, runInfo) { if (job.cmd === 'sample') runInfo.args.push('--sample'); },
  onRun(info) { /* observe spawn */ },
  onFinish(job, status, text) { /* observe result */ },
  stop() { /* release resources */ },
};
```

Addon modules call `WoWAIForever.Register(mod)` from a file loaded after `Forever.lua`. Every field is optional: `name`, `commands[word](rest,chat)`, `blocked()` (reason to refuse sends), `context(kind)` (extra context), `onReply(chat,rec)`, `events` plus `onEvent(event,...)`, and `init()`. Errors are isolated with `pcall`. A blocked reason is also shown in chat history; the strip is hidden until unblocked.

Modules can exchange small internal notifications with `WoWAIForever.On(name, fn)` and `WoWAIForever.Fire(name, ...)`. Listener failures are isolated with `pcall`. Chat records can be inspected via the read-only accessor `WoWAIForever.GetChats()`.

```lua
WoWAIForever.Register({
  name = "sample",
  commands = { sample = function(rest, chat) print(rest) end },
  blocked = function() return nil end,
  context = function() return "Sample context" end,
  onReply = function(chat, rec) end,
  events = { PLAYER_ENTERING_WORLD = true },
  onEvent = function(event) end,
  init = function() end,
})
```

## Look and hotkeys

The optional Forever skin uses WoW's classic dialog and tooltip art. The saved
`WoWAIForeverDB.skin.enabled`, `sounds`, and `minimap` settings default to true;
`minimapAngle` stores the button position. `/ai skin on|off` changes the skin
setting and asks for a reload to apply it. `/ai minimap on|off` controls the
minimap button.

Hotkeys live in the game's own menu: Options > Keybindings > AddOns > WoW AI
(from `Bindings.xml`). The addon never binds keys itself. On first login it
prints the suggested keys and says which are free: Ctrl+Shift+A (window),
Ctrl+Shift+M (mentor), Ctrl+Shift+R (review), Ctrl+Shift+D (death),
Ctrl+Shift+L (screen question), Ctrl+Shift+X (AI switch); focus and send have no
suggestion. `/ai keys` lists the current bindings and repeats the suggestion.
The screen question fills the box with `/ai look `; type a question or press
Enter as is to ask "What's on my screen?" about your newest screenshot (take
one with Print Screen first). `/ai look` typed alone does the same.
Up/Down recall recent messages in the input; Tab and
Shift+Tab switch chats.

## Addon builder

Install the 20 LoadOnDemand user slots with `node tools/install-user-slots.js` before starting the client. Stage an addon as a flat directory of `.toc` and `.lua` files under `<mentorDir>/addon-staging/<Name>/`, then use `/ai try <Name>`. The builder applies the untrusted Lua safety scan, refuses links and non-Lua/XML files, and writes the result into a fresh `WoWAI_Uxx` slot. Click **Load <Name>** in the builder frame; WoW must have discovered the slot at client startup. Each slot is used once until `/ai builder reset` (only use reset after restarting the client). The slot code has no SavedVariables; the addon name vararg is the slot's name.

`/ai promote <Name>` copies a linted addon to the regular AddOns folder for loading after the next full client restart. Names beginning with `WoWAI` are reserved, and existing folders are protected unless they carry `.wowai-promoted`. Linting blocks known dynamic code and protected APIs but cannot prove an addon safe: allowed WoW APIs and logic can still misbehave or affect the character within WoW's sandbox.

## Push-to-talk

Run `tools/ptt/ptt.vbs` to start the Windows helper in the background. It defaults to Ctrl+Alt+Space. Install a Windows speech recognizer for `pt-BR` or `en-US`, or pass `-Culture`; `-ListRecognizers` lists available recognizers. Press the hotkey to start dictation and again to stop. Review or edit the transcript in the small overlay, then click Send. The bridge accepts it only when the kill switch is off and the WoW strip was seen in the last ten seconds, then routes it to the most recent chat that sent a normal message. Otherwise it deletes the input and logs why it was dropped. The helper uses RegisterHotKey and never injects keystrokes or interacts with the game window or process.
