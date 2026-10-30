// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// After a display change, act once mutter and the clients have gone quiet for
// this long (no window changing monitor or workspace), so a fast machine is
// done in well under a second and a slow one is given the time it needs.
const QUIET_MS = 400;
// Give up waiting for things to settle this long after the last display change.
const MAX_RESTORE_MS = 6000;
// Mutter may reassign workspaces just before we hear about the change, so a
// change this recent is treated as part of it and the previous one is used.
const LOOKBACK_MS = 1000;

const DEBUG = false;

function debug(message) {
    if (DEBUG)
        console.log(`workspace-keeper: ${message}`);
}

function describe(window) {
    return `"${window.get_title()}" (${window.get_wm_class()})`;
}

const MOVABLE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

export default class KeepWorkspacesExtension extends Extension {
    enable() {
        // window -> {index, onAll, time, previous}: the workspace it really
        // belonged to, whether it is currently on all workspaces because it
        // sits on a non-primary display, when that last changed, and the
        // state before that change
        this._workspaces = new Map();
        // True from a display change until things settle; workspace changes in
        // this time are mutter's doing, not the user's, so aren't recorded.
        this._restoring = false;
        this._blockingWorkspaces = false;
        this._restoreStart = 0;
        this._quietId = 0;
        this._maxId = 0;
        // window -> workspace index to restore once it lands on the primary
        this._pending = new Map();
        this._windowSignals = new Map();
        this._monitorManager = global.backend.get_monitor_manager();
        // Connectors of the primary display before the latest change, so we
        // only gather windows from the screen that used to be primary.
        this._primaryConnectors = this._getPrimaryConnectors();
        this._sourceConnectors = null;
        // {index, previous, time} of the active workspace, and the index to
        // keep active while displays are being plugged in or unplugged.
        this._activeWorkspace = null;
        this._heldWorkspace = null;
        this._activateIdleId = 0;
        this._rememberActiveWorkspace();

        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);

        this._createdId = global.display.connect('window-created',
            (_display, window) => this._track(window));
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());
        this._enteredId = global.display.connect('window-entered-monitor',
            (_display, _monitor, window) => {
                if (this._pending.has(window))
                    this._restoreWorkspace(window);
                this._notQuietYet();
            });
        this._activeChangedId = global.workspace_manager.connect(
            'active-workspace-changed', () => this._onActiveWorkspaceChanged());
        // With dynamic workspaces, removing an empty workspace renumbers the
        // ones after it, so the remembered indices have to follow.
        this._workspaceRemovedId = global.workspace_manager.connect(
            'workspace-removed', () => this._onWorkspacesRenumbered());
        this._workspacesReorderedId = global.workspace_manager.connect(
            'workspaces-reordered', () => this._onWorkspacesRenumbered());
    }

    // The extension also runs in the unlock-dialog session mode because
    // displays are often connected while the screen is locked (e.g. docking
    // a laptop). Disabling on lock would forget each window's workspace and
    // miss the hotplug, leaving windows on the wrong screen after unlocking.
    disable() {
        this._clearTimeouts();
        if (this._activateIdleId)
            GLib.source_remove(this._activateIdleId);
        this._unblockWorkspaceRemoval();

        global.workspace_manager.disconnect(this._activeChangedId);
        global.workspace_manager.disconnect(this._workspaceRemovedId);
        global.workspace_manager.disconnect(this._workspacesReorderedId);
        global.display.disconnect(this._createdId);
        global.display.disconnect(this._enteredId);
        Main.layoutManager.disconnect(this._monitorsId);

        for (const window of [...this._windowSignals.keys()])
            this._untrack(window);
        this._windowSignals = null;
        this._workspaces = null;
        this._pending = null;
        this._monitorManager = null;
        this._primaryConnectors = null;
        this._sourceConnectors = null;
        this._activeWorkspace = null;
        this._heldWorkspace = null;
    }

    _track(window) {
        // Menus, tooltips and other popups come and go all the time and are
        // never moved, so don't spend signal handlers on them. Only windows
        // tracked here are ever snapshotted or moved.
        if (this._windowSignals.has(window) || window.is_override_redirect() ||
            !MOVABLE_TYPES.includes(window.get_window_type()))
            return;

        this._windowSignals.set(window, [
            window.connect('workspace-changed', () => this._onWorkspaceChanged(window)),
            window.connect('unmanaged', () => this._untrack(window)),
        ]);
        this._remember(window);
    }

    _untrack(window) {
        for (const id of this._windowSignals.get(window) ?? [])
            window.disconnect(id);
        this._windowSignals.delete(window);
        this._workspaces.delete(window);
        this._pending.delete(window);
    }

    _onWorkspacesRenumbered() {
        if (this._restoring)
            return;
        for (const window of this._windowSignals.keys())
            this._remember(window);
        this._rememberActiveWorkspace();
    }

    // With dynamic workspaces GNOME removes a workspace as soon as it is
    // empty, which happens to some while windows are moving between displays.
    // Keep them until everything is back in place.
    _blockWorkspaceRemoval() {
        if (this._blockingWorkspaces || !Meta.prefs_get_dynamic_workspaces())
            return;
        Main.wm.blockWorkspaceUpdates();
        this._blockingWorkspaces = true;
    }

    _unblockWorkspaceRemoval() {
        if (!this._blockingWorkspaces)
            return;
        Main.wm.unblockWorkspaceUpdates();
        this._blockingWorkspaces = false;
    }

    // A workspace may already have been removed before the display change
    // reached us; with dynamic workspaces, add it back.
    _ensureWorkspace(index) {
        const manager = global.workspace_manager;
        if (Meta.prefs_get_dynamic_workspaces()) {
            while (manager.get_n_workspaces() <= index)
                manager.append_new_workspace(false, global.get_current_time());
        }
        return index < manager.get_n_workspaces();
    }

    _onWorkspaceChanged(window) {
        if (this._pending.has(window))
            this._restoreWorkspace(window);
        else if (!this._restoring)
            this._remember(window);
        this._notQuietYet();
    }

    // Something is still moving: wait for another QUIET_MS before acting.
    _notQuietYet() {
        if (!this._restoring)
            return;
        if (this._quietId)
            GLib.source_remove(this._quietId);
        this._quietId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MS, () => {
            this._quietId = 0;
            this._onQuiet();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onQuiet() {
        // Moving or restoring anything sets off more events, so this runs
        // again until a pass finds nothing left to do.
        if (this._moveToPrimary())
            this._notQuietYet();
        else
            this._finishRestoring();
    }

    _finishRestoring() {
        this._clearTimeouts();
        const elapsed = GLib.get_monotonic_time() / 1000 - this._restoreStart;
        this._restoring = false;
        this._unblockWorkspaceRemoval();
        this._sourceConnectors = null;
        this._heldWorkspace = null;
        this._rememberActiveWorkspace();
        this._pending.clear();
        for (const window of this._windowSignals.keys())
            this._remember(window);
        debug(`finished restoring workspaces after ${Math.round(elapsed)} ms`);
    }

    // Record where every window was before the display change, so windows
    // mutter moves to the new primary by itself are put back too, not only
    // the ones this extension moves. Windows that were on a non-primary
    // display had no workspace, so they are left on the one mutter picks.
    _snapshot() {
        const now = GLib.get_monotonic_time() / 1000;
        this._pending.clear();
        for (const [window, entry] of this._workspaces) {
            if (window.skip_taskbar || window.is_always_on_all_workspaces())
                continue;
            const recent = now - entry.time < LOOKBACK_MS;
            const {index, onAll} = recent && entry.previous ? entry.previous : entry;
            if (onAll)
                continue;
            this._pending.set(window, index);
            if (DEBUG)
                debug(`${describe(window)}: snapshot workspace ${index}`);
        }
        this._restoring = true;
    }

    // On Wayland a move only completes once the client acknowledges it, and
    // mutter then drops the window on the active workspace. So restore the
    // workspace after the window has really arrived on the primary monitor.
    // Returns true if the window had to be put back.
    _restoreWorkspace(window) {
        const index = this._pending.get(window);
        if (window.is_on_all_workspaces() ||
            window.get_monitor() !== global.display.get_primary_monitor())
            return false;

        // Stay pending until things settle so a later reassignment is undone too.
        if (this._ensureWorkspace(index) &&
            window.get_workspace()?.index() !== index) {
            if (DEBUG) {
                debug(`${describe(window)}: workspace ` +
                    `${window.get_workspace()?.index()} -> ${index}`);
            }
            window.change_workspace_by_index(index, false);
            return true;
        }
        return false;
    }

    _remember(window) {
        // A window on a non-primary monitor is "on all workspaces" and has no
        // workspace of its own, so keep the last real one and just note that.
        const workspace = window.get_workspace();
        const onAll = !workspace || window.is_on_all_workspaces();
        const entry = this._workspaces.get(window);
        if (onAll && !entry)
            return;
        const index = onAll ? entry.index : workspace.index();
        if (entry?.index === index && entry.onAll === onAll)
            return;
        if (DEBUG) {
            debug(`${describe(window)}: remembered workspace ` +
                `${onAll ? 'all' : index}`);
        }
        this._workspaces.set(window, {
            index,
            onAll,
            time: GLib.get_monotonic_time() / 1000,
            previous: entry ? {index: entry.index, onAll: entry.onAll} : undefined,
        });
    }

    _getPrimaryConnectors() {
        const primary = global.display.get_primary_monitor();
        return this._monitorManager.get_monitors()
            .map(monitor => monitor.get_connector())
            .filter(connector =>
                this._monitorManager.get_monitor_for_connector(connector) === primary);
    }

    _clearTimeouts() {
        if (this._quietId)
            GLib.source_remove(this._quietId);
        if (this._maxId)
            GLib.source_remove(this._maxId);
        this._quietId = 0;
        this._maxId = 0;
    }

    _rememberActiveWorkspace() {
        const index = global.workspace_manager.get_active_workspace_index();
        if (this._activeWorkspace?.index === index)
            return;
        this._activeWorkspace = {
            index,
            previous: this._activeWorkspace?.index,
            time: GLib.get_monotonic_time() / 1000,
        };
    }

    _onActiveWorkspaceChanged() {
        if (this._heldWorkspace === null) {
            this._rememberActiveWorkspace();
            return;
        }
        this._notQuietYet();
        // Switch back outside the signal handler, once things settle.
        if (!this._activateIdleId) {
            this._activateIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._activateIdleId = 0;
                this._activateHeldWorkspace();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _activateHeldWorkspace() {
        const manager = global.workspace_manager;
        const index = this._heldWorkspace;
        if (index === null || !this._ensureWorkspace(index) ||
            manager.get_active_workspace_index() === index)
            return;
        debug(`active workspace ${manager.get_active_workspace_index()} -> ${index}`);
        manager.get_workspace_by_index(index).activate(global.get_current_time());
    }

    // Stay on the workspace the user was on when a display was plugged in or
    // unplugged, however mutter shuffles things while the layout changes.
    _holdActiveWorkspace() {
        if (this._heldWorkspace === null) {
            const now = GLib.get_monotonic_time() / 1000;
            const {index, previous, time} = this._activeWorkspace;
            this._heldWorkspace = now - time < LOOKBACK_MS && previous !== undefined
                ? previous : index;
            debug(`holding active workspace ${this._heldWorkspace}`);
        }
        this._activateHeldWorkspace();
    }

    _onMonitorsChanged() {
        // Plugging in, unplugging and picking a new primary in Settings are
        // all handled alike. Keep the first source if a dock brings up
        // several displays in a row.
        if (!this._restoring) {
            this._sourceConnectors = this._primaryConnectors;
            this._blockWorkspaceRemoval();
            this._snapshot();
        }
        this._primaryConnectors = this._getPrimaryConnectors();
        this._holdActiveWorkspace();

        debug(`monitors changed: from [${this._sourceConnectors}] ` +
            `to [${this._primaryConnectors}]`);
        if (DEBUG) {
            for (const window of this._windowSignals.keys())
                debug(`  ${describe(window)}: ${this._describeState(window)}`);
        }

        this._restoreStart = GLib.get_monotonic_time() / 1000;
        if (this._maxId)
            GLib.source_remove(this._maxId);
        this._maxId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_RESTORE_MS, () => {
            this._maxId = 0;
            debug('gave up waiting for windows to settle');
            this._moveToPrimary();
            this._finishRestoring();
            return GLib.SOURCE_REMOVE;
        });
        this._notQuietYet();
    }

    _describeState(window) {
        try {
            const type = window.get_client_type() === Meta.WindowClientType.WAYLAND
                ? 'wayland' : 'x11';
            const {x, y, width, height} = window.get_frame_rect();
            return `${type}, type ${window.get_window_type()}, ` +
                `monitor ${window.get_monitor()}, ` +
                `workspace ${window.get_workspace()?.index() ?? 'none'}, ` +
                `onAll ${window.is_on_all_workspaces()}, ` +
                `sticky ${window.is_always_on_all_workspaces()}, ` +
                `skipTaskbar ${window.skip_taskbar}, minimized ${window.minimized}, ` +
                `hidden ${window.is_hidden()}, rect ${width}x${height}+${x}+${y}`;
        } catch (e) {
            return `unknown (${e.message})`;
        }
    }

    // Returns true if any window was moved or put back on its workspace.
    _moveToPrimary() {
        let changed = false;
        for (const window of [...this._pending.keys()])
            changed = this._restoreWorkspace(window) || changed;

        const primary = global.display.get_primary_monitor();
        const sources = new Set(this._sourceConnectors
            .map(connector => this._monitorManager.get_monitor_for_connector(connector))
            .filter(index => index >= 0 && index !== primary));
        // The old primary is gone or is still primary: nothing to gather.
        if (sources.size === 0)
            return changed;

        for (const window of this._windowSignals.keys()) {
            if (window.skip_taskbar || !sources.has(window.get_monitor()))
                continue;

            if (DEBUG) {
                debug(`moving ${describe(window)} to primary, ` +
                    `workspace ${this._pending.get(window)}`);
            }
            window.move_to_monitor(primary);
            if (this._pending.has(window))
                this._restoreWorkspace(window);
            changed = true;
        }
        return changed;
    }
}
