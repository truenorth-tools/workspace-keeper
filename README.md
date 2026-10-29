# Dock to Primary

A GNOME Shell extension that moves your windows onto the primary display whenever it changes, each on its own workspace.

## The problem

GNOME's default setting is *workspaces on primary display only*: the primary display has workspaces, and any other display shows the same windows whatever workspace you're on. That works well until the displays change:

- **Plug in a monitor** and set it as primary, and your windows stay on the laptop screen. You have to drag each one across.
- **Unplug it**, and GNOME (mutter) has to choose a workspace for every window it brings back, and it usually puts them all on the one you're looking at. Work you had spread over six workspaces ends up piled on one.

This has been reported upstream for years ([mutter#761](https://gitlab.gnome.org/GNOME/mutter/-/work_items/761), [gnome-shell#1046](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/1046)). Dock to Primary works around it until GNOME fixes it.

## Why I wrote it

I use a laptop that I plug into an external monitor at a desk. The monitor is where I work, with my windows organised across workspaces, and the laptop screen beside it holds reference material that I want in view whatever workspace I'm on. Every time I docked I had to drag my windows over to the monitor, and every time I left the desk I had to sort them back out of one heap. I wanted the windows to follow the primary display by themselves and keep their workspaces, with nothing to set up.

## What it does

Whenever the primary display changes, Dock to Primary moves the windows from the old primary onto the new one. Each window goes back to its own workspace, and you stay on the workspace you were using. The primary display can change because a display is connected or disconnected, or because you pick a new primary in Settings.

- **Docking**: your laptop windows move onto the monitor, each on its own workspace.
- **Undocking**: everything comes back to the laptop screen, still on the right workspaces.
- Works with any connection: HDMI, DisplayPort, USB-C and docks.
- Nothing to configure, and nothing saved between sessions.

## Assumptions

Dock to Primary is built for one way of working:

- **Workspaces only on the primary display** (GNOME's default). The primary display is where you work, and any other display is for things you want in view all the time.
- **A fixed number of workspaces**, set in Settings → Multitasking → Workspaces. With dynamic workspaces, GNOME removes workspaces that become empty while windows are moving, so windows may land one workspace off.
- **The display you want to work on is set as primary** in Settings → Displays.

## Similar extensions

A few other extensions deal with windows when displays change. Each one does a slightly different job:

- [Move all windows to primary screen](https://extensions.gnome.org/extension/8268/move-all-windows-to-primary-screen/) gathers windows onto the primary display when you click its top bar icon or press its shortcut. It has options for how workspaces are handled and which apps to leave alone. Use it if you want to choose when the move happens.
- [Window State Manager](https://extensions.gnome.org/extension/5353/window-state-manager/) saves window positions as you work and restores them when the display arrangement changes. Use it if you want exact layouts back for setups you use often.
- [Deja Window](https://extensions.gnome.org/extension/9024/deja-window/) applies per-app rules (workspace, size, position) when each app opens. It works alongside Dock to Primary rather than instead of it.
- [Return to Monitor](https://extensions.gnome.org/extension/842/return-to-monitor/) tackled a similar problem for GNOME 3.10–3.12 and isn't maintained for current GNOME.

Dock to Primary is narrower and lighter than these. It runs only when the primary display changes, it needs no saved layout (so it also works with a monitor it has never seen, such as a hot desk or a projector), and its focus is putting every window back on the right workspace.

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

- **Windows that were on a secondary display** (not the old primary) belonged to every workspace, so there is no workspace to restore. They go wherever GNOME puts them, usually the workspace you're on.
- **Some apps can't tile to half of a small screen.** Apps with a large minimum width, such as some Electron apps, drop out of half-screen tiling when moved to a smaller display, and Super+←/→ does nothing there. That limit is set by the app, not by this extension.
- Tested on Wayland. X11 sessions should work but haven't been tested.

## Troubleshooting

To see what the extension is doing, set `DEBUG = true` near the top of `extension.js`, log out and back in, then watch the log while you plug or unplug a display:

```sh
journalctl --user -f | grep dock-to-primary
```

Please include this output when [opening an issue](https://github.com/truenorth-tools/dock-to-primary/issues).

To move a single window between displays yourself, GNOME's built-in Super+Shift+←/→ (or ↑/↓) sends it to the next display in that direction.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
