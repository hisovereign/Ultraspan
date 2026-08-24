const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Main = imports.ui.main;
const Gettext = imports.gettext;
const Tooltips = imports.ui.tooltips;
const Gtk = imports.gi.Gtk;

let UUID = "ultraspan@hisovereign";

const HOME = GLib.get_home_dir();
const USER_DATA_DIR = GLib.get_user_data_dir();
const USER_CONFIG_DIR = GLib.get_user_config_dir();
const USER_BIN_DIR = HOME + "/.local/bin";

let scriptPath = GLib.find_program_in_path("ultraspan");
if (!scriptPath) {
    scriptPath = GLib.build_filenamev([USER_BIN_DIR, "ultraspan"]);
}
const SCRIPT_PATH = scriptPath;
const RANDOM_FOLDER = GLib.build_filenamev([HOME, "Pictures", "ultraspan"]);
const CONFIG_DIR = GLib.build_filenamev([USER_CONFIG_DIR, "ultraspan"]);
const DAEMON_PID_FILE = GLib.build_filenamev([GLib.get_user_runtime_dir(), "ultraspan", "daemon.pid"]);

const LOCALE_DIR = GLib.build_filenamev([USER_DATA_DIR, "locale"]);
Gettext.bindtextdomain(UUID, LOCALE_DIR);

function _(text) {
    return Gettext.dgettext(UUID, text);
}

class UltraspanApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._destroyed = false;
        this._assert(!this._destroyed, "Applet already destroyed");


        let iconName = "preferences-desktop-wallpaper-symbolic";
        if (!Gtk.IconTheme.get_default().has_icon(iconName)) {
            iconName = "image-x-generic-symbolic";
        }
        this.set_applet_icon_symbolic_name(iconName);
        this.set_applet_tooltip(_("Ultraspan"));
        // Accessibility: name the applet icon
        this.actor.accessible_name = _("Ultraspan wallpaper manager");
        this.actor.accessible_description = _("Control your multi‑monitor wallpaper settings");

        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

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

        this._buildMenu();
    }

    on_applet_removed_from_panel() {
        this._assert(!this._destroyed, "Already removed");
        this._destroyed = true;
        this._timeoutIds.forEach(id => clearTimeout(id));
        this._timeoutIds = [];
        if (this.menu) {
            this.menu.destroy();
            this.menu = null;
        }
        if (this.menuManager) {
            this.menuManager = null;
        }
    }

    _assert(condition, message) {
        if (!condition) {
            global.logError("UltraspanApplet assertion failed: " + message);
        }
    }

    _setTimeout(callback, delay) {
        let id = setTimeout(() => {
            let index = this._timeoutIds.indexOf(id);
            if (index > -1) {
                this._timeoutIds.splice(index, 1);
            }
            callback();
        }, delay);
        this._timeoutIds.push(id);
        return id;
    }

    on_applet_clicked() {
        this._assert(!this._destroyed, "Applet destroyed");
        if (!this._destroyed && this.menu) {
            this.menu.toggle();
        }
    }

    _forceSubmenuStyles(menu) {
        menu.connect('open-state-changed', (subMenu, open) => {
            if (open) {
                this._scheduleSubmenuStyleFix(subMenu);
            }
        });
    }

    _scheduleSubmenuStyleFix(subMenu) {
        const delays = [10, 50, 100, 200];
        for (let i = 0; i < delays.length; i++) {
            let delay = delays[i];
            this._setTimeout(() => this._applySubmenuStyleFix(subMenu), delay);
        }
        // Focus trap: move focus to first interactive child
        this._setTimeout(() => {
            let actor = subMenu.actor;
            let firstChild = actor.get_first_child();
            while (firstChild) {
                if (firstChild.can_focus && firstChild.reactive) {
                    firstChild.grab_key_focus();
                    break;
                }
                firstChild = firstChild.get_next_sibling();
            }
        }, 100);
    }

    _applySubmenuStyleFix(subMenu) {
        try {
            let actor = subMenu.actor;
            if (actor instanceof imports.gi.St.ScrollView) {
                this._fixScrollViewSize(actor);
            }
            this._relayoutActorParents(actor);
        } catch (e) {
            global.log("Error forcing allocation: " + e);
        }
    }

    _fixScrollViewSize(actor) {
        let [width, height] = actor.get_size();
        actor.set_height(-1);
        actor.set_width(-1);
        actor.queue_relayout();
        this._setTimeout(() => this._restoreScrollViewSize(actor, width, height), 5);
    }

    _restoreScrollViewSize(actor, width, height) {
        actor.set_height(height);
        actor.set_width(width);
        actor.queue_relayout();
        let vscroll = actor.get_vscroll_bar();
        if (vscroll) {
            vscroll.queue_relayout();
        }
    }

    _relayoutActorParents(actor) {
        let depth = 0;
        const MAX_DEPTH = 100;
        let parent = actor.get_parent();
        while (parent && depth < MAX_DEPTH) {
            parent.queue_relayout();
            parent = parent.get_parent();
            depth++;
        }
        this._assert(depth < MAX_DEPTH, "Actor tree too deep");
    }

    _isDaemonRunning(callback) {
        this._assert(typeof callback === 'function', "callback must be function");
        this._assert(!this._destroyed, "Applet destroyed");

        let file = Gio.File.new_for_path(DAEMON_PID_FILE);
        file.load_contents_async(null, (obj, res) => {
            try {
                let [ok, contents] = obj.load_contents_finish(res);
                if (!ok) {
                    callback(false);
                    return;
                }
                this._handleDaemonPidContents(contents, callback);
            } catch (e) {
                void e;
                callback(false);
            }
        });
    }

    _handleDaemonPidContents(contents, callback) {
        let pid = parseInt(contents.toString().trim(), 10);
        if (isNaN(pid) || pid <= 0) {
            callback(false);
            return;
        }
        this._checkProcessExists(pid, callback);
    }

    _checkProcessExists(pid, callback) {
        this._assert(typeof pid === 'number' && pid > 0, "Invalid PID");
        this._assert(typeof callback === 'function', "callback must be function");

        const procFile = Gio.File.new_for_path('/proc/' + pid);
        procFile.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                try {
                    obj.query_info_finish(res);
                    callback(true);
                } catch (e) {
                    global.log("UltraspanApplet: daemon process check failed: " + e);
                    callback(false);
                }
            });
    }

    _buildMenu() {
        this._assert(!this._destroyed, "Applet destroyed");
        this._assert(this.menu !== null, "Menu not created");

        this.menu.removeAll();

        this._addFolderSubMenu();
        this._addPerMonitorSubMenu();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addSettingsSubMenu();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addDaemonControl();
        this._addRandomControl();

        let refreshMenuItem = new PopupMenu.PopupMenuItem("⟳ " + _("Refresh menu"));
        refreshMenuItem.actor.accessible_name = _("Refresh menu");
        refreshMenuItem.actor.accessible_description = _("Rebuild the applet menu to reflect latest settings");
        refreshMenuItem.connect('activate', () => {
            this._rebuildMenu();
        });
        this.menu.addMenuItem(refreshMenuItem);
    }

    _rebuildMenu() {
        this._buildMenu();
        if (this.menu) {
            this.menu.open();
        }
    }

    /* ---------------- Folder submenu ---------------- */
    _addFolderSubMenu() {
        const folderItem = new PopupMenu.PopupSubMenuMenuItem(_("Set wallpaper"));
        folderItem.actor.accessible_name = _("Set wallpaper from folder");
        folderItem.actor.accessible_description = _("Choose an image from your wallpaper folder to set as wallpaper");
        this._forceSubmenuStyles(folderItem);
        folderItem.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(folderItem);

        let folder = Gio.File.new_for_path(RANDOM_FOLDER);
        folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                try {
                    obj.query_info_finish(res);
                    this._getImagesFromFolderAsync(RANDOM_FOLDER, 999, (images) => {
                        this._populateFolderMenu(folderItem, images);
                    });
                } catch (e) {
                    this._handleFolderQueryError(folderItem, e);
                }
            });
    }

    _handleFolderQueryError(folderItem, error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            const noFolderItem = new PopupMenu.PopupMenuItem(_("Folder does not exist"));
            noFolderItem.setSensitive(false);
            noFolderItem.actor.accessible_name = _("Wallpaper folder does not exist");
            folderItem.menu.addMenuItem(noFolderItem);

            const createItem = new PopupMenu.PopupMenuItem(_("Create folder"));
            createItem.actor.accessible_name = _("Create wallpaper folder");
            createItem.actor.accessible_description = _("Create the default wallpaper folder and open it");
            createItem.connect("activate", () => {
                this._ensureFolderExistsAsync(RANDOM_FOLDER, () => {
                    this._setTimeout(() => this._rebuildMenu(), 300);
                });
            });
            folderItem.menu.addMenuItem(createItem);
        } else {
            global.logError("Error checking folder: " + error);
            const errorItem = new PopupMenu.PopupMenuItem(_("Folder error"));
            errorItem.setSensitive(false);
            errorItem.actor.accessible_name = _("Folder error");
            folderItem.menu.addMenuItem(errorItem);
        }
    }

    _ensureFolderExistsAsync(folderPath, callback) {
        this._assert(typeof folderPath === 'string', "folderPath must be string");
        this._assert(typeof callback === 'function', "callback must be function");

        let dir = Gio.File.new_for_path(folderPath);
        dir.make_directory_with_parents_async(null, (obj, res) => {
            try {
                obj.make_directory_with_parents_finish(res);
                callback();
            } catch (e) {
                global.logError("Error creating folder: " + e);
                callback();
            }
        });
    }

    _populateFolderMenu(folderItem, images) {
        this._assert(folderItem instanceof PopupMenu.PopupSubMenuMenuItem, "Invalid folderItem");
        this._assert(Array.isArray(images), "Images must be array");

        if (images.length === 0) {
            const noImagesItem = new PopupMenu.PopupMenuItem(_("No images found"));
            noImagesItem.setSensitive(false);
            noImagesItem.actor.add_style_class_name('ultraspan-header');
            noImagesItem.actor.accessible_name = _("No images found");
            folderItem.menu.addMenuItem(noImagesItem);

            const openItem = new PopupMenu.PopupMenuItem(_("Open folder to add images"));
            openItem.actor.accessible_name = _("Open folder");
            openItem.actor.accessible_description = _("Open the wallpaper folder in your file manager");
            openItem.connect("activate", () => {
                this._openFolderInFileManager(RANDOM_FOLDER);
            });
            folderItem.menu.addMenuItem(openItem);
            return;
        }

        const countItem = new PopupMenu.PopupMenuItem(_("%d images found").format(images.length));
        countItem.setSensitive(false);
        countItem.actor.add_style_class_name('ultraspan-header');
        countItem.actor.accessible_name = _("%d images found").format(images.length);
        folderItem.menu.addMenuItem(countItem);

        images.forEach(image => {
            const item = new PopupMenu.PopupMenuItem(this._truncateName(image.name, 25));
            item.actor.add_style_class_name('ultraspan-filename');
            item.actor.accessible_name = _("Set wallpaper ") + image.name;
            item.actor.accessible_description = _("Set this image as your wallpaper");
            item.connect("activate", () => {
                this._setWallpaper(image.path);
            });
            folderItem.menu.addMenuItem(item);
        });

        folderItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openFolderItem = new PopupMenu.PopupMenuItem(_("Open folder"));
        openFolderItem.actor.accessible_name = _("Open wallpaper folder");
        openFolderItem.actor.accessible_description = _("Open the wallpaper folder in your file manager");
        openFolderItem.connect("activate", () => {
            this._openFolderInFileManager(RANDOM_FOLDER);
        });
        folderItem.menu.addMenuItem(openFolderItem);
    }

    /* ---------------- Per-monitor submenu ---------------- */
    _addPerMonitorSubMenu() {
        const perMonitorItem = new PopupMenu.PopupSubMenuMenuItem(_("Set per‑monitor"));
        perMonitorItem.actor.accessible_name = _("Set per‑monitor wallpaper");
        perMonitorItem.actor.accessible_description = _("Assign different wallpapers to each monitor");
        this._forceSubmenuStyles(perMonitorItem);
        perMonitorItem.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(perMonitorItem);

        this._getMonitorInfoAsync((monitors) => {
            if (monitors.length === 0) {
                this._showPerMonitorNoMonitors(perMonitorItem);
                return;
            }
            this._loadPerMonitorImages(perMonitorItem, monitors);
        });
    }

    _showPerMonitorNoMonitors(perMonitorItem) {
        let err = new PopupMenu.PopupMenuItem(_("Could not detect monitors"));
        err.setSensitive(false);
        err.actor.accessible_name = _("Could not detect monitors");
        perMonitorItem.menu.addMenuItem(err);
    }

    _loadPerMonitorImages(perMonitorItem, monitors) {
        let folder = Gio.File.new_for_path(RANDOM_FOLDER);
        folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                this._onPerMonitorFolderQueried(obj, res, perMonitorItem, monitors);
            });
    }

    _onPerMonitorFolderQueried(obj, res, perMonitorItem, monitors) {
        try {
            obj.query_info_finish(res);
            this._getImagesFromFolderAsync(RANDOM_FOLDER, 999, (images) => {
                this._onPerMonitorImagesLoaded(perMonitorItem, monitors, images);
            });
        } catch (e) {
            this._handlePerMonitorFolderError(perMonitorItem, e);
        }
    }

    _handlePerMonitorFolderError(perMonitorItem, error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            this._showPerMonitorFolderMissing(perMonitorItem);
        } else {
            this._showPerMonitorFolderError(perMonitorItem);
        }
    }

    _showPerMonitorFolderMissing(perMonitorItem) {
        let item = new PopupMenu.PopupMenuItem(_("Folder does not exist"));
        item.setSensitive(false);
        item.actor.accessible_name = _("Wallpaper folder does not exist");
        perMonitorItem.menu.addMenuItem(item);
    }

    _showPerMonitorFolderError(perMonitorItem) {
        let item = new PopupMenu.PopupMenuItem(_("Folder error"));
        item.setSensitive(false);
        item.actor.accessible_name = _("Folder error");
        perMonitorItem.menu.addMenuItem(item);
    }

    _onPerMonitorImagesLoaded(perMonitorItem, monitors, images) {
        perMonitorItem.menu.removeAll();
        if (images.length === 0) {
            this._showPerMonitorNoImages(perMonitorItem);
            return;
        }
        this._buildPerMonitorList(perMonitorItem, monitors, images);
    }

    _showPerMonitorNoImages(perMonitorItem) {
        let noImg = new PopupMenu.PopupMenuItem(_("No images found"));
        noImg.setSensitive(false);
        noImg.actor.accessible_name = _("No images found");
        perMonitorItem.menu.addMenuItem(noImg);
    }

    _buildPerMonitorList(perMonitorItem, monitors, images) {
        this._addPerMonitorImageList(perMonitorItem, images);
        perMonitorItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let entries = this._createMonitorEntries(perMonitorItem, monitors, images.length);
        perMonitorItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addPerMonitorApplyButton(perMonitorItem, entries, images, monitors.length);
    }

    _addPerMonitorImageList(perMonitorItem, images) {
        let listHeader = new PopupMenu.PopupMenuItem(_("Images (use numbers below)"));
        listHeader.setSensitive(false);
        listHeader.actor.add_style_class_name('ultraspan-header');
        listHeader.actor.accessible_name = _("Images list");
        listHeader.actor.accessible_description = _("Enter the number of the image you want for each monitor");
        perMonitorItem.menu.addMenuItem(listHeader);

        for (let i = 0; i < images.length; i++) {
            let label = (i + 1) + ". " + this._truncateName(images[i].name, 25);
            let item = new PopupMenu.PopupMenuItem(label);
            item.setSensitive(false);
            item.actor.accessible_name = images[i].name;
            perMonitorItem.menu.addMenuItem(item);
        }
    }

    _createMonitorEntries(perMonitorItem, monitors, imageCount) {
        let entries = [];
        for (let i = 0; i < monitors.length; i++) {
            let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            let box = new St.BoxLayout({ vertical: false });
            let lbl = new St.Label({ text: _("Monitor %d (%s): ").format(i + 1, monitors[i]) });
            lbl.accessible_name = _("Monitor %d (%s): ").format(i + 1, monitors[i]);
            box.add(lbl);

            let entry = new St.Entry({
                text: "",
                style_class: "popup-menu-item",
                can_focus: true,
                reactive: true
            });
            // Accessibility: describe the entry with the label
            entry.accessible_name = _("Image number for monitor %d").format(i + 1);
            entry.accessible_description = _("Enter a number from 1 to %d").format(imageCount);
            // Associate label with entry (St doesn't have direct accessible_relationship, but we set name and description)
            entry.clutter_text.set_single_line_mode(true);
            entry.clutter_text.set_width(30);

            // Direct styling: removes extra left padding and makes the white box fit the text
            entry.set_style(
                'background-color: white;' +
                'color: black;' +
                'caret-color: black;' +
                'border: 1px solid #888;' +
                'border-radius: 4px;' +
                'padding: 0 2px;' +
                'min-width: 30px;' +
                'max-width: 36px;'
            );

            box.add(entry);
            item.addActor(box);
            perMonitorItem.menu.addMenuItem(item);
            entries.push(entry);
        }
        return entries;
    }

    _addPerMonitorApplyButton(perMonitorItem, entries, images, monitorCount) {
        let applyButton = new PopupMenu.PopupMenuItem(_("Apply per‑monitor"));
        applyButton.actor.accessible_name = _("Apply per-monitor wallpaper");
        applyButton.actor.accessible_description = _("Sets different wallpapers for each monitor based on the image numbers you entered");
        applyButton.connect('activate', () => {
            this._validateAndApplyPerMonitor(entries, images, monitorCount);
            this.menu.close();
        });
        perMonitorItem.menu.addMenuItem(applyButton);
    }

    _isValidImageNumber(num, imageCount) {
        return !isNaN(num) && num >= 1 && num <= imageCount;
    }

    _validateAndApplyPerMonitor(entries, images, monitorCount) {
        this._assert(Array.isArray(entries), "Entries must be array");
        this._assert(Array.isArray(images), "Images must be array");

        let chosen = [];
        for (let i = 0; i < entries.length; i++) {
            let num = parseInt(entries[i].text, 10);
            if (!this._isValidImageNumber(num, images.length)) {
                Main.notify(_("Invalid selection"), _("Please enter valid image numbers for each monitor."));
                return;
            }
            chosen.push(images[num - 1].path);
        }

        if (chosen.length !== monitorCount) {
            Main.notify(_("Invalid selection"), _("Please enter image number for every monitor."));
            return;
        }

        this._readConfigAsync((cfg) => {
            let mode = cfg.mode || 'zoom';
            let args = ['set-per-monitor'].concat(chosen, mode);
            this._runCommandInBackground(args);
        });
    }

    /* ---------------- Settings submenu ---------------- */
    _addSettingsSubMenu() {
        this._assert(!this._destroyed, "Applet destroyed");
        this.settingsSubmenu = new PopupMenu.PopupSubMenuMenuItem(_("Settings"));
        this.settingsSubmenu.actor.accessible_name = _("Settings");
        this.settingsSubmenu.actor.accessible_description = _("Configure wallpaper mode, background, blur, intervals, and more");
        this._forceSubmenuStyles(this.settingsSubmenu);
        this.settingsSubmenu.menu.actor.add_style_class_name('ultraspan-submenu');
        this.menu.addMenuItem(this.settingsSubmenu);

        this._readConfigAsync((currentConfig) => {
            this.settingsSubmenu.menu.removeAll();
            this._populateSettingsMenu(currentConfig);
        });
    }

    _populateSettingsMenu(config) {
        this._assert(config !== null, "Config is null");
        const menu = this.settingsSubmenu.menu;

        this._buildModeSection(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildBackgroundTypeSection(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildBlurSlider(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildRandomIntervalSlider(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildRefreshIntervalSlider(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildMultiRandomSwitch(config, menu);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildClearCacheItem(menu);
    }

    _buildModeSection(config, menu) {
        menu.addMenuItem(this._createHeader(_("Wallpaper Mode")));

        const modes = ["zoom", "fit", "center"];
        this._modeSwitches = {};
        modes.forEach(mode => {
            let switchItem = new PopupMenu.PopupSwitchMenuItem(
                _(mode.charAt(0).toUpperCase() + mode.slice(1)),
                config.mode === mode
            );
            switchItem.actor.accessible_name = _(mode.charAt(0).toUpperCase() + mode.slice(1)) + ", " + (config.mode === mode ? _("selected") : _("not selected"));
            switchItem.actor.accessible_description = _("Set wallpaper mode to %s").format(mode);
            switchItem.connect('toggled', (item, state) => {
                if (!state) {
                    return;
                }
                this._runCommandInBackground(["mode", mode]);
                this._updateMutuallyExclusive(this._modeSwitches, mode);
                // Update accessible name for all switches in group
                for (let key in this._modeSwitches) {
                    let sw = this._modeSwitches[key];
                    let isActive = (key === mode);
                    sw.actor.accessible_name = _(key.charAt(0).toUpperCase() + key.slice(1)) + ", " + (isActive ? _("selected") : _("not selected"));
                }
            });
            this._modeSwitches[mode] = switchItem;
            menu.addMenuItem(switchItem);
        });
    }

    _buildBackgroundTypeSection(config, menu) {
        menu.addMenuItem(this._createHeader(_("Background Type")));

        const bgTypes = ["blur", "solid"];
        this._bgTypeSwitches = {};
        bgTypes.forEach(type => {
            let switchItem = new PopupMenu.PopupSwitchMenuItem(
                _(type.charAt(0).toUpperCase() + type.slice(1)),
                config.bg_type === type
            );
            switchItem.actor.accessible_name = _(type.charAt(0).toUpperCase() + type.slice(1)) + ", " + (config.bg_type === type ? _("selected") : _("not selected"));
            switchItem.actor.accessible_description = _("Set background type to %s").format(type);
            switchItem.connect('toggled', (item, state) => {
                if (!state) {
                    return;
                }
                this._runCommandInBackground(["bg-type", type]);
                this._updateMutuallyExclusive(this._bgTypeSwitches, type);
                for (let key in this._bgTypeSwitches) {
                    let sw = this._bgTypeSwitches[key];
                    let isActive = (key === type);
                    sw.actor.accessible_name = _(key.charAt(0).toUpperCase() + key.slice(1)) + ", " + (isActive ? _("selected") : _("not selected"));
                }
            });
            this._bgTypeSwitches[type] = switchItem;
            menu.addMenuItem(switchItem);
        });
    }

    _buildBlurSlider(config, menu) {
        menu.addMenuItem(this._createHeader(_("Blur Amount")));

        this._blurSlider = new PopupMenu.PopupSliderMenuItem(config.blur / 100);
        let blurLabel = this._blurSlider.actor.get_children()[0];
        blurLabel.text = _("Blur: ") + config.blur;
        this._blurTooltip = new Tooltips.Tooltip(this._blurSlider.actor, _("Blur: ") + config.blur);
        this._blurSlider.actor.accessible_name = _("Blur amount: ") + config.blur;
        this._blurSlider.actor.accessible_description = _("Adjust the strength of the blur effect");

        this._blurSlider.connect('value-changed', (item) => {
            let val = Math.round(item._value * 100);
            blurLabel.text = _("Blur: ") + val;
            this._blurTooltip.set_text(_("Blur: ") + val);
            this._blurSlider.actor.accessible_name = _("Blur amount: ") + val;
            this._runCommandInBackground(["blur", val.toString()]);
        });
        menu.addMenuItem(this._blurSlider);
    }

    _buildRandomIntervalSlider(config, menu) {
        menu.addMenuItem(this._createHeader(_("Random Interval")));

        let randVal = config.random_interval || 30;
        this._randomIntervalSlider = new PopupMenu.PopupSliderMenuItem((randVal - 1) / 119);
        let randLabel = this._randomIntervalSlider.actor.get_children()[0];
        randLabel.text = _("Random: ") + randVal + " min";
        this._randomTooltip = new Tooltips.Tooltip(this._randomIntervalSlider.actor, _("Random: ") + randVal + " min");
        this._randomIntervalSlider.actor.accessible_name = _("Random interval: ") + randVal + " min";
        this._randomIntervalSlider.actor.accessible_description = _("Time between wallpaper changes in minutes");

        this._randomIntervalSlider.connect('value-changed', (item) => {
            let minutes = Math.max(1, Math.round(item._value * 119 + 1));
            randLabel.text = _("Random: ") + minutes + " min";
            this._randomTooltip.set_text(_("Random: ") + minutes + " min");
            this._randomIntervalSlider.actor.accessible_name = _("Random interval: ") + minutes + " min";
            this._runCommandInBackground(["interval", minutes.toString()]);
        });
        menu.addMenuItem(this._randomIntervalSlider);
    }

    _buildRefreshIntervalSlider(config, menu) {
        menu.addMenuItem(this._createHeader(_("Refresh Interval")));

        let currentMins = config.refresh_interval || 480;
        this._refreshIntervalSlider = new PopupMenu.PopupSliderMenuItem((currentMins - 60) / 1380);
        let refLabel = this._refreshIntervalSlider.actor.get_children()[0];
        let hours = Math.floor(currentMins / 60);
        let labelText = hours + " h";
        if (currentMins % 60 > 0) {
            labelText += " " + (currentMins % 60) + " min";
        }
        refLabel.text = _("Refresh: ") + labelText;
        this._refreshTooltip = new Tooltips.Tooltip(this._refreshIntervalSlider.actor, _("Refresh: ") + labelText);
        this._refreshIntervalSlider.actor.accessible_name = _("Refresh interval: ") + labelText;
        this._refreshIntervalSlider.actor.accessible_description = _("How often to re‑apply the wallpaper to fix blur");

        this._refreshIntervalSlider.connect('value-changed', (item) => {
            let mins = Math.max(60, Math.round(item._value * 1380 + 60));
            hours = Math.floor(mins / 60);
            labelText = hours + " h";
            if (mins % 60 > 0) {
                labelText += " " + (mins % 60) + " min";
            }
            refLabel.text = _("Refresh: ") + labelText;
            this._refreshTooltip.set_text(_("Refresh: ") + labelText);
            this._refreshIntervalSlider.actor.accessible_name = _("Refresh interval: ") + labelText;
            this._runCommandInBackground(["set-config", "refresh_interval", mins.toString()]);

            const refreshFile = GLib.build_filenamev([CONFIG_DIR, "refresh"]);
            let refreshGFile = Gio.File.new_for_path(refreshFile);
            refreshGFile.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
                (obj, res) => {
                    try {
                        obj.query_info_finish(res);
                        this._runCommandInBackground(["refresh-start", mins.toString()]);
                    } catch (e) {
                        void e;
                    }
                });
        });
        menu.addMenuItem(this._refreshIntervalSlider);
    }

    _buildMultiRandomSwitch(config, menu) {
        this._multiRandomSwitch = new PopupMenu.PopupSwitchMenuItem(
            _("Multi‑monitor random"),
            config.multi_random
        );
        this._multiRandomSwitch.actor.accessible_name = _("Multi‑monitor random") + ", " + (config.multi_random ? _("on") : _("off"));
        this._multiRandomSwitch.actor.accessible_description = _("When on, each monitor gets a different random image");
        this._multiRandomSwitch.connect('toggled', (item, state) => {
            this._runCommandInBackground(["set-config", "multi_random", state ? "true" : "false"]);
            item.actor.accessible_name = _("Multi‑monitor random") + ", " + (state ? _("on") : _("off"));
        });
        menu.addMenuItem(this._multiRandomSwitch);
    }

    _buildClearCacheItem(menu) {
        let clearCacheItem = new PopupMenu.PopupMenuItem(_("Clear cache"));
        clearCacheItem.actor.accessible_name = _("Clear cache");
        clearCacheItem.actor.accessible_description = _("Remove all cached wallpaper files and thumbnails");
        clearCacheItem.connect('activate', () => {
            this._runCommandInBackground(["clean"]);
            this._setTimeout(() => {
                if (!this._destroyed) {
                    this._runCommandInBackground(["refresh-wallpaper"]);
                }
            }, 500);
        });
        menu.addMenuItem(clearCacheItem);
    }

    _createHeader(text) {
        this._assert(typeof text === 'string', "Header text must be string");
        let header = new PopupMenu.PopupMenuItem(text);
        header.setSensitive(false);
        header.actor.add_style_class_name('ultraspan-header');
        header.actor.accessible_name = text;
        return header;
    }

    _updateMutuallyExclusive(switchMap, activeKey) {
        this._assert(switchMap !== null, "switchMap is null");
        for (let key in switchMap) {
            if (key !== activeKey && switchMap[key]) {
                switchMap[key].setToggleState(false);
            }
        }
    }

    /* ---------------- Daemon control ---------------- */
    _addDaemonControl() {
        this._isDaemonRunning((running) => {
            this._refreshStartStopItem = this._createDaemonMenuItem(running);
            this.menu.addMenuItem(this._refreshStartStopItem);
        });
    }

    _swapDaemonButton(isRunning) {
        if (this._refreshStartStopItem) {
            this._refreshStartStopItem.destroy();
            this._refreshStartStopItem = null;
        }
        this._refreshStartStopItem = this._createDaemonMenuItem(isRunning);
        if (this.menu && !this._destroyed) {
            this.menu.addMenuItem(this._refreshStartStopItem);
        }
    }

    _createDaemonMenuItem(running) {
        const label = running ? _("Stop Auto Services") : _("Start Auto Services");
        const item = new PopupMenu.PopupMenuItem(label);
        item.actor.accessible_name = label;
        item.actor.accessible_description = running ?
            _("Stop background services like refresh and random rotation") :
            _("Start background services like refresh and random rotation");
        item.connect('activate', () => {
            const command = running ? ["daemon-stop"] : ["daemon"];
            this._runCommandInBackground(command);
            this._swapDaemonButton(!running);
        });
        return item;
    }

    /* ---------------- Random control ---------------- */
    _addRandomControl() {
        const randomFile = GLib.build_filenamev([CONFIG_DIR, "random"]);
        let file = Gio.File.new_for_path(randomFile);
        file.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                this._onRandomFileQueried(obj, res);
            });
    }

    _onRandomFileQueried(obj, res) {
        try {
            obj.query_info_finish(res);
            this._showRandomStopItem();
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                this._handleRandomFileMissing();
            } else {
                global.logError("Error checking random file: " + e);
                this._handleRandomFileMissing();
            }
        }
    }

    _showRandomStopItem() {
        const stopItem = new PopupMenu.PopupMenuItem(_("Stop Random Rotation"));
        stopItem.actor.accessible_name = _("Stop Random Rotation");
        stopItem.actor.accessible_description = _("Stops the automatic random wallpaper changer");
        stopItem.connect("activate", () => {
            this._runCommandInBackground(["random-stop"]);
            this._setTimeout(() => this._rebuildMenu(), 100);
        });
        this.menu.addMenuItem(stopItem);
    }

    _handleRandomFileMissing() {
        const startItem = new PopupMenu.PopupMenuItem(_("Start Random Rotation"));
        startItem.actor.accessible_name = _("Start Random Rotation");
        startItem.actor.accessible_description = _("Starts automatic random wallpaper changes from your wallpaper folder");
        startItem.connect("activate", () => {
            this._startRandomRotation();
        });
        this.menu.addMenuItem(startItem);
    }

    _startRandomRotation() {
        let folder = Gio.File.new_for_path(RANDOM_FOLDER);
        folder.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                this._onRandomFolderQueried(obj, res);
            });
    }

    _onRandomFolderQueried(obj, res) {
        try {
            obj.query_info_finish(res);
            this._startRandomWithConfig();
        } catch (e) {
            global.logError("Error checking random folder: " + e);
            this._ensureFolderExistsAsync(RANDOM_FOLDER, () => {
                this._startRandomWithConfig();
            });
        }
    }

    _startRandomWithConfig() {
        this._readConfigAsync((currentConfig) => {
            let mode = currentConfig.mode || 'zoom';
            let cmd = currentConfig.multi_random ? "random-multi" : "random";
            this._runCommandInBackground([cmd, RANDOM_FOLDER, mode]);
            this._setTimeout(() => this._rebuildMenu(), 100);
        });
    }

    /* ---------------- Async helpers ---------------- */
    _getMonitorInfoAsync(callback) {
        let proc = new Gio.Subprocess({
            argv: ['xrandr', '--listmonitors'],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        proc.init(null);
        proc.communicate_utf8_async(null, null, (proc, res) => {
            try {
                let [, stdout, stderr] = proc.communicate_utf8_finish(res);
                if (!proc.get_successful()) {
                    global.logError('xrandr failed: ' + stderr);
                    callback([]);
                    return;
                }
                let monitors = this._parseMonitorOutput(stdout);
                callback(monitors);
            } catch (e) {
                global.logError('Error reading monitor info: ' + e);
                callback([]);
            }
        });
    }

    _parseMonitorOutput(stdout) {
        let lines = stdout.split('\n');
        let monitors = [];
        for (let i = 1; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line === '') {
                continue;
            }
            let parts = line.split(/\s+/);
            if (parts.length >= 2) {
                monitors.push(parts[parts.length - 1]);
            }
        }
        return monitors;
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
                    this._parseConfigContents(contents, config);
                }
            } catch (e) {
                global.logError("Error reading config: " + e);
            }
            callback(config);
        });
    }

    _parseConfigContents(contents, config) {
        let lines = contents.toString().split('\n');
        for (let i = 0; i < lines.length; i++) {
            this._parseConfigLine(lines[i], config);
        }
    }

    _parseConfigLine(line, config) {
        line = line.trim();
        if (line.includes('=')) {
            let [key, value] = line.split('=', 2);
            key = key.trim();
            value = value.trim();
            this._applyConfigValue(key, value, config);
        }
    }

    _applyConfigValue(key, value, config) {
        if (["blur", "random_interval", "refresh_interval"].includes(key)) {
            config[key] = parseInt(value, 10);
        } else if (key === "multi_random") {
            config[key] = (value === "true");
        } else if (value) {
            config[key] = value;
        }
    }

    _getImagesFromFolderAsync(folderPath, maxCount, callback) {
        const images = [];
        let dir = Gio.File.new_for_path(folderPath);
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                try {
                    let enumerator = obj.enumerate_children_finish(res);
                    this._enumerateNextAsync(enumerator, folderPath, images, maxCount, callback);
                } catch (e) {
                    global.logError("Error enumerating directory: " + e);
                    callback(images);
                }
            });
    }

    _enumerateNextAsync(enumerator, folderPath, images, maxCount, callback) {
        enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null, (obj, res) => {
            try {
                let files = obj.next_files_finish(res);
                this._handleFiles(enumerator, files, folderPath, images, maxCount, callback);
            } catch (e) {
                global.logError("Error reading files: " + e);
                callback(images);
            }
        });
    }

    _shouldFinishEnumeration(files, currentCount, maxCount) {
        return files === null || files.length === 0 || currentCount >= maxCount;
    }

    _addImageFiles(files, folderPath, images, maxCount) {
        for (let i = 0; i < files.length && images.length < maxCount; i++) {
            let fileInfo = files[i];
            const fileName = fileInfo.get_name();
            if (/\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
                const filePath = GLib.build_filenamev([folderPath, fileName]);
                images.push({ name: fileName, path: filePath });
            }
        }
    }

    _handleFiles(enumerator, files, folderPath, images, maxCount, callback) {
        if (this._shouldFinishEnumeration(files, images.length, maxCount)) {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
            images.sort((a, b) => a.name.localeCompare(b.name));
            callback(images);
            return;
        }

        this._addImageFiles(files, folderPath, images, maxCount);
        // Schedule next batch on idle to avoid recursion
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._enumerateNextAsync(enumerator, folderPath, images, maxCount, callback);
            return false;
        });
    }

    _runCommandInBackground(args) {
        let scriptFile = Gio.File.new_for_path(SCRIPT_PATH);
        scriptFile.query_info_async('*', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (obj, res) => {
                try {
                    obj.query_info_finish(res);
                    this._setTimeout(() => {
                        this._spawnCommand(args);
                    }, 10);
                } catch (e) {
                    global.logError("Error checking script: " + e);
                }
            });
    }

    _spawnCommand(args) {
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
        if (name.length <= maxLength) {
            return name;
        }
        return name.substring(0, maxLength - 3) + "...";
    }
}

// eslint-disable-next-line no-unused-vars
function main(metadata, orientation, panelHeight, instanceId) {
    return new UltraspanApplet(metadata, orientation, panelHeight, instanceId);
}
