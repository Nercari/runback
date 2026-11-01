### Changed

- **`npm run doctor` fails on a Wayland session.** It used to pass the X11 check whenever `DISPLAY` was set, which under Wayland means XWayland: a session that is not proven to hand back another window's pixels. It now fails with the fix and names the new [No X11 session yet](../docs/INSTALL-LINUX.md#no-x11-session-yet) steps, which add an X11 session next to Hyprland without touching it. `npm run probe` prints the session type on its line, so the probe output and `echo $XDG_SESSION_TYPE` are one piece of evidence.
