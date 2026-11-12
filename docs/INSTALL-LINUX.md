# Installing on Linux (Wine)

The addon is the same; only the bridge's screen capture differs. On Linux the bridge runs `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages to install) instead of `capture.ps1`, and writes the slot files straight into the Wine prefix.

## Requirements

- An **X11** session (`echo $XDG_SESSION_TYPE` prints `x11`). Wayland blocks reading other windows' pixels; a Wayland PC can add one, see [No X11 session yet](#no-x11-session-yet).
- The game under Wine (Lutris, Bottles, a hand-made prefix...), **windowed or borderless**.
- Node.js 22.2+, python3, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).

## Quick start

1. `git clone https://github.com/Nercari/runback && cd runback` (or `git pull` in an existing clone).
2. **Log in once** per agent CLI you plan to use: `claude`, `codex`, `grok login`, `agy`, `hermes setup`, or `opencode auth login` — see [AGENTS.md](AGENTS.md).
3. `npm run go` — updates the checkout, runs setup, runs doctor, and starts the bridge supervisor.
4. Fully quit and restart WoW; enable **Runback** on the AddOns screen (leave the slot addons enabled).
5. Turn on **combat logging** in game (Settings → Network → Advanced → Combat Log, or click `[turn on combat log]` when Runback prints it at login).
6. While the colored strip is in the top-left corner, run `npm run probe` once; it saves `bridge/probe.png` and says whether capture decoded the strip.

Without `--wow`, `setup.js` (inside `npm run go`) looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet`. Pass `node setup.js --wow "<client folder>"` when it cannot find yours.

`npm run doctor` any time. It only reads. It prints PASS or FAIL for Node.js, python3, agent login, X11, the client folder, installed slots, the bridge supervisor, and combat-log files. A FAIL line includes a one-line fix. The login check uses each CLI's own read-only command (`claude auth status`, `codex login status`, a short headless prompt for `agy` and `grok`, `hermes auth list`, `opencode auth list`); it judges yes or no from exit codes and safe output shapes only, never tokens or account names.

## No X11 session yet

A PC that runs Hyprland has Wayland only, and the XWayland it provides is not enough: the bridge must read another window's pixels. Add one X11 session next to Hyprland for the capture test. Hyprland's own session file is not changed, so the rollback is a logout.

The Omarchy SDDM theme draws no session picker: it signs you into the `uwsm` session (`/usr/share/sddm/themes/omarchy/Main.qml`, `sessionIndex`). So the test switches SDDM to its own `elarun` theme, which has the picker, for one session.

On Arch with SDDM (Omarchy), as root:

```bash
sudo pacman -S --needed openbox xterm xorg-xinit

sudo tee /usr/local/bin/runback-x11-session >/dev/null <<'EOF'
#!/bin/sh
# One terminal, then openbox as the session process.
xterm &
exec openbox
EOF
sudo chmod +x /usr/local/bin/runback-x11-session

sudo mkdir -p /usr/share/xsessions
sudo tee /usr/share/xsessions/runback-x11.desktop >/dev/null <<'EOF'
[Desktop Entry]
Name=Runback X11 (openbox)
Comment=Minimal X11 session for the Runback strip capture
Exec=/usr/local/bin/runback-x11-session
Type=Application
DesktopNames=openbox
EOF

# A file that sorts after 99-omarchy-login.conf wins the [Theme] key; no existing file is edited.
sudo tee /etc/sddm.conf.d/zz-runback-theme.conf >/dev/null <<'EOF'
[Theme]
Current=elarun
EOF
```

Log out, not reboot: `[Autologin]` in `/etc/sddm.conf.d/autologin.conf` skips the screen on boot. The login screen then lists the sessions; pick *Runback X11 (openbox)*. In the terminal it opens:

```bash
echo $XDG_SESSION_TYPE                            # must print x11
loginctl show-session "$XDG_SESSION_ID" -p Type    # must say Type=x11
cd ~/runback                                      # the clone from above
npm run doctor                                    # PASS x11, no Wayland line
```

Then run `npm run go` again from the repo.

To undo it, drop the extra theme file, then get out of openbox (right-click the desktop, *Exit*, or `loginctl terminate-user "$USER"`) and log in to Hyprland again:

```bash
sudo rm /etc/sddm.conf.d/zz-runback-theme.conf
sudo rm /usr/share/xsessions/runback-x11.desktop /usr/local/bin/runback-x11-session
```

The next login is the Omarchy theme and Hyprland as before: both session directories (`/usr/local/share/wayland-sessions` and `/usr/share/wayland-sessions`) and the other `/etc/sddm.conf.d` files were never touched, so only the empty `/usr/share/xsessions`, the three packages and the game remain installed. If the greeter ever fails to draw, press `Ctrl+Alt+F2`, log in, run those two `rm` lines, and `sudo systemctl restart sddm`.

## Check the capture (troubleshooting)

If the picture from `npm run probe` is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `bridge/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. As a last resort `/runback mode reload` in game: no capture at all, one UI reload per message.

`bridge.log` shows `capture: attached to window 0x...` once the window is found. If it keeps saying `waiting for WowB window`, set `capture.processName` to your executable's name, or `capture.windowName` to part of the window title. `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.
