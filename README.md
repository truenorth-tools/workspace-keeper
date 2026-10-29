# Dock to Primary

A GNOME Shell extension that keeps your windows where you can use them when you plug in or unplug a display.

Whenever the primary display changes, Dock to Primary moves the windows from the old primary onto the new one. Each window stays on its own workspace, and you stay on the workspace you were using. The primary display can change because a display is connected or disconnected, or because you pick a new primary in Settings.

- **Plug in a monitor** that is set as primary: your laptop windows move onto it, each on its own workspace.
- **Unplug it**: everything comes back to the laptop screen, still on the right workspaces.
- Works with any connection: HDMI, DisplayPort, USB-C and docks.
- Nothing to configure.

## Why

With GNOME's default *workspaces on primary display only* setting, windows on a secondary display belong to every workspace at once. When the display layout changes, GNOME (mutter) has to pick a workspace for each of them, and it usually puts them all on the one you're looking at. Windows also stay on the old primary when a new one is connected, so after docking your work is on the small laptop screen.

This has been reported upstream for years ([mutter#761](https://gitlab.gnome.org/GNOME/mutter/-/work_items/761), [gnome-shell#1046](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/1046)). Dock to Primary works around it until GNOME fixes it.

## How it differs from similar extensions

- [Move all windows to primary screen](https://extensions.gnome.org/extension/8268/move-all-windows-to-primary-screen/) does a similar move, but only when you click its button or press its shortcut. Dock to Primary runs by itself whenever the displays change.
- Layout-restoring extensions such as [Dynamic Window Position](https://github.com/wranvaud/dynamic-window-position) remember exact window positions for each display setup. Dock to Primary is simpler: it gathers everything onto whichever display is primary and leaves positions to GNOME.

## Install

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

Requires GNOME Shell 50.

## How it works

1. The extension keeps track of which workspace every window is on, and which workspace you're on.
2. When the displays change, it takes a snapshot of those workspaces. Changes GNOME makes in the moment before it hears about the new layout are ignored, so the snapshot shows where windows really were.
3. It waits until GNOME and the apps have stopped moving windows (no changes for 0.4 seconds). Then it moves any window still on the old primary onto the new one and puts every window back on its workspace. It repeats this until nothing changes, so a fast machine is done in well under a second and a slow one or a dock gets the time it needs, up to 6 seconds.
4. Until then it also keeps you on the workspace you were using. As soon as things settle, workspace switching is entirely yours again.

The extension also runs on the lock screen, because displays are often connected while the screen is locked (for example when docking a laptop). If it were turned off while locked, it would forget each window's workspace and miss the change.

## Known limitations

- **Use a fixed number of workspaces.** With dynamic workspaces, GNOME removes workspaces that become empty while windows are being moved, so the numbering can shift and windows may land one workspace off. Set a fixed number in Settings → Multitasking → Workspaces.
- **Windows that were on a secondary display** (not the old primary) belonged to every workspace, so there is no workspace to restore. They go wherever GNOME puts them.
- **Some apps can't tile to half of a small screen.** Apps with a large minimum width, such as some Electron apps, drop out of half-screen tiling when moved to a smaller display, and Super+←/→ does nothing there. That limit is set by the app, not by this extension.
- Tested on Wayland. X11 sessions should work but haven't been tested.

## Troubleshooting

To see what the extension is doing, set `DEBUG = true` near the top of `extension.js`, log out and back in, then watch the log while you plug or unplug a display:

```sh
journalctl --user -f | grep dock-to-primary
```

Please include this output when [opening an issue](https://github.com/truenorth-tools/dock-to-primary/issues).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
