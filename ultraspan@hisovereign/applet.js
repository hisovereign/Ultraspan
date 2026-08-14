const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Main = imports.ui.main;
const Gettext = imports.gettext;
const Tooltips = imports.ui.tooltips;

let UUID = "ultraspan@hisovereign";

const HOME = GLib.get_home_dir();
const USER_DATA_DIR = GLib.get_user_data_dir();
const USER_CONFIG_DIR = GLib.get_user_config_dir();
const USER_CACHE_DIR = GLib.get_user_cache_dir();
const USER_BIN_DIR = HOME + "/.local/bin";

const SCRIPT_PATH = GLib.build_filenamev([USER_BIN_DIR, "ultraspan"]);
const RANDOM_FOLDER = GLib.build_filenamev([HOME, "Pictures", "ultraspan"]);
const CONFIG_DIR = GLib.build_filenamev([USER_CONFIG_DIR, "ultraspan"]);

const LOCALE_DIR = GLib.build_filenamev([USER_DATA_DIR, "locale"]);
Gettext.bindtextdomain(UUID, LOCALE_DIR);

function _(text) {
    return Gettext.dgettext(UUID, text);
}

class UltraspanApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.set_applet_icon_symbolic_name("preferences-desktop-wallpaper");
        this.set_applet_tooltip(_("Ultraspan"));

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        this._menuTimer = null;
        this._stageSignalId = null;
        this._timeoutIds = [];

        // Slider & switch references
        this._blurSlider = null;
        this._randomIntervalSlider = null;
        this._refreshIntervalSlider = null;
        this._multiRandomSwitch = null;

        // Tooltip references
        this._blurTooltip = null;
        this._randomTooltip = null;
        this._refreshTooltip = null;

        // Toggle groups
        this._modeSwitches = {};
        this._bgTypeSwitches = {};

        this._refreshStartStopItem = null;

        this._addCustomStyles();
        this._buildMenu();

        this._originalAllocate = null;
        this._protectFromBlur();

        // Auto-start refresh if previously active
        this._autoStartRefreshIfNeeded();
    }

    on_applet_removed_from_panel() {
        if (this._menuTimer) { clearInterval(this._menuTimer); this._menuTimer = null; }
        if (this._stageSignalId) { global.stage.disconnect(this._stageSignalId); this._stageSignalId = null; }
        this._timeoutIds.forEach(id => clearTimeout(id));
        this._timeoutIds = [];
        if (this.menu) { this.menu.destroy(); this.menu = null; }
        if (this.menuManager) { this.menuManager = null; }
    }

    _setTimeout(callback, delay) {
        let id = setTimeout(() => {
            let index = this._timeoutIds.indexOf(id);
            if (index > -1) this._timeoutIds.splice(index, 1);
            callback();
        }, delay);
        this._timeoutIds.push(id);
        return id;
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    _addCustomStyles() {
        const css = `
            .ultraspan-submenu { max-width: 250px !important; min-width: 200px !important; }
            .ultraspan-filename { max-width: 230px; min-width: 180px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
            .ultraspan-header { font-weight: bold; color: #555; }
        `;
        try { const style = new St.StyleSheet(); style.from_string(css); this.actor.add_style(style); } catch(e) {}
    }

    _protectFromBlur() {
        let applet = this;

        function isOurMenu(menu) {
            try {
                let parent = menu.actor;
                while (parent) {
                    if (parent._delegate && parent._delegate._applet === applet) return true;
                    parent = parent.get_parent();
                }
            } catch (e) {}
            return false;
        }

        let processMenus = () => {
            try {
                let menus = [];
                let findMenus = (actor) => {
                    if (actor instanceof PopupMenu.PopupMenu) menus.push(actor);
                    let children = actor.get_children();
                    if (children) children.forEach(findMenus);
                };
                findMenus(Main.uiGroup);

                menus.forEach(menu => {
                    if (!isOurMenu(menu)) return;
                    if (!applet._originalAllocate && menu.actor.allocate) {
                        applet._originalAllocate = menu.actor.allocate;
                        menu.actor.allocate = function(box, flags) {
                            applet._originalAllocate.call(this, box, flags);
                            if (this instanceof St.ScrollView) {
                                this.queue_relayout();
                                let vscroll = this.get_vscroll_bar();
                                if (vscroll) vscroll.queue_relayout();
                            }
                        };
                    }
                    let fixScrollView = (actor) => {
                        if (actor instanceof St.ScrollView) {
                            actor.set_style('overflow-y: auto; max-height: 400px;');
                            actor.queue_relayout();
                        }
                        let children = actor.get_children();
                        if (children) children.forEach(fixScrollView);
                    };
                    fixScrollView(menu.actor);
                });
            } catch (e) {
                global.log("Error in processMenus: " + e);
            }
        };

        processMenus();
        this._menuTimer = setInterval(processMenus, 500);
        this._stageSignalId = global.stage.connect('notify::focus-key', () => {
            this._setTimeout(processMenus, 50);
        });
    }

    _forceSubmenuStyles(menu) {
        menu.connect('open-state-changed', (subMenu, open) => {
            if (open) {
                [10, 50, 100, 200].forEach(delay => {
                    this._setTimeout(() => {
                        try {
                            let actor = subMenu.actor;
                            if (actor instanceof imports.gi.St.ScrollView) {
                                let [width, height] = actor.get_size();
                                actor.set_height(-1);
                                actor.set_width(-1);
                                actor.queue_relayout();
                                this._setTimeout(() => {
                                    actor.set_height(height);
                                    actor.set_width(width);
                                    actor.queue_relayout();
                                    let vscroll = actor.get_vscroll_bar();
                                    if (vscroll) vscroll.queue_relayout();
                                }, 5);
                            }
                            let parent = actor.get_parent();
                            while (parent) {
                                parent.queue_relayout();
                                parent = parent.get_parent();
                            }
                        } catch (e) {
                            global.log("Error forcing allocation: " + e);
                        }
                    }, delay);
                });
            }
        });
    }

    _autoStartRefreshIfNeeded() {
        const refreshFile = GLib.build_filenamev([CONFIG_DIR, "refresh"]);
        if (GLib.file_test(refreshFile, GLib.FileTest.EXISTS)) {
            this._readConfigAsync((cfg) => {
                let interval = cfg.refresh_interval || 480;
                this._runCommandInBackground(["refresh-start", interval.toString()]);
            });
        }
    }

    _buildMenu() {
        this.menu.removeAll();

        this._addFolderSubMenu();
        this._addPerMonitorSubMenu();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addSettingsSubMenu();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addRefreshControl();
        this._addRandomControl();

        let refreshMenuItem = new PopupMenu.PopupMenuItem("⟳ " + _("Refresh menu"));
        refreshMenuItem.connect('activate', () => { this._rebuildMenu(); });
        this.menu.addMenuItem(refreshMenuItem);
    }

    _rebuildMenu() {
        this._buildMenu();
        this.menu.open();
    }

    /* ---------------- Folder submenu (unchanged) ---------------- */
    _addFolderSubMenu() {
        const folderItem = new PopupMenu.PopupSubMenuMenuItem(_("Set wallpaper"));
        this._forceSubmenuStyles(folderItem);
        folderItem.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(folderItem);

        let folder = Gio.File.new_for_path(RANDOM_FOLDER);
        folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                obj.query_info_finish(res);
                this._getImagesFromFolderAsync(RANDOM_FOLDER, 999, (images) => {
                    this._populateFolderMenu(folderItem, images);
                });
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    const noFolderItem = new PopupMenu.PopupMenuItem(_("Folder does not exist"));
                    noFolderItem.setSensitive(false);
                    folderItem.menu.addMenuItem(noFolderItem);
                    const createItem = new PopupMenu.PopupMenuItem(_("Create folder"));
                    createItem.connect("activate", () => {
                        GLib.mkdir_with_parents(RANDOM_FOLDER, 0o755);
                        this._setTimeout(() => this._rebuildMenu(), 300);
                    });
                    folderItem.menu.addMenuItem(createItem);
                } else { global.logError("Error checking folder: " + e); }
            }
        });
    }

    _populateFolderMenu(folderItem, images) {
        if (images.length === 0) {
            const noImagesItem = new PopupMenu.PopupMenuItem(_("No images found"));
            noImagesItem.setSensitive(false);
            noImagesItem.actor.add_style_class_name('ultraspan-header');
            folderItem.menu.addMenuItem(noImagesItem);
            const openItem = new PopupMenu.PopupMenuItem(_("Open folder to add images"));
            openItem.connect("activate", () => { this._openFolderInFileManager(RANDOM_FOLDER); });
            folderItem.menu.addMenuItem(openItem);
        } else {
            const countItem = new PopupMenu.PopupMenuItem(_("%d images found").format(images.length));
            countItem.setSensitive(false);
            countItem.actor.add_style_class_name('ultraspan-header');
            folderItem.menu.addMenuItem(countItem);
            images.forEach(image => {
                const item = new PopupMenu.PopupMenuItem(this._truncateName(image.name, 25));
                item.actor.add_style_class_name('ultraspan-filename');
                item.connect("activate", () => { this._setWallpaper(image.path); });
                folderItem.menu.addMenuItem(item);
            });
            folderItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const openFolderItem = new PopupMenu.PopupMenuItem(_("Open folder"));
            openFolderItem.connect("activate", () => { this._openFolderInFileManager(RANDOM_FOLDER); });
            folderItem.menu.addMenuItem(openFolderItem);
        }
    }

    /* ---------------- Per-monitor submenu (unchanged) ---------------- */
    _addPerMonitorSubMenu() {
        const perMonitorItem = new PopupMenu.PopupSubMenuMenuItem(_("Set per‑monitor"));
        this._forceSubmenuStyles(perMonitorItem);
        perMonitorItem.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(perMonitorItem);

        this._getMonitorInfoAsync((monitors) => {
            perMonitorItem.menu.removeAll();
            if (monitors.length === 0) {
                let err = new PopupMenu.PopupMenuItem(_("Could not detect monitors"));
                err.setSensitive(false);
                perMonitorItem.menu.addMenuItem(err);
                return;
            }

            let folder = Gio.File.new_for_path(RANDOM_FOLDER);
            folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
                try {
                    obj.query_info_finish(res);
                    this._getImagesFromFolderAsync(RANDOM_FOLDER, 999, (images) => {
                        perMonitorItem.menu.removeAll();
                        if (images.length === 0) {
                            let noImg = new PopupMenu.PopupMenuItem(_("No images found"));
                            noImg.setSensitive(false);
                            perMonitorItem.menu.addMenuItem(noImg);
                            return;
                        }

                        let listHeader = new PopupMenu.PopupMenuItem(_("Images (use numbers below)"));
                        listHeader.setSensitive(false);
                        listHeader.actor.add_style_class_name('ultraspan-header');
                        perMonitorItem.menu.addMenuItem(listHeader);

                        images.forEach((img, idx) => {
                            let label = (idx+1) + ". " + this._truncateName(img.name, 25);
                            let item = new PopupMenu.PopupMenuItem(label);
                            item.setSensitive(false);
                            perMonitorItem.menu.addMenuItem(item);
                        });

                        perMonitorItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                        let entries = [];
                        monitors.forEach((name, i) => {
                            let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
                            let box = new St.BoxLayout({ vertical: false });
                            let lbl = new St.Label({ text: _("Monitor %d (%s): ").format(i+1, name) });
                            box.add(lbl);
                            let entry = new St.Entry({ text: "", style_class: "popup-menu-item", can_focus: true, reactive: true });
                            entry.clutter_text.set_single_line_mode(true);
                            entry.clutter_text.set_width(30);
                            box.add(entry);
                            item.addActor(box);
                            perMonitorItem.menu.addMenuItem(item);
                            entries.push(entry);
                        });

                        perMonitorItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                        let applyButton = new PopupMenu.PopupMenuItem(_("Apply per‑monitor"));
                        applyButton.connect('activate', () => {
                            let chosen = [];
                            let valid = true;
                            for (let i = 0; i < entries.length; i++) {
                                let num = parseInt(entries[i].text);
                                if (isNaN(num) || num < 1 || num > images.length) {
                                    valid = false;
                                    break;
                                }
                                chosen.push(images[num-1].path);
                            }
                            if (valid && chosen.length === monitors.length) {
                                this._readConfigAsync((cfg) => {
                                    let mode = cfg.mode || 'zoom';
                                    let args = ['set-per-monitor'].concat(chosen, mode);
                                    this._runCommandInBackground(args);
                                    this.menu.close();
                                });
                            } else {
                                Main.notify(_("Invalid selection"), _("Please enter valid image numbers for each monitor."));
                            }
                        });
                        perMonitorItem.menu.addMenuItem(applyButton);
                    });
                } catch (e) {
                    let err = new PopupMenu.PopupMenuItem(_("Folder error"));
                    err.setSensitive(false);
                    perMonitorItem.menu.addMenuItem(err);
                }
            });
        });
    }

    /* ---------------- Settings submenu (toggles for mode/bg) ---------------- */
    _addSettingsSubMenu() {
        this.settingsSubmenu = new PopupMenu.PopupSubMenuMenuItem(_("Settings"));
        this._forceSubmenuStyles(this.settingsSubmenu);
        this.settingsSubmenu.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(this.settingsSubmenu);

        // Read config and populate
        this._readConfigAsync((currentConfig) => {
            let menu = this.settingsSubmenu.menu;
            menu.removeAll();

            // ---- Wallpaper Mode (mutually exclusive switches) ----
            let modeHeader = new PopupMenu.PopupMenuItem(_("Wallpaper Mode"));
            modeHeader.setSensitive(false);
            modeHeader.actor.add_style_class_name('ultraspan-header');
            menu.addMenuItem(modeHeader);

            const modes = ["zoom", "fit", "center"];
            this._modeSwitches = {};
            modes.forEach(mode => {
                let switchItem = new PopupMenu.PopupSwitchMenuItem(
                    _(mode.charAt(0).toUpperCase() + mode.slice(1)),
                    currentConfig.mode === mode
                );
                switchItem.connect('toggled', (item, state) => {
                    if (!state) return;
                    this._runCommandInBackground(["mode", mode]);
                    modes.forEach(m => {
                        if (m !== mode && this._modeSwitches[m]) {
                            this._modeSwitches[m].setToggleState(false);
                        }
                    });
                });
                this._modeSwitches[mode] = switchItem;
                menu.addMenuItem(switchItem);
            });

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Background Type (mutually exclusive switches) ----
            let bgHeader = new PopupMenu.PopupMenuItem(_("Background Type"));
            bgHeader.setSensitive(false);
            bgHeader.actor.add_style_class_name('ultraspan-header');
            menu.addMenuItem(bgHeader);

            const bgTypes = ["blur", "solid"];
            this._bgTypeSwitches = {};
            bgTypes.forEach(type => {
                let switchItem = new PopupMenu.PopupSwitchMenuItem(
                    _(type.charAt(0).toUpperCase() + type.slice(1)),
                    currentConfig.bg_type === type
                );
                switchItem.connect('toggled', (item, state) => {
                    if (!state) return;
                    this._runCommandInBackground(["bg-type", type]);
                    bgTypes.forEach(t => {
                        if (t !== type && this._bgTypeSwitches[t]) {
                            this._bgTypeSwitches[t].setToggleState(false);
                        }
                    });
                });
                this._bgTypeSwitches[type] = switchItem;
                menu.addMenuItem(switchItem);
            });

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Blur Amount slider ----
            let blurHeader = new PopupMenu.PopupMenuItem(_("Blur Amount"));
            blurHeader.setSensitive(false);
            blurHeader.actor.add_style_class_name('ultraspan-header');
            menu.addMenuItem(blurHeader);

            this._blurSlider = new PopupMenu.PopupSliderMenuItem(currentConfig.blur / 100);
            let blurLabel = this._blurSlider.actor.get_children()[0];
            blurLabel.text = _("Blur: ") + currentConfig.blur;
            this._blurTooltip = new Tooltips.Tooltip(this._blurSlider.actor, _("Blur: ") + currentConfig.blur);
            this._blurSlider.connect('value-changed', (item) => {
                let val = Math.round(item._value * 100);
                blurLabel.text = _("Blur: ") + val;
                this._blurTooltip.set_text(_("Blur: ") + val);
                this._runCommandInBackground(["blur", val.toString()]);
            });
            menu.addMenuItem(this._blurSlider);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Random Interval slider ----
            let randHeader = new PopupMenu.PopupMenuItem(_("Random Interval"));
            randHeader.setSensitive(false);
            randHeader.actor.add_style_class_name('ultraspan-header');
            menu.addMenuItem(randHeader);
            let randVal = currentConfig.random_interval || 30;
            this._randomIntervalSlider = new PopupMenu.PopupSliderMenuItem((randVal - 1) / 119);
            let randLabel = this._randomIntervalSlider.actor.get_children()[0];
            randLabel.text = _("Random: ") + randVal + " min";
            this._randomTooltip = new Tooltips.Tooltip(this._randomIntervalSlider.actor, _("Random: ") + randVal + " min");
            this._randomIntervalSlider.connect('value-changed', (item) => {
                let minutes = Math.max(1, Math.round(item._value * 119 + 1));
                randLabel.text = _("Random: ") + minutes + " min";
                this._randomTooltip.set_text(_("Random: ") + minutes + " min");
                this._runCommandInBackground(["interval", minutes.toString()]);
            });
            menu.addMenuItem(this._randomIntervalSlider);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Refresh Interval slider ----
            let refHeader = new PopupMenu.PopupMenuItem(_("Refresh Interval"));
            refHeader.setSensitive(false);
            refHeader.actor.add_style_class_name('ultraspan-header');
            menu.addMenuItem(refHeader);
            let currentMins = currentConfig.refresh_interval || 480;
            this._refreshIntervalSlider = new PopupMenu.PopupSliderMenuItem((currentMins - 60) / 1380);
            let refLabel = this._refreshIntervalSlider.actor.get_children()[0];
            let hours = Math.floor(currentMins / 60);
            let labelText = hours + " h";
            if (currentMins % 60 > 0) labelText += " " + (currentMins % 60) + " min";
            refLabel.text = _("Refresh: ") + labelText;
            this._refreshTooltip = new Tooltips.Tooltip(this._refreshIntervalSlider.actor, _("Refresh: ") + labelText);
            this._refreshIntervalSlider.connect('value-changed', (item) => {
                let mins = Math.max(60, Math.round(item._value * 1380 + 60));
                hours = Math.floor(mins / 60);
                labelText = hours + " h";
                if (mins % 60 > 0) labelText += " " + (mins % 60) + " min";
                refLabel.text = _("Refresh: ") + labelText;
                this._refreshTooltip.set_text(_("Refresh: ") + labelText);
                this._runCommandInBackground(["set-config", "refresh_interval", mins.toString()]);
                const refreshFile = GLib.build_filenamev([CONFIG_DIR, "refresh"]);
                if (GLib.file_test(refreshFile, GLib.FileTest.EXISTS)) {
                    this._runCommandInBackground(["refresh-start", mins.toString()]);
                }
            });
            menu.addMenuItem(this._refreshIntervalSlider);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Multi-monitor random toggle ----
            this._multiRandomSwitch = new PopupMenu.PopupSwitchMenuItem(_("Multi‑monitor random"), currentConfig.multi_random);
            this._multiRandomSwitch.connect('toggled', (item, state) => {
                this._runCommandInBackground(["set-config", "multi_random", state ? "true" : "false"]);
            });
            menu.addMenuItem(this._multiRandomSwitch);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // ---- Clear cache ----
            let clearCacheItem = new PopupMenu.PopupMenuItem(_("Clear cache"));
            clearCacheItem.connect('activate', () => {
                this._runCommandInBackground(["clean"]);
                this._setTimeout(() => {
                    const statePath = GLib.build_filenamev([CONFIG_DIR, "state"]);
                    let stateFile = Gio.File.new_for_path(statePath);
                    stateFile.load_contents_async(null, (obj, res) => {
                        try {
                            let [success, contents] = obj.load_contents_finish(res);
                            if (success) {
                                const lines = contents.toString().split('\n');
                                const lastImage = lines[0];
                                let imageFile = Gio.File.new_for_path(lastImage);
                                imageFile.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj2, res2) => {
                                    try { obj2.query_info_finish(res2); this._setWallpaper(lastImage); } catch(e) {}
                                });
                            }
                        } catch(e) {}
                    });
                }, 500);
            });
            menu.addMenuItem(clearCacheItem);
        });
    }

    /* ---------------- Refresh control ---------------- */
    _addRefreshControl() {
        const refreshFile = GLib.build_filenamev([CONFIG_DIR, "refresh"]);
        if (GLib.file_test(refreshFile, GLib.FileTest.EXISTS)) {
            this._refreshStartStopItem = new PopupMenu.PopupMenuItem("⏹️ " + _("Stop Refresh"));
            this._refreshStartStopItem.connect('activate', () => {
                this._runCommandInBackground(["refresh-stop"]);
                this._swapRefreshButton(false);
            });
        } else {
            this._refreshStartStopItem = new PopupMenu.PopupMenuItem("▶️ " + _("Start Refresh"));
            this._refreshStartStopItem.connect('activate', () => {
                this._readConfigAsync((cfg) => {
                    let interval = cfg.refresh_interval || 480;
                    this._runCommandInBackground(["refresh-start", interval.toString()]);
                    this._swapRefreshButton(true);
                });
            });
        }
        this.menu.addMenuItem(this._refreshStartStopItem);
    }

    _swapRefreshButton(isRunning) {
        if (!this._refreshStartStopItem) return;
        let parent = this._refreshStartStopItem._parent;
        if (parent) parent.removeMenuItem(this._refreshStartStopItem);
        else this.menu.box.remove_actor(this._refreshStartStopItem.actor);

        if (isRunning) {
            this._refreshStartStopItem = new PopupMenu.PopupMenuItem("⏹️ " + _("Stop Refresh"));
            this._refreshStartStopItem.connect('activate', () => {
                this._runCommandInBackground(["refresh-stop"]);
                this._swapRefreshButton(false);
            });
        } else {
            this._refreshStartStopItem = new PopupMenu.PopupMenuItem("▶️ " + _("Start Refresh"));
            this._refreshStartStopItem.connect('activate', () => {
                this._readConfigAsync((cfg) => {
                    let interval = cfg.refresh_interval || 480;
                    this._runCommandInBackground(["refresh-start", interval.toString()]);
                    this._swapRefreshButton(true);
                });
            });
        }
        this.menu.addMenuItem(this._refreshStartStopItem);
    }

    /* ---------------- Random control ---------------- */
    _addRandomControl() {
        const randomFile = GLib.build_filenamev([CONFIG_DIR, "random"]);
        let file = Gio.File.new_for_path(randomFile);
        file.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                obj.query_info_finish(res);
                const stopItem = new PopupMenu.PopupMenuItem("⏹️ " + _("Stop Random Rotation"));
                stopItem.connect("activate", () => {
                    this._runCommandInBackground(["random-stop"]);
                    this._setTimeout(() => this._rebuildMenu(), 100);
                });
                this.menu.addMenuItem(stopItem);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    const startItem = new PopupMenu.PopupMenuItem("▶️ " + _("Start Random Rotation"));
                    startItem.connect("activate", () => {
                        let folder = Gio.File.new_for_path(RANDOM_FOLDER);
                        folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj2, res2) => {
                            try {
                                obj2.query_info_finish(res2);
                                this._readConfigAsync((currentConfig) => {
                                    let mode = currentConfig.mode || 'zoom';
                                    let cmd = currentConfig.multi_random ? "random-multi" : "random";
                                    this._runCommandInBackground([cmd, RANDOM_FOLDER, mode]);
                                    this._setTimeout(() => this._rebuildMenu(), 100);
                                });
                            } catch (e) {
                                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                                    GLib.mkdir_with_parents(RANDOM_FOLDER, 0o755);
                                    this._readConfigAsync((currentConfig) => {
                                        let mode = currentConfig.mode || 'zoom';
                                        let cmd = currentConfig.multi_random ? "random-multi" : "random";
                                        this._runCommandInBackground([cmd, RANDOM_FOLDER, mode]);
                                        this._setTimeout(() => this._rebuildMenu(), 100);
                                    });
                                }
                            }
                        });
                    });
                    this.menu.addMenuItem(startItem);
                }
            }
        });
    }

    /* ---------------- Async helpers (unchanged) ---------------- */
    _getMonitorInfoAsync(callback) {
        try {
            let [ok, stdout] = GLib.spawn_sync(null, ['xrandr', '--listmonitors'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            if (!ok) { callback([]); return; }
            let lines = stdout.toString().split('\n');
            let monitors = [];
            for (let i = 1; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line === '') continue;
                let parts = line.split(/\s+/);
                if (parts.length >= 2) monitors.push(parts[parts.length-1]);
            }
            callback(monitors);
        } catch (e) { callback([]); }
    }

    _readConfigAsync(callback) {
        let config = {
            mode: 'zoom',
            bg_type: 'blur',
            blur: 15,
            random_interval: 30,
            refresh_interval: 480,
            multi_random: false
        };
        const configPath = GLib.build_filenamev([CONFIG_DIR, "config"]);
        let configFile = Gio.File.new_for_path(configPath);
        configFile.load_contents_async(null, (obj, res) => {
            try {
                let [success, contents] = obj.load_contents_finish(res);
                if (success) {
                    let lines = contents.toString().split('\n');
                    lines.forEach(line => {
                        line = line.trim();
                        if (line.includes('=')) {
                            let [key, value] = line.split('=', 2);
                            key = key.trim(); value = value.trim();
                            if (key === 'blur' || key === 'random_interval' || key === 'refresh_interval')
                                config[key] = parseInt(value, 10);
                            else if (key === 'multi_random')
                                config[key] = (value === 'true');
                            else if (value)
                                config[key] = value;
                        }
                    });
                }
            } catch(e) { global.logError("Error reading config: " + e); }
            callback(config);
        });
    }

    _getImagesFromFolderAsync(folderPath, maxCount, callback) {
        const images = [];
        let dir = Gio.File.new_for_path(folderPath);
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                let enumerator = obj.enumerate_children_finish(res);
                this._enumerateNextAsync(enumerator, folderPath, images, maxCount, callback);
            } catch(e) { global.logError("Error enumerating directory: " + e); callback(images); }
        });
    }

    _enumerateNextAsync(enumerator, folderPath, images, maxCount, callback) {
        enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                let files = obj.next_files_finish(res);
                if (files === null || files.length === 0 || images.length >= maxCount) {
                    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                    images.sort((a,b) => a.name.localeCompare(b.name));
                    callback(images);
                    return;
                }
                files.forEach(fileInfo => {
                    if (images.length >= maxCount) return;
                    const fileName = fileInfo.get_name();
                    if (/\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
                        const filePath = GLib.build_filenamev([folderPath, fileName]);
                        let file = Gio.File.new_for_path(filePath);
                        file.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj2, res2) => {
                            try { obj2.query_info_finish(res2); images.push({ name: fileName, path: filePath }); } catch(e) {}
                        });
                    }
                });
                this._enumerateNextAsync(enumerator, folderPath, images, maxCount, callback);
            } catch(e) { global.logError("Error reading files: " + e); callback(images); }
        });
    }

    _runCommandInBackground(args) {
        let scriptFile = Gio.File.new_for_path(SCRIPT_PATH);
        scriptFile.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                obj.query_info_finish(res);
                this._setTimeout(() => {
                    try {
                        let [success, pid] = GLib.spawn_async(
                            null,
                            [SCRIPT_PATH].concat(args),
                            null,
                            GLib.SpawnFlags.SEARCH_PATH,
                            null
                        );
                        if (success) {
                            GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
                                GLib.spawn_close_pid(pid);
                                return false;
                            });
                        } else {
                            global.logError("Failed to spawn ultraspan command: " + args.join(" "));
                        }
                    } catch (e) {
                        global.logError("Error running command: " + e);
                    }
                }, 10);
            } catch (e) {}
        });
    }

    _setWallpaper(imagePath) {
        this._readConfigAsync((cfg) => {
            let mode = cfg.mode || 'zoom';
            this._runCommandInBackground(["set", imagePath, mode]);
        });
    }

    _openFolderInFileManager(folderPath) {
        try {
            let [success, pid] = GLib.spawn_async(
                null,
                ['xdg-open', folderPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            if (success) {
                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
                    GLib.spawn_close_pid(pid);
                    return false;
                });
            }
        } catch (e) {
            global.logError("Error opening folder: " + e);
        }
    }

    _truncateName(name, maxLength) {
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength - 3) + "...";
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new UltraspanApplet(metadata, orientation, panelHeight, instanceId);
}
