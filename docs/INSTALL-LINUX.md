# Installing on Linux (Wine)

The addon is the same; only the bridge's screen capture differs. On Linux the bridge runs `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages to install) instead of `capture.ps1`, and writes the slot files straight into the Wine prefix.

## Requirements

- An **X11** session (`echo $XDG_SESSION_TYPE` prints `x11`). Wayland blocks reading other windows' pixels; a Wayland PC can add one, see [No X11 session yet](#no-x11-session-yet).
- The game under Wine (Lutris, Bottles, a hand-made prefix...), **windowed or borderless**.
- Node.js 22.2+, python3, and at least one agent CLI logged in (see [AGENTS.md](AGENTS.md)).

## Install

```bash
git clone https://github.com/Nercari/runback
cd runback
npm ci                      # only needed to run the tests
node setup.js --wow "$HOME/.wine/drive_c/Program Files (x86)/World of Warcraft/_forever_" --project ~/path/to/the/project
```

Without `--wow`, `setup.js` looks in `$WINEPREFIX`, `~/.wine` and `~/Games/battlenet`. Then fully restart the game, enable *Runback* on the AddOns screen, and start the bridge with `npm start`.

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

sudo cp /etc/sddm.conf.d/10-theme.conf /etc/sddm.conf.d/10-theme.conf.runback-backup
sudo sed -i 's/^Current=.*/Current=elarun/' /etc/sddm.conf.d/10-theme.conf
```

Log out, not reboot: `[Autologin]` in `/etc/sddm.conf.d/autologin.conf` skips the screen on boot. The login screen then lists the sessions; pick *Runback X11 (openbox)*. In the terminal it opens:

```bash
echo $XDG_SESSION_TYPE                            # must print x11
loginctl show-session "$XDG_SESSION_ID" -p Type    # must say Type=x11
cd ~/runback                                      # the clone from above
npm run doctor                                    # PASS x11, no Wayland line
```

Then install Wine and the game and run `node setup.js --wow <client folder>` as above, start the bridge with `npm start`, and run the capture check below.

To undo it, restore the theme first and then log out to Hyprland:

```bash
sudo mv /etc/sddm.conf.d/10-theme.conf.runback-backup /etc/sddm.conf.d/10-theme.conf
sudo rm /usr/share/xsessions/runback-x11.desktop /usr/local/bin/runback-x11-session
```

The next login is Hyprland as before; `/usr/share/wayland-sessions` was never touched.

## Check the capture (do this once)

Log in, open the Runback window and send any message, then while the strip of colored squares is in the top-left corner run:

```bash
npm run probe
```

It finds the game window, saves what the capture sees to `bridge/probe.png`, and prints whether it could decode a strip, with the session type (`"session":"x11"`) on the same line, so that one line proves both. If the picture is black or stale while the game shows the strip, the compositor is letting the game flip its own buffers. Try, in order:

1. `"keepComposited": true` under `capture` in `bridge/config.json` (asks mutter/KWin to keep compositing the game window), then restart the bridge.
2. Plain windowed mode in the game settings.
3. `nvidia-settings -a AllowFlipping=0` (NVIDIA).
4. As a last resort `/runback mode reload` in game: no capture at all, one UI reload per message.

`bridge.log` shows `capture: attached to window 0x...` once the window is found. If it keeps saying `waiting for WowB window`, set `capture.processName` to your executable's name, or `capture.windowName` to part of the window title. `capture.python` picks the interpreter if `python3` is not the one on your `PATH`.
