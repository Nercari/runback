# Installing on macOS

The addon is the same; only the bridge's screen capture differs. On macOS the bridge runs `bridge/capture_mac.py` (python3 + the built-in `screencapture` and `osascript`, no packages to install) instead of `capture.ps1` or `capture_x11.py`.

**Status: unverified.** No macOS machine has run this in game yet. The decoder is tested (`npm test` decodes the addon's real strip through it), but window discovery, the screen-recording permission and the Retina scaling are untested. Treat it as a first run, and report what `--probe` prints. Windows and Linux are unchanged.

## Requirements

- The game running natively on macOS, **windowed or borderless** (exclusive fullscreen blocks screen capture).
- python3. macOS ships it with the Command Line Tools; if `python3 --version` fails, run `xcode-select --install`.
- Node.js 22.2+, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).
- Two permissions for the app that runs the bridge (Terminal, iTerm, VS Code...), in **System Settings → Privacy & Security**:
  - **Screen Recording**: `screencapture` reads the strip.
  - **Accessibility**: `osascript` asks System Events where the game window is.

  The first run prompts for both. If a strip never decodes, check them again: a denied permission gives an empty capture, not an error.

## Install

```bash
git clone https://github.com/Nercari/runback
cd runback
npm ci                      # only needed to run the tests
node setup.js --wow "/Applications/World of Warcraft/_forever_" --project ~/path/to/the/project
```

`setup.js` looks for the client in Windows and Wine folders only, so pass `--wow` with the `_forever_` folder next to `World of Warcraft.app`. Then fully restart the game, enable *Runback* on the AddOns screen, and start the bridge with `npm start`.

## Check the capture before you play

With the game windowed and the colored strip in its top-left corner:

```bash
python3 bridge/capture_mac.py --probe bridge/probe.png
```

It saves what the capture sees to `bridge/probe.png` and prints one JSON line: `"strip"` is the decoded message (or the reason it failed) and `"offset"` is where the strip was found. An empty or black image means the Screen Recording permission is off. A `no game window found` means the process name did not match: the default is `World of Warcraft`, and `capture.macProcessName` in `bridge/config.json` changes it.

`npm run doctor` prints `PASS x11: macOS captures with screencapture, not X11`.
