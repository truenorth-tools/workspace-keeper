# Dock to Primary

A GNOME Shell extension that keeps each window on its original workspace when the primary display changes.

## Motivation

With the setting to have workspaces on the primary display only, GNOME does not preserve the workspace layout when the primary display changes.

If an external monitor becomes the primary display, windows spread across the laptop's workspaces are all placed on a single workspace of the monitor.

This has been reported upstream ([mutter#761](https://gitlab.gnome.org/GNOME/mutter/-/work_items/761), [gnome-shell#1046](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/1046)).

Dock to Primary moves the windows to the new primary display and returns each window to its original workspace, so the layout stays the same.

## Features

- Handles connecting a display, disconnecting it, and choosing a different primary display in Settings.
- Keeps the active workspace unchanged when the primary display changes, so the same workspace stays in view after docking.
- Supports both fixed and dynamic workspaces.
- Requires no configuration or saved layouts, so it works with displays it has not seen before.

## Requirements

- GNOME Shell 50. Tested on Wayland; X11 is untested.
- **Workspaces on primary display only** enabled (the GNOME default), under Settings → Multitasking.
- The display to work on set as primary, under Settings → Displays.

## Installation

### From extensions.gnome.org

*(Link to follow once the extension is approved.)*

### From source

```sh
git clone https://github.com/truenorth-tools/dock-to-primary.git \
    ~/.local/share/gnome-shell/extensions/dock-to-primary@truenorth-tools
```

Log out and back in (on Wayland, GNOME Shell loads new extensions only at login), then run:

```sh
gnome-extensions enable dock-to-primary@truenorth-tools
```

## Known limitations

- Windows on a secondary display appear on every workspace and have no workspace of their own to restore. GNOME decides where they go when disconnecting an external display, usually the active workspace.
- Apps with a large minimum width, including some Electron apps, cannot tile to half of a small display. When moved to one, they leave half-screen tiling and become floating windows on the same workspace, and Super+←/→ has no effect. This limit is set by the app and only affects small displays.

## Alternatives

- [Move all windows to primary screen](https://extensions.gnome.org/extension/8268/move-all-windows-to-primary-screen/) moves windows to the primary display on demand, from a top bar button or keyboard shortcut.
- [Window State Manager](https://extensions.gnome.org/extension/5353/window-state-manager/) saves window positions and restores them when the display arrangement changes.
- [Deja Window](https://extensions.gnome.org/extension/9024/deja-window/) applies per-app rules for workspace, size and position when an app opens. It can be used alongside Dock to Primary.
- [Return to Monitor](https://extensions.gnome.org/extension/842/return-to-monitor/) addressed a similar problem for GNOME 3.10–3.12 and is no longer maintained.

Dock to Primary differs from these in that it acts automatically whenever the primary display changes and restores each window's workspace rather than an exact position. It needs no saved layouts or per-app rules, so it works with any display.

## How it works

The extension records the workspace of every window. When the displays change, it disregards workspace changes GNOME makes during the switch and waits until windows stop moving (0.4 seconds without changes, up to 6 seconds in total). It then moves the windows across and returns each one to its recorded workspace. With dynamic workspaces, it pauses GNOME's removal of empty workspaces until the restore is complete and recreates any workspace removed beforehand.

The extension remains active on the lock screen, as laptops are often docked while locked.

## Troubleshooting

To enable logging, set `DEBUG = true` near the top of `extension.js`, log out and back in, then follow the log while connecting or disconnecting a display:

```sh
journalctl --user -f | grep dock-to-primary
```

Please include this output when [opening an issue](https://github.com/truenorth-tools/dock-to-primary/issues).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
