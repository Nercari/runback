### Added

- **macOS capture (issue 145).** On macOS the bridge now runs `bridge/capture_mac.py` (python3 + the built-in `screencapture` and `osascript`, no packages) to read the pixel strip, instead of failing on the X11 capture. `setup.js` accepts a client folder with `World of Warcraft.app`, `npm run doctor` passes the session check on macOS, and `capture.macProcessName` names the process to look for. Windows and Linux capture are unchanged. Unverified in game until a Mac run passes: [docs/INSTALL-MACOS.md](../docs/INSTALL-MACOS.md).
