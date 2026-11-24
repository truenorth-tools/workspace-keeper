// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

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

const PAPERWM_UUID = 'paperwm@paperwm.github.com';

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
                this._checkStrandedSoon(window);
            });
        this._activeChangedId = global.workspace_manager.connect(
            'active-workspace-changed', () => this._onActiveWorkspaceChanged());
        // With dynamic workspaces, removing an empty workspace renumbers the
        // ones after it, so the remembered indices have to follow.
        this._workspaceRemovedId = global.workspace_manager.connect(
            'workspace-removed', () => this._onWorkspacesRenumbered());
        this._workspacesReorderedId = global.workspace_manager.connect(
            'workspaces-reordered', () => this._onWorkspacesRenumbered());

        // PaperWM shows a workspace of its own on each display, so with it
        // running the workspaces are rearranged instead of the windows.
        // PaperWM is turned off on the lock screen, where this extension
        // keeps running, so note display changes it missed.
        this._paperwm = null;
        this._paperwmScratch = null;
        this._paperwmReadyId = 0;
        this._paperwmMissedChange = false;
        this._strandedCheck = new Set();
        this._strandedIdleId = 0;
        this._rescued = new Map();
        // Each secondary display keeps one workspace of its own while
        // PaperWM runs (see _pin): connector -> its workspace, and the last
        // one each display had, to give back when it is plugged in again
        this._pinned = new Map();
        this._lastPinned = new Map();
        this._keepAliveIds = new Map();
        this._placeIdleId = 0;
        this._injections = new InjectionManager();
        this._skipPinnedWorkspaces();
        this._nWorkspacesId = global.workspace_manager.connect(
            'notify::n-workspaces', () => this._onPinnedOrderChanged());
        this._pinnedReorderedId = global.workspace_manager.connect(
            'workspaces-reordered', () => this._onPinnedOrderChanged());
        this._extensionStateId = Main.extensionManager.connect(
            'extension-state-changed', (_manager, extension) => {
                if (extension.uuid === PAPERWM_UUID)
                    this._onPaperWMStateChanged();
            });
        this._onPaperWMStateChanged();
        this._limitSwitchAnimation();
    }

    // PaperWM turns off workspaces-only-on-primary, so GNOME's workspace
    // switch animation slides every display, even one whose PaperWM
    // workspace stays put. While PaperWM runs, animate the primary only.
    // The patch goes on GNOME's controller object, not its class: PaperWM
    // overrides the class's methods and puts them back when it is turned
    // off, so calling through the class reaches whichever is current.
    _limitSwitchAnimation() {
        const controller = Main.wm._workspaceAnimation;
        if (!controller)
            return;
        const proto = Object.getPrototypeOf(controller);
        const extension = this;
        let animating = false;
        controller.animateSwitch = function (...args) {
            animating = true;
            try {
                return proto.animateSwitch.apply(this, args);
            } finally {
                animating = false;
            }
        };
        // Only for animateSwitch: a touchpad swipe looks up each display's
        // group as it goes, so its groups are left alone
        controller._prepareWorkspaceSwitch = function (...args) {
            const result = proto._prepareWorkspaceSwitch.apply(this, args);
            const switchData = this._switchData;
            if (animating && switchData && extension._paperwmSpaces()) {
                const primary = Main.layoutManager.primaryIndex;
                switchData.monitors = switchData.monitors.filter(group => {
                    if (group.index === primary)
                        return true;
                    group.destroy();
                    return false;
                });
            }
            return result;
        };
        this._animationController = controller;
    }

    _restoreSwitchAnimation() {
        const controller = this._animationController;
        if (!controller)
            return;
        delete controller.animateSwitch;
        delete controller._prepareWorkspaceSwitch;
        this._animationController = null;
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
        this._restoreSwitchAnimation();
        this._injections.clear();
        this._injections = null;
        for (const connector of [...this._pinned.keys()])
            this._unpin(connector);
        this._pinned = null;
        this._lastPinned = null;
        this._keepAliveIds = null;
        if (this._placeIdleId)
            GLib.source_remove(this._placeIdleId);
        global.workspace_manager.disconnect(this._nWorkspacesId);
        global.workspace_manager.disconnect(this._pinnedReorderedId);

        global.workspace_manager.disconnect(this._activeChangedId);
        global.workspace_manager.disconnect(this._workspaceRemovedId);
        global.workspace_manager.disconnect(this._workspacesReorderedId);
        Main.extensionManager.disconnect(this._extensionStateId);
        if (this._paperwmReadyId)
            GLib.source_remove(this._paperwmReadyId);
        if (this._strandedIdleId)
            GLib.source_remove(this._strandedIdleId);
        this._strandedCheck = null;
        this._rescued = null;
        this._paperwm = null;
        this._paperwmScratch = null;
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
            window.connect('shown', () => this._checkStrandedSoon(window)),
        ]);
        this._remember(window);
    }

    _untrack(window) {
        for (const id of this._windowSignals.get(window) ?? [])
            window.disconnect(id);
        this._windowSignals.delete(window);
        this._workspaces.delete(window);
        this._pending.delete(window);
        this._strandedCheck?.delete(window);
        this._rescued?.delete(window);
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
        if (this._gather())
            this._notQuietYet();
        else
            this._finishRestoring();
    }

    _finishRestoring() {
        this._clearTimeouts();
        const elapsed = GLib.get_monotonic_time() / 1000 - this._restoreStart;
        this._restoring = false;
        this._unblockWorkspaceRemoval();
        // let GNOME remove workspaces left empty by the rearranging
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
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
        // With PaperWM the active workspace follows the pointer between
        // displays; a secondary's own workspace is never the one to keep
        if (this._pinnedSet().has(global.workspace_manager.get_active_workspace()))
            return;
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
        this._unpinGoneDisplays();
        const paperwm = this._paperwmSpaces() !== null;
        this._paperwmMissedChange = !paperwm;

        // Plugging in, unplugging and picking a new primary in Settings are
        // all handled alike. Keep the first source if a dock brings up
        // several displays in a row.
        if (!this._restoring) {
            this._sourceConnectors = this._primaryConnectors;
            this._blockWorkspaceRemoval();
            // PaperWM keeps windows on their workspaces itself
            if (paperwm) {
                this._pending.clear();
                this._restoring = true;
            } else {
                this._snapshot();
            }
        }
        this._primaryConnectors = this._getPrimaryConnectors();
        this._holdActiveWorkspace();

        debug(`monitors changed: from [${this._sourceConnectors}] ` +
            `to [${this._primaryConnectors}]`);
        if (DEBUG) {
            for (const window of this._windowSignals.keys())
                debug(`  ${describe(window)}: ${this._describeState(window)}`);
        }

        this._startSettling();
    }

    // Wait for windows to stop moving, then gather them on the primary
    // (see _onQuiet), giving up after MAX_RESTORE_MS
    _startSettling() {
        this._restoreStart = GLib.get_monotonic_time() / 1000;
        if (this._maxId)
            GLib.source_remove(this._maxId);
        this._maxId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_RESTORE_MS, () => {
            this._maxId = 0;
            debug('gave up waiting for windows to settle');
            this._gather();
            this._finishRestoring();
            return GLib.SOURCE_REMOVE;
        });
        this._notQuietYet();
    }

    // Returns true if anything was moved, or PaperWM isn't set up yet.
    _gather() {
        if (this._paperwm)
            return this._paperwmSpaces() ? this._arrangePaperWM() : true;
        return this._moveToPrimary();
    }

    async _onPaperWMStateChanged() {
        const extension = Main.extensionManager.lookup(PAPERWM_UUID);
        if (extension?.state !== ExtensionState.ACTIVE) {
            this._paperwm = null;
            this._paperwmScratch = null;
            // PaperWM is off on the lock screen only for a moment; turned
            // off for good, the secondary's workspace is an ordinary one
            if (!Main.sessionMode.isLocked) {
                for (const connector of [...this._pinned.keys()])
                    this._unpin(connector);
            }
            return;
        }
        if (this._paperwm || this._paperwmLoading)
            return;

        // PaperWM's modules are already loaded, so this gives their live state
        let paperwm, scratch;
        this._paperwmLoading = true;
        try {
            paperwm = await import(extension.dir.get_child('tiling.js').get_uri());
            scratch = await import(extension.dir.get_child('scratch.js').get_uri());
        } catch (e) {
            console.warn(`workspace-keeper: can't read PaperWM's workspaces: ${e}`);
            return;
        } finally {
            this._paperwmLoading = false;
        }
        if (!this._windowSignals ||
            Main.extensionManager.lookup(PAPERWM_UUID)?.state !== ExtensionState.ACTIVE)
            return;
        this._paperwm = paperwm;
        this._paperwmScratch = scratch;
        debug('PaperWM is running');
        this._afterPaperWMStarts();

        // Moving windows between displays now would fight PaperWM
        if (this._restoring)
            this._finishRestoring();
        // A display was plugged in or unplugged while PaperWM was off (on the
        // lock screen), or PaperWM has just started with several displays
        // (logging in, unlocking): it has laid out the displays its own way.
        if (this._paperwmMissedChange || Main.layoutManager.monitors.length > 1) {
            this._paperwmMissedChange = false;
            this._blockWorkspaceRemoval();
            this._pending.clear();
            this._restoring = true;
            this._holdActiveWorkspace();
            this._startSettling();
        }
    }

    // PaperWM keeps fullscreen windows above others, and when it starts it
    // takes windows that are above others for floating ones: it pins them to
    // every workspace, out of the tiling. It is turned off and on around the
    // lock screen, so after each unlock a fullscreen app would be left
    // floating over every workspace. Once PaperWM has set up, put them back.
    _afterPaperWMStarts() {
        if (this._paperwmReadyId)
            GLib.source_remove(this._paperwmReadyId);
        let tries = 0;
        this._paperwmReadyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            const spaces = this._paperwmSpaces();
            if (spaces && !spaces._initDone && ++tries < 25)
                return GLib.SOURCE_CONTINUE;
            this._paperwmReadyId = 0;
            if (spaces)
                this._unfloatFullscreen();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Returns true if any window was put back.
    _unfloatFullscreen() {
        const scratch = this._paperwmScratch;
        if (!scratch?.isScratchWindow)
            return false;
        let changed = false;
        for (const [window, {index}] of this._workspaces) {
            if (!window.fullscreen || !scratch.isScratchWindow(window))
                continue;
            if (DEBUG)
                debug(`${describe(window)}: fullscreen, back into the tiling on ${index}`);
            scratch.unmakeScratch(window);
            if (this._ensureWorkspace(index))
                window.change_workspace_by_index(index, false);
            changed = true;
        }
        return changed;
    }

    // PaperWM's workspaces (its Spaces) while it is running, else null
    _paperwmSpaces() {
        return this._paperwm?.spaces?.monitors ? this._paperwm.spaces : null;
    }

    // PaperWM shows a different workspace on each display, so "all windows
    // on the primary" means the primary shows the workspace the user was on,
    // every other workspace belongs to the primary, and every other display
    // shows an empty one, left free as extra room. Each window stays on its
    // workspace. Returns true if a display was given a different workspace,
    // or PaperWM isn't ready yet.
    _arrangePaperWM() {
        const spaces = this._paperwmSpaces();
        // PaperWM lays out the displays itself shortly after it starts and
        // after each display change; wait for that, or it would undo this
        if (!spaces._initDone ||
            !Main.layoutManager.monitors.every(monitor => spaces.monitors.has(monitor))) {
            debug('waiting for PaperWM');
            return true;
        }
        if (DEBUG) {
            debug(`PaperWM shows ${[...spaces.monitors].map(([monitor, space]) =>
                `workspace ${space.index} on monitor ${monitor.index}`).join(', ')}`);
        }
        const primary = Main.layoutManager.primaryMonitor;
        const index = this._heldWorkspace ??
            global.workspace_manager.get_active_workspace_index();
        const main = spaces.spaceOfIndex(index);
        if (!primary || !main)
            return false;

        let changed = this._unfloatFullscreen();
        changed = this._showSpace(spaces, main, primary) || changed;
        const used = new Set([main]);
        this._unpinGoneDisplays();
        for (const monitor of Main.layoutManager.monitors) {
            if (monitor === primary)
                continue;
            const connector = this._connectorOf(monitor.index);
            const space = this._spaceForSecondary(spaces, connector, used);
            if (!space)
                continue;
            used.add(space);
            if (connector)
                this._pin(connector, space.workspace);
            changed = this._showSpace(spaces, space, monitor) || changed;
        }

        // Every other workspace belongs to the primary too, so switching to
        // it later opens it there, and fullscreen windows go with it
        const secondary = new Set([...spaces.monitors]
            .filter(([monitor]) => monitor !== primary).map(([, space]) => space));
        spaces.forEach(space => {
            if (secondary.has(space))
                return;
            if (space.monitor !== primary) {
                debug(`workspace ${space.index} now belongs to the primary`);
                space.setMonitor(primary);
                changed = true;
            }
            for (const window of space.workspace.list_windows()) {
                if (window.fullscreen && !window.is_on_all_workspaces() &&
                    window.get_monitor() !== primary.index) {
                    if (DEBUG)
                        debug(`moving fullscreen ${describe(window)} to primary`);
                    window.move_to_monitor(primary.index);
                    changed = true;
                }
            }
        });
        if (changed)
            spaces.forEach(s => s.setSpaceTopbarElementsVisible?.());
        return changed;
    }

    // PaperWM draws a floating window (a dialog, say) inside the layer of its
    // workspace, and that layer only covers the display showing the
    // workspace. A floating window that sits on another display can't be
    // grabbed there, and moving the pointer to it makes PaperWM switch that
    // display's workspace, which hides the window again. Move such a window
    // to the display that shows its workspace.
    _checkStrandedSoon(window) {
        if (!this._paperwmSpaces())
            return;
        this._strandedCheck.add(window);
        if (this._strandedIdleId)
            return;
        this._strandedIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._strandedIdleId = 0;
            const windows = [...this._strandedCheck];
            this._strandedCheck.clear();
            for (const stranded of windows)
                this._rescueStranded(stranded);
            return GLib.SOURCE_REMOVE;
        });
    }

    _rescueStranded(window) {
        const spaces = this._paperwmSpaces();
        // Leave tiled windows, windows being dragged (PaperWM moves them to
        // the display they are dropped on) and display changes to PaperWM
        if (!spaces || this._restoring || this._paperwm.inGrab ||
            !this._windowSignals.has(window) || window.is_on_all_workspaces() ||
            window.minimized || this._paperwm.isTiled(window))
            return;
        const space = spaces.spaceOfWindow(window);
        const monitor = Main.layoutManager.monitors[window.get_monitor()];
        if (!space || !monitor || spaces.monitors.get(monitor) === space)
            return;
        const target = [...spaces.monitors]
            .find(([, shown]) => shown === space)?.[0];
        if (!target)
            return;
        // Don't fight PaperWM if it puts the window back
        const now = GLib.get_monotonic_time() / 1000;
        if (now - (this._rescued.get(window) ?? -Infinity) < 2000)
            return;
        this._rescued.set(window, now);
        if (DEBUG) {
            debug(`${describe(window)}: floating on monitor ${monitor.index}, ` +
                `but its workspace ${space.index} is shown on ${target.index}`);
        }
        window.move_to_monitor(target.index);
    }

    // GNOME has one row of workspaces, and PaperWM shows one of them on
    // each display. To work the usual GNOME way, with workspaces on the
    // primary display only, each secondary display keeps one workspace of
    // its own (its "pinned" workspace): it stays in place there, GNOME's
    // workspace switching skips it, and Workspace Lanes leaves it off the
    // primary's taskbar. GNOME's dynamic workspaces would remove it as soon
    // as it is empty and keep no spare workspace after it, so it is marked
    // as kept alive, and it sits just before the spare.

    _connectorOf(monitorIndex) {
        return this._monitorManager.get_monitors()
            .map(monitor => monitor.get_connector())
            .find(connector =>
                this._monitorManager.get_monitor_for_connector(connector) === monitorIndex) ??
            null;
    }

    _workspaceExists(workspace) {
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.get_n_workspaces(); i++) {
            if (manager.get_workspace_by_index(i) === workspace)
                return true;
        }
        return false;
    }

    // The pinned workspaces while PaperWM runs, else an empty set
    _pinnedSet() {
        if (!this._pinned?.size || !this._paperwmSpaces())
            return new Set();
        return new Set(this._pinned.values());
    }

    _pin(connector, workspace) {
        if (this._pinned.get(connector) === workspace)
            return;
        this._unpin(connector);
        debug(`workspace ${workspace.index()} stays on ${connector}`);
        this._pinned.set(connector, workspace);
        this._lastPinned.set(connector, workspace);
        this._keepAlive(workspace);
        this._queuePlacePinned();
    }

    _unpin(connector) {
        const workspace = this._pinned.get(connector);
        if (!workspace)
            return;
        this._pinned.delete(connector);
        const id = this._keepAliveIds.get(workspace);
        this._keepAliveIds.delete(workspace);
        if (id && workspace._keepAliveId === id) {
            GLib.source_remove(id);
            workspace._keepAliveId = 0;
        }
        debug(`${connector} no longer keeps a workspace`);
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    // Displays unplugged, or made primary, keep no workspace: the one they
    // had stays where it is, now an ordinary workspace on the primary
    _unpinGoneDisplays() {
        const primary = global.display.get_primary_monitor();
        for (const [connector, workspace] of [...this._pinned]) {
            const index = this._monitorManager.get_monitor_for_connector(connector);
            if (index < 0 || index === primary || !this._workspaceExists(workspace))
                this._unpin(connector);
        }
    }

    // GNOME counts a workspace with a keep-alive timeout as in use. Give
    // the pinned one a timeout of ours that never fires. GNOME may replace
    // it with a short one of its own (when an app starts there), so this
    // is redone whenever the workspaces change.
    _keepAlive(workspace) {
        if (workspace._keepAliveId)
            return;
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3600,
            () => GLib.SOURCE_CONTINUE);
        workspace._keepAliveId = id;
        this._keepAliveIds.set(workspace, id);
    }

    _onPinnedOrderChanged() {
        if (this._pinned.size)
            this._queuePlacePinned();
    }

    _queuePlacePinned() {
        if (this._placeIdleId)
            return;
        this._placeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._placeIdleId = 0;
            this._placePinned();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Keep the pinned workspaces at the end of the row, before GNOME's
    // empty spare, so the primary's workspaces stay numbered from 1 with no
    // gaps; GNOME adds a new spare after the old one gets a window, which
    // would otherwise leave a pinned workspace in the middle
    _placePinned() {
        this._unpinGoneDisplays();
        const pinned = [...this._pinned.values()];
        if (!pinned.length)
            return;
        pinned.forEach(workspace => this._keepAlive(workspace));
        const manager = global.workspace_manager;
        const n = manager.get_n_workspaces();
        const last = manager.get_workspace_by_index(n - 1);
        const end = last && !pinned.includes(last) &&
            !last.list_windows().some(w => !w.is_on_all_workspaces()) ? n - 1 : n;
        pinned.sort((a, b) => a.index() - b.index());
        pinned.forEach((workspace, i) => {
            const target = end - pinned.length + i;
            if (target >= 0 && workspace.index() !== target) {
                debug(`moving pinned workspace ${workspace.index()} to ${target}`);
                manager.reorder_workspace(workspace, target);
            }
        });
    }

    // The workspace PaperWM shows on the primary display
    _primaryWorkspace() {
        const spaces = this._paperwmSpaces();
        return spaces?.monitors.get(Main.layoutManager.primaryMonitor)?.workspace ?? null;
    }

    // GNOME's workspace switching (keyboard shortcuts, scrolling, the
    // window menu) goes through get_neighbor() from the active workspace,
    // which with PaperWM is the secondary's while the pointer is over it.
    // Step from the primary's workspace instead, over pinned ones. Switching
    // or moving a window to a pinned workspace, or moving a window off one,
    // is left alone, as GNOME does for a secondary display.
    _skipPinnedWorkspaces() {
        const extension = this;
        this._injections.overrideMethod(Meta.Workspace.prototype, 'get_neighbor',
            original => function (direction) {
                const pinned = extension._pinnedSet();
                if (!pinned.size)
                    return original.call(this, direction);
                let from = this;
                if (pinned.has(from)) {
                    from = extension._primaryWorkspace();
                    if (!from || pinned.has(from))
                        return this;
                }
                for (let workspace = from; ;) {
                    const next = original.call(workspace, direction);
                    if (!next || next === workspace)
                        return from;
                    if (!pinned.has(next))
                        return next;
                    workspace = next;
                }
            });
        this._injections.overrideMethod(Main.wm, 'actionMoveWorkspace',
            original => function (workspace) {
                if (!extension._pinnedSet().has(workspace))
                    original.call(this, workspace);
            });
        this._injections.overrideMethod(Main.wm, 'actionMoveWindow',
            original => function (window, workspace) {
                const pinned = extension._pinnedSet();
                if (!pinned.has(workspace) && !pinned.has(window.get_workspace()))
                    original.call(this, window, workspace);
            });
    }

    _isEmpty(space) {
        return !space.workspace.list_windows().some(window =>
            !window.skip_taskbar && !window.is_on_all_workspaces() &&
            MOVABLE_TYPES.includes(window.get_window_type()));
    }

    // The workspace a secondary display keeps: the one it has already, or
    // had when it was last plugged in, if that is still there; else the last
    // workspace if it is empty (with dynamic workspaces that is the spare
    // GNOME keeps, and GNOME adds another), else a new one. Never one of the
    // primary's workspaces that has windows, or workspace 2 would end up on
    // the secondary display
    _spaceForSecondary(spaces, connector, used) {
        const manager = global.workspace_manager;
        const own = this._pinned.get(connector) ?? this._lastPinned.get(connector);
        if (own && this._workspaceExists(own)) {
            const space = spaces.spaceOf(own);
            if (space && !used.has(space))
                return space;
        }
        const last = spaces.spaceOfIndex(manager.get_n_workspaces() - 1);
        if (last && !used.has(last) && !this._pinnedSet().has(last.workspace) &&
            this._isEmpty(last))
            return last;
        if (Meta.prefs_get_dynamic_workspaces()) {
            manager.append_new_workspace(false, global.get_current_time());
            return spaces.spaceOfIndex(manager.get_n_workspaces() - 1) ?? null;
        }
        return null;
    }

    // Show @space on @monitor the way PaperWM does after a display change.
    // Returns false if it was already there.
    _showSpace(spaces, space, monitor) {
        const displaced = spaces.monitors.get(monitor);
        if (displaced === space && space.monitor === monitor)
            return false;

        debug(`showing workspace ${space.index} on monitor ${monitor.index}`);
        // a workspace is shown on one display at a time
        for (const [other, shown] of spaces.monitors) {
            if (shown === space && other !== monitor)
                spaces.monitors.delete(other);
        }
        spaces.setMonitors(monitor, space);
        space.setMonitor(monitor);
        space.show();
        space.clip.get_parent()?.set_child_above_sibling(space.clip, null);
        if (displaced && displaced !== space &&
            ![...spaces.monitors.values()].includes(displaced))
            displaced.hide();
        return true;
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
        const sources = new Set((this._sourceConnectors ?? [])
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
