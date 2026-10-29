# Dock to Primary

A GNOME Shell extension that moves your windows onto the primary display whenever it changes, and keeps each one on its own workspace.

## Why

If you dock a laptop to an external monitor, you've probably met this. With GNOME's default *workspaces on primary display only* setting, the primary display has workspaces and any other display shows the same windows on all of them. That's a great setup for keeping reference material in view while you work, until the displays change:

- **Plug in a monitor** and set it as primary, and your windows stay behind on the laptop screen. Each one has to be dragged across.
- **Unplug it**, and GNOME (mutter) has to choose a workspace for every window it brings back. It usually puts them all on the one you're looking at, so work spread over several workspaces ends up in one pile.

This has been reported upstream for years ([mutter#761](https://gitlab.gnome.org/GNOME/mutter/-/work_items/761), [gnome-shell#1046](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/1046)). Dock to Primary works around it until GNOME fixes it.

## Features

Whenever the primary display changes, Dock to Primary moves the windows from the old primary onto the new one. Each window goes back to its own workspace, and you stay on the workspace you were using.

- **Docking**: your laptop windows move onto the monitor, each on its own workspace.
- **Undocking**: everything comes back to the laptop screen, still on the right workspaces.
- **Changing the primary in Settings** is handled the same way.
- Works with any connection: HDMI, DisplayPort, USB-C and docks.
- Nothing to configure, and no saved layouts, so it works with a monitor it has never seen before.

## Requirements

- GNOME Shell 50. Tested on Wayland; X11 should work but hasn't been tested.
- **Workspaces only on the primary display** (GNOME's default). The primary display is where you work; other displays are for things you want in view all the time.
- **A fixed number of workspaces**, set in Settings → Multitasking → Workspaces. With dynamic workspaces, GNOME removes workspaces that become empty while windows are moving, so windows may land one workspace off.
- **The display you want to work on set as primary** in Settings → Displays.

## Installation

### From extensions.gnome.org

*(Link coming once the extension is approved.)*

### From source

```sh
git clone https://github.com/truenorth-tools/dock-to-primary.git \
    ~/.local/share/gnome-shell/extensions/dock-to-primary@truenorth-tools
```

Log out and back in (on Wayland GNOME only loads new extensions at login), then:

```sh
gnome-extensions enable dock-to-primary@truenorth-tools
```

## How it works

1. The extension keeps track of which workspace every window is on, and which workspace you're on.
2. When the displays change, it takes a snapshot of those workspaces. Changes GNOME makes in the moment before it hears about the new layout are ignored, so the snapshot shows where windows really were.
3. It waits until GNOME and the apps have stopped moving windows (no changes for 0.4 seconds). Then it moves any window still on the old primary onto the new one and puts every window back on its workspace. It repeats this until nothing changes, so a fast machine is done in well under a second and a slow one or a dock gets the time it needs, up to 6 seconds.
4. Until then it also keeps you on the workspace you were using. As soon as things settle, workspace switching is entirely yours again.

The extension also runs on the lock screen, because displays are often connected while the screen is locked (for example when docking a laptop). If it were turned off while locked, it would forget each window's workspace and miss the change.

## Known limitations

- **Windows that were on a secondary display** (not the old primary) belonged to every workspace, so there is no workspace to restore. They go wherever GNOME puts them, usually the workspace you're on.
- **Some apps can't tile to half of a small screen.** Apps with a large minimum width, such as some Electron apps, drop out of half-screen tiling when moved to a smaller display, and Super+←/→ does nothing there. That limit is set by the app, not by this extension.

## Alternatives

A few other extensions deal with windows when displays change, each in a slightly different way:

- [Move all windows to primary screen](https://extensions.gnome.org/extension/8268/move-all-windows-to-primary-screen/) gathers windows onto the primary display when you click its top bar icon or press its shortcut, with options for workspaces and excluded apps. A good pick if you'd rather choose when the move happens.
- [Window State Manager](https://extensions.gnome.org/extension/5353/window-state-manager/) saves window positions as you work and restores them when the display arrangement changes. A good pick if you want exact layouts back for setups you use often.
- [Deja Window](https://extensions.gnome.org/extension/9024/deja-window/) applies per-app rules (workspace, size, position) when each app opens. It works happily alongside Dock to Primary.
- [Return to Monitor](https://extensions.gnome.org/extension/842/return-to-monitor/) tackled a similar problem for GNOME 3.10–3.12 and isn't maintained for current GNOME.

Dock to Primary is deliberately small: it runs only when the primary display changes, and it focuses on putting every window back on the right workspace.

## Troubleshooting

To see what the extension is doing, set `DEBUG = true` near the top of `extension.js`, log out and back in, then watch the log while you plug or unplug a display:

```sh
journalctl --user -f | grep dock-to-primary
```

Please include this output when [opening an issue](https://github.com/truenorth-tools/dock-to-primary/issues).

Tip: to move a single window between displays yourself, GNOME's built-in Super+Shift+←/→ (or ↑/↓) sends it to the next display in that direction.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
