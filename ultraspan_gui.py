#!/usr/bin/env python3
# ============================================
# Ultraspan GTK GUI
# ============================================
# Version 1.1.8
# ============================================

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading

import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, Gtk

# ----------------------------------------------------------------------
# GTK module dictionary (initialised at import time)
# ----------------------------------------------------------------------
GTK = {
    'Gtk': Gtk,
    'Gio': Gio,
    'GLib': GLib,
    'Adw': Adw,
    'Gdk': Gdk,
    'GdkPixbuf': GdkPixbuf,
}

# ----------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------
APP_ID = 'com.github.hisovereign.ultraspan'
CONFIG_DIR = os.path.expanduser('~/.config/ultraspan')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config')
STATE_FILE = os.path.join(CONFIG_DIR, 'state')
RANDOM_FILE = os.path.join(CONFIG_DIR, 'random')
REFRESH_FILE = os.path.join(CONFIG_DIR, 'refresh')
SCRIPT_PATH = shutil.which('ultraspan') or os.path.expanduser('~/.local/bin/ultraspan')
DEFAULT_FOLDER = os.path.expanduser('~/Pictures/ultraspan')
THUMBNAIL_CACHE = os.path.expanduser('~/.cache/ultraspan/thumbnails')
DAEMON_PID_FILE = os.path.join('/run/user', str(os.getuid()), 'ultraspan', 'daemon.pid')

# ----------------------------------------------------------------------
# Config handler
# ----------------------------------------------------------------------
class UltraspanConfig:
    def __init__(self) -> None:
        self.defaults = {
            'mode': 'zoom',
            'bg_type': 'blur',
            'blur': '15',
            'color': '#000000',
            'fullscreen_pause': 'true',
            'random_interval': '30',
            'refresh_interval': '480',
            'multi_random': 'false',
            'backend': 'gsettings',
            'max_cache_mb': '2000',
            'magick_memory': '2GiB',
            'per_workspace': 'false',
            'wallpaper_folder': DEFAULT_FOLDER,
        }
        self.values = self.defaults.copy()
        self.load()
        assert self.values is not None, "Config values failed to initialise"
        assert isinstance(self.defaults, dict), "Defaults must be dict"

    def load(self) -> None:
        if not os.path.exists(CONFIG_FILE):
            return
        with open(CONFIG_FILE, 'r') as f:
            for line in f:
                line = line.strip()
                if '=' not in line:
                    continue
                key, val = line.split('=', 1)
                key = key.strip()
                val = val.strip()
                if key in self.values:
                    self.values[key] = val

    def save(self) -> None:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_FILE, 'w') as f:
            f.writelines(f"{key}={val}\n" for key, val in self.values.items())

    def get(self, key: str) -> str:
        assert key in self.defaults, f"Unknown config key: {key}"
        assert isinstance(key, str) and key, "Key must be non-empty string"
        return self.values.get(key, self.defaults.get(key, ''))

    def set(self, key: str, val: object) -> None:
        assert key in self.defaults, f"Unknown config key: {key}"
        assert isinstance(key, str) and key, "Key must be non-empty string"
        self.values[key] = str(val)
        self.save()

    def get_int(self, key: str) -> int:
        assert key in self.defaults, f"Unknown config key: {key}"
        assert isinstance(key, str) and key, "Key must be non-empty string"
        try:
            return int(self.get(key))
        except (ValueError, TypeError):
            return int(self.defaults.get(key, '0'))

    def get_bool(self, key: str) -> bool:
        assert key in self.defaults, f"Unknown config key: {key}"
        assert isinstance(key, str) and key, "Key must be non-empty string"
        val = self.get(key)
        return val.lower() in ('true', 'yes', '1', 'on')

# ----------------------------------------------------------------------
# Thumbnail cache helper
# ----------------------------------------------------------------------
def get_thumbnail_path(image_path: str, size: int = 120) -> str:
    assert isinstance(image_path, str) and image_path, "Invalid image_path"
    assert isinstance(size, int) and size > 0, "Invalid size"
    os.makedirs(THUMBNAIL_CACHE, exist_ok=True)
    try:
        mtime = os.path.getmtime(image_path)
    except OSError:
        mtime = 0
    key = f"{image_path}_{mtime}_{size}"
    hash_name = hashlib.md5(key.encode()).hexdigest()
    return os.path.join(THUMBNAIL_CACHE, f"{hash_name}.png")

# ----------------------------------------------------------------------
# Helper function to create an ActionRow with a SpinButton
# ----------------------------------------------------------------------
def create_spin_row(
    title: str,
    subtitle: str | None,
    min_val: float,
    max_val: float,
    step: float,
    initial: float,
    on_changed: object,
) -> tuple[object, object]:
    assert isinstance(title, str) and title, "Title must be non-empty string"
    assert isinstance(min_val, (int, float)), "min_val must be number"
    assert isinstance(max_val, (int, float)), "max_val must be number"
    assert isinstance(initial, (int, float)), "initial must be number"
    gtk = GTK
    row = gtk['Adw'].ActionRow.new()
    row.set_title(title)
    if subtitle:
        row.set_subtitle(subtitle)
    spin = gtk['Gtk'].SpinButton.new_with_range(min_val, max_val, step)
    spin.set_value(initial)
    spin.connect('value-changed', on_changed)
    row.add_suffix(spin)
    row.set_activatable_widget(spin)
    return row, spin

# ----------------------------------------------------------------------
# Main Window
# ----------------------------------------------------------------------
class UltraspanWindow(GTK['Adw'].PreferencesWindow):
    def __init__(self, app: object) -> None:
        super().__init__(title="Ultraspan Settings")
        assert app is not None, "App reference cannot be None"
        assert isinstance(app, object), "App must be an object"
        self.app = app
        self.config = UltraspanConfig()

        self.set_default_size(650, 860)

        self._updating_modes = False
        self.monitor_count = 0
        self.selected_slots = []
        self._selection_update_lock = False
        self._updating_widgets = False

        self._setup_styles()
        self._build_pages()
        self._monitor_config()
        self._monitor_daemon()
        self.connect('notify::visible-page', self._on_visible_page_changed)
        self._update_service_status()
        assert hasattr(self, 'wallpaper_flowbox'), "Wallpaper flowbox not created"
        assert hasattr(self, 'status_page'), "Status page not created"

    def _setup_styles(self) -> None:
        gtk = GTK
        css_provider = gtk['Gtk'].CssProvider.new()
        assert css_provider is not None, "Failed to create CSS provider"
        css_provider.load_from_data(b"""
        .badge {
            background-color: rgba(0, 0, 0, 0.7);
            color: white;
            font-weight: bold;
            padding: 2px 6px;
            border-radius: 9999px;
        }
        preferencespage > box { padding-top: 0px; padding-bottom: 8px; }
        preferencespage > box > preferencesgroup {
            margin-top: 0px;
            margin-bottom: 4px;
        }
        .wallpaper-child { padding: 0px; margin: 0px; }
        .wallpaper-child image { padding: 0px; margin: 0px; }
        .wallpaper-child label { padding-top: 0px; margin-top: 0px; }
        .wallpaper-child {
            background: transparent;
            border: none;
            box-shadow: none;
            outline: none;
        }
        .wallpaper-child.selected {
            outline: 2px solid @theme_selected_bg_color;
            outline-offset: -2px;
        }
        """)
        gtk['Gtk'].StyleContext.add_provider_for_display(
            gtk['Gdk'].Display.get_default(),
            css_provider,
            gtk['Gtk'].STYLE_PROVIDER_PRIORITY_APPLICATION
        )
        assert gtk['Gdk'].Display.get_default() is not None, "No default display available"

    def _get_current_max_allowed(self) -> int:
        assert self.mode_single_btn is not None, "mode_single_btn not initialised"
        assert self.monitor_count >= 0, "monitor_count must be non-negative"
        return 1 if self.mode_single_btn.get_active() else self.monitor_count

    def _on_visible_page_changed(self, window: object, pspec: object) -> None:
        assert self.status_page is not None, "Status page not created"
        if self.get_visible_page() == self.status_page:
            stdout, stderr, returncode = self._run_ultraspan(["diagnose"])
            if stdout.strip():
                self.status_label.set_text(stdout)
            elif returncode == 0:
                self.status_label.set_text("Diagnostics returned no output.")
            else:
                detail = stderr.strip() if stderr.strip() else f"Exit code {returncode}"
                self.status_label.set_text(f"Diagnostics failed:\n{detail}")

    def _is_daemon_running(self) -> bool:
        assert isinstance(DAEMON_PID_FILE, str) and DAEMON_PID_FILE, "Invalid DAEMON_PID_FILE"
        if not os.path.exists(DAEMON_PID_FILE):
            return False
        try:
            with open(DAEMON_PID_FILE, 'r') as f:
                pid = int(f.read().strip())
            assert pid > 0, "Daemon PID must be positive"
            os.kill(pid, 0)
            return True
        except (OSError, ValueError):
            return False

    # ------------------------------------------------------------------
    # Page dispatcher
    # ------------------------------------------------------------------
    def _build_pages(self) -> None:
        gtk = GTK
        assert gtk is not None, "GTK dict is None"
        assert callable(getattr(self, '_build_wallpapers_page', None)), "Missing wallpapers page builder"
        self._build_wallpapers_page(gtk)
        self._build_general_page(gtk)
        self._build_rotation_page(gtk)
        self._build_status_page(gtk)
        self._on_mode_toggled(self.mode_single_btn)

    # ------------------------------------------------------------------
    # Page builders (each under 60 lines)
    # ------------------------------------------------------------------
    def _build_wallpapers_page(self, gtk: dict[str, object]) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        wallpapers_page = gtk['Adw'].PreferencesPage.new()
        assert wallpapers_page is not None, "Failed to create wallpapers page"
        wallpapers_page.set_title("Wallpapers")
        wallpapers_page.set_icon_name("preferences-desktop-wallpaper-symbolic")
        self.add(wallpapers_page)
        self._build_folder_group(gtk, wallpapers_page)
        self._build_images_group(gtk, wallpapers_page)
        self._build_monitor_group(gtk, wallpapers_page)
        self._build_workspace_row(gtk)

    def _build_folder_group(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        folder_group = gtk['Adw'].PreferencesGroup.new()
        folder_group.set_title("Wallpaper Folder")
        page.add(folder_group)
        self.folder_button = gtk['Gtk'].Button.new_with_label(self.config.get('wallpaper_folder'))
        self.folder_button.set_halign(gtk['Gtk'].Align.FILL)
        self.folder_button.set_hexpand(True)
        self.folder_button.set_margin_start(8)
        self.folder_button.set_margin_end(8)
        self.folder_button.set_margin_top(4)
        self.folder_button.set_margin_bottom(4)
        self.folder_button.connect('clicked', self._on_choose_folder_clicked)
        folder_group.add(self.folder_button)
        assert self.folder_button is not None, "Folder button not created"

    def _build_images_group(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        list_group = gtk['Adw'].PreferencesGroup.new()
        list_group.set_title("Images")
        page.add(list_group)
        scrolled = gtk['Gtk'].ScrolledWindow.new()
        scrolled.set_min_content_height(425)
        scrolled.set_policy(gtk['Gtk'].PolicyType.NEVER, gtk['Gtk'].PolicyType.AUTOMATIC)
        list_group.add(scrolled)
        self.wallpaper_flowbox = gtk['Gtk'].FlowBox.new()
        self.wallpaper_flowbox.set_selection_mode(gtk['Gtk'].SelectionMode.NONE)
        self.wallpaper_flowbox.set_valign(gtk['Gtk'].Align.START)
        self.wallpaper_flowbox.set_halign(gtk['Gtk'].Align.FILL)
        self.wallpaper_flowbox.set_max_children_per_line(4)
        self.wallpaper_flowbox.set_min_children_per_line(2)
        self.wallpaper_flowbox.set_row_spacing(0)
        self.wallpaper_flowbox.set_column_spacing(0)
        scrolled.set_child(self.wallpaper_flowbox)

        # Mode buttons as header suffix of Images group
        mode_box = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.HORIZONTAL, 0)
        mode_box.set_halign(gtk['Gtk'].Align.END)
        mode_box.set_valign(gtk['Gtk'].Align.CENTER)
        mode_box.set_margin_top(0)
        mode_box.set_margin_bottom(0)

        self.mode_single_btn = gtk['Gtk'].ToggleButton.new_with_label("Wallpaper")
        self.mode_single_btn.add_css_class("suggested-action")
        self.mode_single_btn.set_active(True)
        self.mode_single_btn.connect('toggled', self._on_mode_toggled)

        self.mode_per_monitor_btn = gtk['Gtk'].ToggleButton.new_with_label("Per‑Monitor")
        self.mode_per_monitor_btn.connect('toggled', self._on_mode_toggled)

        self.mode_per_workspace_btn = gtk['Gtk'].ToggleButton.new_with_label("Per‑Workspace")
        self.mode_per_workspace_btn.connect('toggled', self._on_mode_toggled)

        mode_box.append(self.mode_single_btn)
        mode_box.append(self.mode_per_monitor_btn)
        mode_box.append(self.mode_per_workspace_btn)

        try:
            list_group.set_header_suffix(mode_box)
        except AttributeError:
            header_box = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.HORIZONTAL, 6)
            header_box.set_margin_start(8)
            header_box.set_margin_end(8)
            header_box.set_margin_top(4)
            header_box.set_margin_bottom(4)
            mode_box.set_halign(gtk['Gtk'].Align.END)
            header_box.append(mode_box)
            list_group.add(header_box)

        self.list_group = list_group
        assert self.list_group is not None, "list_group not set"
        assert self.mode_single_btn is not None, "Mode button not created"

    def _build_monitor_group(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        monitor_group = gtk['Adw'].PreferencesGroup.new()
        monitor_group.set_title("Monitors")
        page.add(monitor_group)
        monitor_hbox = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.HORIZONTAL, 4)
        monitor_hbox.set_margin_start(6)
        monitor_hbox.set_margin_end(6)
        self.monitor_list_box = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.VERTICAL, 0)
        self.monitor_list_box.set_hexpand(True)
        self.monitor_list_box.set_halign(gtk['Gtk'].Align.FILL)
        monitor_hbox.append(self.monitor_list_box)
        right_box = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.VERTICAL, 4)
        right_box.set_valign(gtk['Gtk'].Align.END)
        refresh_icon_btn = gtk['Gtk'].Button.new_from_icon_name("view-refresh-symbolic")
        refresh_icon_btn.set_tooltip_text("Refresh images and clear selection")
        refresh_icon_btn.connect('clicked', self._on_refresh_images_clicked)
        refresh_icon_btn.set_halign(gtk['Gtk'].Align.END)
        right_box.append(refresh_icon_btn)
        self.apply_btn = gtk['Gtk'].Button.new_with_label("Apply")
        self.apply_btn.add_css_class("suggested-action")
        self.apply_btn.set_valign(gtk['Gtk'].Align.END)
        self.apply_btn.set_halign(gtk['Gtk'].Align.END)
        self.apply_btn.connect('clicked', self._on_apply_clicked)
        right_box.append(self.apply_btn)
        monitor_hbox.append(right_box)
        monitor_group.add(monitor_hbox)
        self._populate_monitor_list()
        assert self.monitor_list_box is not None, "Monitor list box not created"
        assert self.apply_btn is not None, "Apply button not created"

    def _build_workspace_row(self, gtk: dict[str, object]) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        self.workspace_select_row = gtk['Adw'].ActionRow.new()
        self.workspace_select_row.set_title("Workspace Number (0‑based)")
        workspace_spin = gtk['Gtk'].SpinButton.new_with_range(0, 20, 1)
        workspace_spin.set_value(0)
        self.workspace_select_row.add_suffix(workspace_spin)
        self.workspace_select_row.set_activatable_widget(workspace_spin)
        self.workspace_spin = workspace_spin
        self.workspace_select_row.set_visible(False)
        self.list_group.add(self.workspace_select_row)
        assert self.workspace_select_row is not None, "Workspace row not created"
        assert self.workspace_spin is not None, "Workspace spin not created"

    def _build_general_page(self, gtk: dict[str, object]) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        general_page = gtk['Adw'].PreferencesPage.new()
        general_page.set_title("General")
        general_page.set_icon_name("preferences-system-symbolic")
        self.add(general_page)
        self._build_display_mode_section(gtk, general_page)
        self._build_background_section(gtk, general_page)
        self._build_general_settings_section(gtk, general_page)
        self._build_backend_section(gtk, general_page)
        self._build_auto_services_section(gtk, general_page)

    def _build_display_mode_section(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        mode_group = gtk['Adw'].PreferencesGroup.new()
        mode_group.set_title("Display Mode")
        page.add(mode_group)
        mode_row = gtk['Adw'].ComboRow.new()
        mode_row.set_title("Mode")
        mode_row.set_subtitle("How the image fits the screen")
        model = gtk['Gtk'].StringList.new(["zoom", "fit", "center"])
        mode_row.set_model(model)
        mode_row.set_selected(self._get_index(model, self.config.get('mode')))
        mode_row.connect('notify::selected', self._on_mode_changed)
        mode_group.add(mode_row)
        self.mode_row = mode_row
        assert self.mode_row is not None, "Mode row not created"

    def _build_background_section(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        bg_group = gtk['Adw'].PreferencesGroup.new()
        bg_group.set_title("Background")
        page.add(bg_group)
        self._build_bg_type_row(gtk, bg_group)
        self._build_blur_scale(gtk, bg_group)
        self._build_color_button(gtk, bg_group)

    def _build_bg_type_row(self, gtk: dict[str, object], group: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert group is not None, "Group cannot be None"
        bg_type_row = gtk['Adw'].ComboRow.new()
        bg_type_row.set_title("Type")
        bg_type_row.set_subtitle("Blurred image or solid color")
        model = gtk['Gtk'].StringList.new(["blur", "solid"])
        bg_type_row.set_model(model)
        bg_type_row.set_selected(self._get_index(model, self.config.get('bg_type')))
        bg_type_row.connect('notify::selected', self._on_bg_type_changed)
        group.add(bg_type_row)
        self.bg_type_row = bg_type_row
        assert self.bg_type_row is not None, "BG type row not created"

    def _build_blur_scale(self, gtk: dict[str, object], group: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert group is not None, "Group cannot be None"
        blur_row = gtk['Adw'].ActionRow.new()
        blur_row.set_title("Blur Amount")
        blur_row.set_subtitle("Strength of the blur effect (0–100)")
        blur_scale = gtk['Gtk'].Scale.new_with_range(gtk['Gtk'].Orientation.HORIZONTAL, 0, 100, 1)
        blur_scale.set_value(self.config.get_int('blur'))
        blur_scale.set_hexpand(True)
        blur_scale.connect('value-changed', self._on_blur_changed)
        blur_row.add_suffix(blur_scale)
        blur_row.set_activatable_widget(blur_scale)
        group.add(blur_row)
        self.blur_scale = blur_scale
        assert self.blur_scale is not None, "Blur scale not created"

    def _build_color_button(self, gtk: dict[str, object], group: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert group is not None, "Group cannot be None"
        color_row = gtk['Adw'].ActionRow.new()
        color_row.set_title("Solid Color")
        color_row.set_subtitle("Color used when background type is solid")
        rgba = gtk['Gdk'].RGBA()
        color_str = self.config.get('color')
        if not rgba.parse(color_str if color_str else '#000000'):
            rgba.parse('#000000')
        color_dialog = gtk['Gtk'].ColorDialog.new()
        color_dialog.set_title("Choose Solid Color")
        color_btn = gtk['Gtk'].ColorDialogButton.new(color_dialog)
        color_btn.props.rgba = rgba
        color_btn.connect('notify::rgba', self._on_color_changed)
        color_row.add_suffix(color_btn)
        color_row.set_activatable_widget(color_btn)
        group.add(color_row)
        self.color_btn = color_btn
        assert self.color_btn is not None, "Color button not created"

    def _build_general_settings_section(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        general_settings_group = gtk['Adw'].PreferencesGroup.new()
        general_settings_group.set_title("General Settings")
        page.add(general_settings_group)
        fullscreen_row = gtk['Adw'].SwitchRow.new()
        fullscreen_row.set_title("Pause on Fullscreen")
        fullscreen_row.set_subtitle("Pause refresh/random when a fullscreen app is active")
        fullscreen_row.set_active(self.config.get_bool('fullscreen_pause'))
        fullscreen_row.connect('notify::active', self._on_fullscreen_toggled)
        general_settings_group.add(fullscreen_row)
        self.fullscreen_row = fullscreen_row
        workspace_row = gtk['Adw'].SwitchRow.new()
        workspace_row.set_title("Per‑Workspace Wallpapers")
        workspace_row.set_subtitle("Different wallpaper for each workspace")
        workspace_row.set_active(self.config.get_bool('per_workspace'))
        workspace_row.connect('notify::active', self._on_workspace_toggled)
        general_settings_group.add(workspace_row)
        self.workspace_row = workspace_row
        assert self.fullscreen_row is not None, "Fullscreen row not created"
        assert self.workspace_row is not None, "Workspace row not created"

    def _build_backend_section(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        backend_group = gtk['Adw'].PreferencesGroup.new()
        backend_group.set_title("Wallpaper Backend")
        page.add(backend_group)
        backend_row = gtk['Adw'].ComboRow.new()
        backend_row.set_title("Backend")
        backend_row.set_subtitle("Tool used to set the wallpaper")
        model = gtk['Gtk'].StringList.new(["gsettings", "feh", "nitrogen"])
        backend_row.set_model(model)
        backend_row.set_selected(self._get_index(model, self.config.get('backend')))
        backend_row.connect('notify::selected', self._on_backend_changed)
        backend_group.add(backend_row)
        self.backend_row = backend_row
        assert self.backend_row is not None, "Backend row not created"

    def _build_auto_services_section(self, gtk: dict[str, object], page: object) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        assert page is not None, "Page cannot be None"
        daemon_group = gtk['Adw'].PreferencesGroup.new()
        daemon_group.set_title("Auto Services")
        daemon_group.set_description("Background services for per‑workspace, refresh, and random")
        page.add(daemon_group)
        self.daemon_switch = gtk['Adw'].SwitchRow.new()
        self.daemon_switch.set_title("Run background services")
        self.daemon_switch.set_subtitle("Required for per‑workspace wallpapers and periodic services")
        self.daemon_switch.set_active(self._is_daemon_running())
        self.daemon_switch.connect('notify::active', self._on_daemon_toggled)
        daemon_group.add(self.daemon_switch)
        assert self.daemon_switch is not None, "Daemon switch not created"

    def _build_rotation_page(self, gtk: dict[str, object]) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        rotation_page = gtk['Adw'].PreferencesPage.new()
        rotation_page.set_title("Rotation")
        rotation_page.set_icon_name("media-playback-start-symbolic")
        self.add(rotation_page)
        random_group = gtk['Adw'].PreferencesGroup.new()
        random_group.set_title("Random Rotation")
        rotation_page.add(random_group)
        random_interval_row, self.random_spin = create_spin_row(
            "Interval (minutes)", "Time between wallpaper changes",
            1, 360, 1, self.config.get_int('random_interval'),
            self._on_random_interval_changed
        )
        random_group.add(random_interval_row)
        multi_random_row = gtk['Adw'].SwitchRow.new()
        multi_random_row.set_title("Multi‑monitor Random")
        multi_random_row.set_subtitle("Assign a different random image to each monitor")
        multi_random_row.set_active(self.config.get_bool('multi_random'))
        multi_random_row.connect('notify::active', self._on_multi_random_toggled)
        random_group.add(multi_random_row)
        self.multi_random_row = multi_random_row
        self.random_daemon_switch = gtk['Adw'].SwitchRow.new()
        self.random_daemon_switch.set_title("Control")
        self.random_daemon_switch.set_subtitle("Start or stop the random rotation daemon")
        self.random_daemon_switch.set_active(False)
        self.random_daemon_switch.connect('notify::active', self._on_random_daemon_toggled)
        random_group.add(self.random_daemon_switch)
        refresh_group = gtk['Adw'].PreferencesGroup.new()
        refresh_group.set_title("Periodic Refresh")
        rotation_page.add(refresh_group)
        refresh_interval_row, self.refresh_spin = create_spin_row(
            "Interval (minutes)", "How often to re‑apply the wallpaper (fixes blur)",
            1, 1440, 1, self.config.get_int('refresh_interval'),
            self._on_refresh_interval_changed
        )
        refresh_group.add(refresh_interval_row)
        assert self.random_spin is not None, "Random spin not created"
        assert self.refresh_spin is not None, "Refresh spin not created"

    def _build_status_page(self, gtk: dict[str, object]) -> None:
        assert isinstance(gtk, dict), "gtk must be dict"
        status_page = gtk['Adw'].PreferencesPage.new()
        status_page.set_title("Status")
        status_page.set_icon_name("dialog-information-symbolic")
        self.add(status_page)
        self.status_page = status_page
        status_group = gtk['Adw'].PreferencesGroup.new()
        status_group.set_title("Status")
        status_group.set_description("Ultraspan system status")
        status_page.add(status_group)
        self.status_label = gtk['Gtk'].Label.new("Loading...")
        self.status_label.set_halign(gtk['Gtk'].Align.START)
        self.status_label.set_valign(gtk['Gtk'].Align.START)
        self.status_label.set_margin_start(12)
        self.status_label.set_margin_end(12)
        self.status_label.set_margin_top(12)
        self.status_label.set_margin_bottom(12)
        self.status_label.set_wrap(True)
        status_group.add(self.status_label)
        assert self.status_page is not None, "Status page not created"
        assert self.status_label is not None, "Status label not created"

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------
    def _on_child_clicked(self, gesture: object, n_press: int, x: float, y: float, child: object) -> None:
        assert child is not None, "Child cannot be None"
        assert isinstance(child, Gtk.FlowBoxChild), "Invalid child type"
        for i, slot_child in enumerate(self.selected_slots):
            if slot_child == child:
                self.selected_slots[i] = None
                child.remove_css_class('selected')
                if hasattr(child, 'badge_label'):
                    child.badge_label.set_visible(False)
                    child.badge_label.set_text("")
                return
        if self.mode_single_btn.get_active():
            old_child = self.selected_slots[0] if self.selected_slots else None
            if old_child is not None:
                old_child.remove_css_class('selected')
                if hasattr(old_child, 'badge_label'):
                    old_child.badge_label.set_visible(False)
                    old_child.badge_label.set_text("")
            self.selected_slots[0] = child
            child.add_css_class('selected')
            if hasattr(child, 'badge_label'):
                child.badge_label.set_visible(False)
                child.badge_label.set_text("")
            return
        max_allowed = self._get_current_max_allowed()
        try:
            slot_index = self.selected_slots.index(None)
        except ValueError:
            return
        filled_count = sum(1 for s in self.selected_slots if s is not None)
        if filled_count >= max_allowed:
            return
        self.selected_slots[slot_index] = child
        child.add_css_class('selected')
        if hasattr(child, 'badge_label'):
            child.badge_label.set_text(str(slot_index + 1))
            child.badge_label.set_visible(True)

    def _on_child_key_pressed(self, controller: object, keyval: int, keycode: int, state: object, child: object) -> bool:
        gtk = GTK
        assert child is not None, "Child cannot be None"
        assert isinstance(keyval, int), "keyval must be int"
        if keyval in (gtk['Gdk'].KEY_Return, gtk['Gdk'].KEY_KP_Enter, gtk['Gdk'].KEY_space):
            self._on_child_clicked(None, 0, 0, 0, child)
            return True
        return False

    def _get_index(self, model: object, val: str) -> int:
        assert model is not None, "Model cannot be None"
        assert isinstance(val, str), "Value must be string"
        for i in range(model.get_n_items()):
            if model.get_string(i) == val:
                return i
        return 0

    def _run_ultraspan(self, args: list[str]) -> tuple[str, str, int]:
        assert isinstance(args, list), "args must be list"
        assert all(isinstance(a, str) for a in args), "args must contain strings"
        try:
            result = subprocess.run(
                [SCRIPT_PATH] + args,
                capture_output=True,
                text=True,
                timeout=120,
                check=False
            )
            return result.stdout.strip(), result.stderr.strip(), result.returncode
        except subprocess.TimeoutExpired as e:
            return "", str(e), 1
        except FileNotFoundError as e:
            return "", str(e), 1
        except OSError as e:
            return "", str(e), 1

    def _run_ultraspan_async(self, args: list[str]) -> None:
        assert isinstance(args, list), "args must be list"
        assert all(isinstance(a, str) for a in args), "args must contain strings"
        def runner() -> None:
            self._run_ultraspan(args)
        threading.Thread(target=runner, daemon=True).start()

    def _populate_wallpaper_list_async(self) -> None:
        gtk = GTK
        assert self.wallpaper_flowbox is not None, "FlowBox not initialised"
        assert isinstance(self.config, UltraspanConfig), "Config invalid"
        folder = self.config.get('wallpaper_folder')
        if not os.path.isdir(folder):
            return
        try:
            files = sorted([f for f in os.listdir(folder)
                            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp'))])
        except OSError:
            files = []
        # bounded loop: safety max 10000 children
        for _ in range(10000):
            child = self.wallpaper_flowbox.get_first_child()
            if child is None:
                break
            self.wallpaper_flowbox.remove(child)
        if not files:
            return
        self._image_paths = [os.path.join(folder, f) for f in files]

        def load_thumbnails() -> None:
            for idx, path in enumerate(self._image_paths):
                thumb_path = get_thumbnail_path(path, size=134)
                if os.path.exists(thumb_path):
                    try:
                        pixbuf = gtk['GdkPixbuf'].Pixbuf.new_from_file(thumb_path)
                    except gtk['GLib'].Error:
                        continue
                else:
                    try:
                        pixbuf = gtk['GdkPixbuf'].Pixbuf.new_from_file_at_scale(path, 134, 134, True)
                        pixbuf.savev(thumb_path, 'png', [], [])
                    except (gtk['GLib'].Error, OSError):
                        continue
                gtk['GLib'].idle_add(self._add_thumbnail_to_flowbox, path, pixbuf, idx)

        threading.Thread(target=load_thumbnails, daemon=True).start()

    def _add_thumbnail_to_flowbox(self, path: str, pixbuf: object, idx: int) -> None:
        gtk = GTK
        assert isinstance(path, str) and path, "Invalid path"
        assert pixbuf is not None, "Pixbuf cannot be None"
        child = gtk['Gtk'].FlowBoxChild.new()
        child.path = path
        child.set_focusable(True)
        texture = gtk['Gdk'].Texture.new_for_pixbuf(pixbuf)
        picture = gtk['Gtk'].Picture.new_for_paintable(texture)
        picture.set_can_shrink(True)
        picture.set_size_request(134, 134)
        picture.set_halign(gtk['Gtk'].Align.CENTER)
        picture.set_valign(gtk['Gtk'].Align.START)
        badge = gtk['Gtk'].Label.new("")
        badge.set_halign(gtk['Gtk'].Align.START)
        badge.set_valign(gtk['Gtk'].Align.START)
        badge.set_margin_start(2)
        badge.set_margin_top(2)
        badge.add_css_class("badge")
        badge.set_visible(False)
        overlay = gtk['Gtk'].Overlay.new()
        overlay.set_valign(gtk['Gtk'].Align.START)
        overlay.set_halign(gtk['Gtk'].Align.CENTER)
        overlay.set_child(picture)
        overlay.add_overlay(badge)
        child.badge_label = badge
        vbox = gtk['Gtk'].Box.new(gtk['Gtk'].Orientation.VERTICAL, 0)
        vbox.set_spacing(0)
        vbox.append(overlay)
        fname = os.path.basename(path)
        label = gtk['Gtk'].Label.new(fname)
        label.set_xalign(0.5)
        label.set_valign(gtk['Gtk'].Align.START)
        label.set_wrap(True)
        label.set_max_width_chars(15)
        label.set_ellipsize(3)
        vbox.append(label)
        child.set_child(vbox)
        click_gesture = gtk['Gtk'].GestureClick.new()
        click_gesture.connect('pressed', self._on_child_clicked, child)
        child.add_controller(click_gesture)
        key_controller = gtk['Gtk'].EventControllerKey.new()
        key_controller.connect('key-pressed', self._on_child_key_pressed, child)
        child.add_controller(key_controller)
        self.wallpaper_flowbox.append(child)
        child.add_css_class('wallpaper-child')
        assert child.get_parent() is not None, "Thumbnail child not added to flowbox"

    # ------------------------------------------------------------------
    # Other helper methods
    # ------------------------------------------------------------------
    def _populate_monitor_list(self) -> None:
        gtk = GTK
        assert self.monitor_list_box is not None, "Monitor list box not initialised"
        assert isinstance(self.monitor_list_box, Gtk.Box), "Invalid monitor list box"
        # bounded loop: safety max 1000
        for _ in range(1000):
            child = self.monitor_list_box.get_first_child()
            if child is None:
                break
            self.monitor_list_box.remove(child)
        try:
            result = subprocess.run(
                ['xrandr', '--listmonitors'],
                capture_output=True,
                text=True,
                timeout=5,
                check=False
            )
            lines = result.stdout.splitlines()
            monitors = []
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 4:
                    name = parts[-1]
                    monitors.append(name)
                else:
                    monitors.append(line.strip())
        except (OSError, subprocess.TimeoutExpired):
            monitors = []
        self.monitor_count = len(monitors)
        self.selected_slots = [None] * self.monitor_count
        if not monitors:
            label = gtk['Gtk'].Label.new("No monitors detected")
            self.monitor_list_box.append(label)
            return
        for i, name in enumerate(monitors):
            label = gtk['Gtk'].Label.new(f"{i+1}: {name}")
            label.set_xalign(0.0)
            self.monitor_list_box.append(label)

    def _on_mode_toggled(self, btn: object) -> None:
        gtk = GTK
        assert btn is not None, "Button cannot be None"
        assert isinstance(btn, Gtk.ToggleButton), "Invalid button type"
        if self._updating_modes:
            return
        if not btn.get_active():
            return
        self._updating_modes = True
        self.mode_single_btn.set_active(False)
        self.mode_per_monitor_btn.set_active(False)
        self.mode_per_workspace_btn.set_active(False)
        btn.set_active(True)
        max_allowed = self._get_current_max_allowed()
        self.selected_slots = [None] * max_allowed
        next_child = self.wallpaper_flowbox.get_first_child()
        while next_child:
            child = next_child
            next_child = child.get_next_sibling()
            child.remove_css_class('selected')
            if hasattr(child, 'badge_label'):
                child.badge_label.set_visible(False)
                child.badge_label.set_text("")
        for b in (self.mode_single_btn, self.mode_per_monitor_btn, self.mode_per_workspace_btn):
            if b.get_active():
                b.add_css_class("suggested-action")
            else:
                b.remove_css_class("suggested-action")
        self.workspace_select_row.set_visible(self.mode_per_workspace_btn.get_active())
        self.wallpaper_flowbox.set_selection_mode(gtk['Gtk'].SelectionMode.NONE)
        self._updating_modes = False

    def _on_apply_clicked(self, btn: object) -> None:
        assert btn is not None, "Button cannot be None"
        assert isinstance(btn, Gtk.Button), "Invalid button type"
        selected_children = [child for child in self.selected_slots if child is not None]
        if not selected_children:
            return
        paths = [getattr(child, 'path', None) for child in selected_children if getattr(child, 'path', None)]
        if not paths:
            return
        mode = self.config.get('mode')
        cmd = []
        if self.mode_single_btn.get_active():
            if len(paths) >= 1:
                # Check if per‑workspace is enabled
                if self.workspace_row.get_active():
                    ws = int(self.workspace_spin.get_value())
                    cmd = ["set", "--workspace", str(ws), paths[0], mode]
                else:
                    cmd = ["set", paths[0], mode]
        elif self.mode_per_monitor_btn.get_active():
            if len(paths) >= 1:
                cmd = ["set-per-monitor"] + paths + [mode]
        elif self.mode_per_workspace_btn.get_active():
            start_ws = int(self.workspace_spin.get_value())
            if len(paths) == 1:
                cmd = ["set", "--workspace", str(start_ws), paths[0], mode]
            elif len(paths) > 1:
                cmd = ["set-per-monitor", "--workspace", str(start_ws)] + paths + [mode]
            else:
                return
        if cmd:
            self._run_ultraspan_async(cmd)
            btn.set_label("Applied!")
            gtk = GTK
            gtk['GLib'].timeout_add(1500, lambda: btn.set_label("Apply"))

    def _on_multiple_files_selected(self, dialog: object, result: object) -> None:
        gtk = GTK
        assert dialog is not None, "Dialog cannot be None"
        assert result is not None, "Result cannot be None"
        try:
            files = dialog.select_multiple_finish(result)
        except gtk['GLib'].Error:
            return
        if not files:
            return
        paths = []
        n = files.get_n_items()
        for i in range(n):
            gfile = files.get_item(i)
            if gfile:
                paths.append(gfile.get_path())
        if not paths:
            return
        mode = self.config.get('mode')
        self._run_ultraspan_async(["set-per-monitor"] + paths + [mode])

    def _on_single_file_for_monitor_selected(self, dialog: object, result: object) -> None:
        gtk = GTK
        assert dialog is not None, "Dialog cannot be None"
        assert result is not None, "Result cannot be None"
        try:
            gfile = dialog.select_file_finish(result)
        except gtk['GLib'].Error:
            return
        if gfile:
            mode = self.config.get('mode')
            self._run_ultraspan_async(["set", gfile.get_path(), mode])

    def _update_all_widgets(self, *args: object) -> None:
        gtk = GTK
        assert isinstance(self.config, UltraspanConfig), "Config invalid"
        self._updating_widgets = True
        try:
            self.config.load()
            assert hasattr(self, 'backend_row'), "backend_row not created"
            self.backend_row.set_selected(self._get_index(self.backend_row.get_model(), self.config.get('backend')))
            new_fullscreen = self.config.get_bool('fullscreen_pause')
            if self.fullscreen_row.get_active() != new_fullscreen:
                self.fullscreen_row.set_active(new_fullscreen)

            new_workspace = self.config.get_bool('per_workspace')
            if self.workspace_row.get_active() != new_workspace:
                self.workspace_row.set_active(new_workspace)
            self.mode_row.set_selected(self._get_index(self.mode_row.get_model(), self.config.get('mode')))
            self.bg_type_row.set_selected(self._get_index(self.bg_type_row.get_model(), self.config.get('bg_type')))
            self.blur_scale.set_value(self.config.get_int('blur'))
            rgba = gtk['Gdk'].RGBA()
            color_str = self.config.get('color')
            rgba.parse(color_str if color_str else '#000000')
            self.color_btn.props.rgba = rgba
            self.folder_button.set_label(self.config.get('wallpaper_folder'))
            self._populate_wallpaper_list_async()
            self.random_spin.set_value(self.config.get_int('random_interval'))
            new_multi_random = self.config.get_bool('multi_random')
            if self.multi_random_row.get_active() != new_multi_random:
                self.multi_random_row.set_active(new_multi_random)
            self.refresh_spin.set_value(self.config.get_int('refresh_interval'))
            self._update_service_status()
        finally:
            self._updating_widgets = False

    # ------------------------------------------------------------------
    # Signal handlers (unchanged except assertions)
    # ------------------------------------------------------------------
    def _on_backend_changed(self, row: object, *args: object) -> None:
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.ComboRow), "Invalid row type"
        val = row.get_model().get_string(row.get_selected())
        self.config.set('backend', val)
        self._run_ultraspan_async(["set-config", "backend", val])

    def _on_fullscreen_toggled(self, row: object, *args: object) -> None:
        if getattr(self, '_updating_widgets', False):
            return
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.SwitchRow), "Invalid row type"
        val = row.get_active()
        self.config.set('fullscreen_pause', str(val).lower())
        self._run_ultraspan_async(["set-config", "fullscreen_pause", str(val).lower()])

    def _on_workspace_toggled(self, row: object, *args: object) -> None:
        if getattr(self, '_updating_widgets', False):
            return
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.SwitchRow), "Invalid row type"
        val = row.get_active()
        self.config.set('per_workspace', str(val).lower())
        self._run_ultraspan_async(["set-config", "per_workspace", str(val).lower()])

    def _on_mode_changed(self, row: object, *args: object) -> None:
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.ComboRow), "Invalid row type"
        val = row.get_model().get_string(row.get_selected())
        self.config.set('mode', val)
        self._run_ultraspan_async(["mode", val])

    def _on_bg_type_changed(self, row: object, *args: object) -> None:
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.ComboRow), "Invalid row type"
        val = row.get_model().get_string(row.get_selected())
        self.config.set('bg_type', val)
        self._run_ultraspan_async(["bg-type", val])

    def _on_blur_changed(self, scale: object, *args: object) -> None:
        assert scale is not None, "Scale cannot be None"
        assert isinstance(scale, Gtk.Scale), "Invalid scale type"
        val = int(scale.get_value())
        self.config.set('blur', str(val))
        self._run_ultraspan_async(["blur", str(val)])

    def _on_color_changed(self, btn: object, *args: object) -> None:
        assert btn is not None, "Button cannot be None"
        assert isinstance(btn, Gtk.ColorDialogButton), "Invalid button type"
        rgba = btn.props.rgba
        color = rgba.to_string()
        self.config.set('color', color)
        self._run_ultraspan_async(["color", color])

    def _on_choose_folder_clicked(self, btn: object) -> None:
        assert btn is not None, "Button cannot be None"
        gtk = GTK
        dialog = gtk['Gtk'].FileDialog.new()
        dialog.set_title("Select Wallpaper Folder")
        dialog.select_folder(self, None, self._on_folder_dialog_response)

    def _on_refresh_images_clicked(self, btn: object) -> None:
        assert btn is not None, "Button cannot be None"
        self.selected_slots = [None] * self._get_current_max_allowed()
        child = self.wallpaper_flowbox.get_first_child()
        while child is not None:
            child.remove_css_class('selected')
            if hasattr(child, 'badge_label'):
                child.badge_label.set_visible(False)
                child.badge_label.set_text("")
            child = child.get_next_sibling()
        self._populate_wallpaper_list_async()

    def _on_folder_dialog_response(self, dialog: object, result: object) -> None:
        assert dialog is not None, "Dialog cannot be None"
        assert result is not None, "Result cannot be None"
        gtk = GTK
        try:
            folder = dialog.select_folder_finish(result)
        except gtk['GLib'].Error:
            return
        if folder:
            path = folder.get_path()
            self.folder_button.set_label(path)
            self.config.set('wallpaper_folder', path)
            self._run_ultraspan_async(["set-config", "wallpaper_folder", path])
            self._populate_wallpaper_list_async()

    def _on_random_interval_changed(self, spin: object, *args: object) -> None:
        assert spin is not None, "Spin cannot be None"
        assert isinstance(spin, Gtk.SpinButton), "Invalid spin type"
        val = int(spin.get_value())
        self.config.set('random_interval', str(val))
        self._run_ultraspan_async(["interval", str(val)])

    def _on_multi_random_toggled(self, row: object, *args: object) -> None:
        if getattr(self, '_updating_widgets', False):
            return
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.SwitchRow), "Invalid row type"
        val = row.get_active()
        self.config.set('multi_random', str(val).lower())
        self._run_ultraspan_async(["set-config", "multi_random", str(val).lower()])

    def _on_refresh_interval_changed(self, spin: object, *args: object) -> None:
        assert spin is not None, "Spin cannot be None"
        assert isinstance(spin, Gtk.SpinButton), "Invalid spin type"
        val = int(spin.get_value())
        self.config.set('refresh_interval', str(val))
        self._run_ultraspan_async(["set-config", "refresh_interval", str(val)])

    def _on_random_daemon_toggled(self, switch: object, *args: object) -> None:
        assert switch is not None, "Switch cannot be None"
        assert isinstance(switch, Adw.SwitchRow), "Invalid switch type"
        active = switch.get_active()
        gtk = GTK
        if active:
            folder = self.config.get('wallpaper_folder')
            mode = self.config.get('mode')
            cmd = "random-multi" if self.config.get_bool('multi_random') else "random"
            self._run_ultraspan_async([cmd, folder, mode])
        else:
            self._run_ultraspan_async(["random-stop"])
        gtk['GLib'].timeout_add(500, self._update_service_status)

    def _update_service_status(self) -> None:
        random_running = os.path.exists(RANDOM_FILE)
        daemon_running = self._is_daemon_running()
        assert hasattr(self, 'random_daemon_switch'), "random_daemon_switch not created"
        self.random_daemon_switch.set_active(random_running)
        if hasattr(self, 'daemon_switch'):
            self.daemon_switch.set_active(daemon_running)

    def _on_daemon_toggled(self, row: object, *args: object) -> None:
        if getattr(self, '_updating_widgets', False):
            return
        assert row is not None, "Row cannot be None"
        assert isinstance(row, Adw.SwitchRow), "Invalid row type"
        val = row.get_active()
        gtk = GTK
        if val:
            self._run_ultraspan_async(["daemon"])
        else:
            self._run_ultraspan_async(["daemon-stop"])
        gtk['GLib'].timeout_add(2000, self._update_service_status)
        gtk['GLib'].timeout_add(5000, self._update_service_status)

    # ------------------------------------------------------------------
    # Config monitor
    # ------------------------------------------------------------------
    def _monitor_config(self) -> None:
        gtk = GTK
        def callback(file: object, other: object, event: object, data: object) -> None:
            if event in (gtk['Gio'].FileMonitorEvent.CHANGED, gtk['Gio'].FileMonitorEvent.CHANGES_DONE_HINT):
                gtk['GLib'].idle_add(self._update_all_widgets)
        if os.path.exists(CONFIG_FILE):
            file = gtk['Gio'].File.new_for_path(CONFIG_FILE)
            self.monitor = file.monitor(gtk['Gio'].FileMonitorFlags.NONE, None)
            self.monitor.connect('changed', callback)
            assert self.monitor is not None, "File monitor not created"

    def _monitor_daemon(self) -> None:
        """Watch daemon PID file to keep daemon switch in sync."""
        gtk = GTK
        if os.path.exists(DAEMON_PID_FILE):
            file = gtk['Gio'].File.new_for_path(DAEMON_PID_FILE)
            self.daemon_monitor = file.monitor(gtk['Gio'].FileMonitorFlags.NONE, None)
            self.daemon_monitor.connect('changed', lambda *args: 
                gtk['GLib'].idle_add(self._update_service_status))
        else:
            # If file doesn't exist yet, watch the directory
            dir_path = os.path.dirname(DAEMON_PID_FILE)
            if os.path.exists(dir_path):
                dir_file = gtk['Gio'].File.new_for_path(dir_path)
                self.daemon_monitor = dir_file.monitor(gtk['Gio'].FileMonitorFlags.NONE, None)
                self.daemon_monitor.connect('changed', lambda *args: 
                    gtk['GLib'].idle_add(self._update_service_status))

    # ------------------------------------------------------------------
    # About dialog
    # ------------------------------------------------------------------
    def _show_about(self, *args: object) -> None:
        gtk = GTK
        about = gtk['Adw'].AboutWindow.new()
        assert about is not None, "About window not created"
        about.set_application_name("Ultraspan")
        about.set_version("1.0.0")
        about.set_comments("Multi‑monitor wallpaper manager with blur fix")
        about.set_license_type(gtk['Gtk'].License.GPL_2_0)
        about.set_website("https://github.com/hisovereign/Ultraspan")
        about.set_developers(["hisovereign"])
        about.set_transient_for(self)
        about.present()

# ----------------------------------------------------------------------
# Application
# ----------------------------------------------------------------------
class UltraspanApp:
    def __init__(self) -> None:
        gtk = GTK
        self.app = gtk['Adw'].Application.new(APP_ID, gtk['Gio'].ApplicationFlags.FLAGS_NONE)
        assert self.app is not None, "Application creation failed"
        self.app.connect('activate', self.do_activate)
        self.window = None
        self._updating_widgets = False

    def do_activate(self, app: object) -> None:
        assert app is not None, "App cannot be None"
        if not self.window:
            self.window = UltraspanWindow(self)
            self.app.add_window(self.window)
        self.window.present()
        gtk = GTK
        gtk['GLib'].idle_add(self.window._populate_wallpaper_list_async)

    def run(self, args: list[str]) -> int:
        assert isinstance(args, list), "args must be list"
        assert all(isinstance(a, str) for a in args), "args must contain strings"
        return self.app.run(args)

# ----------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------
def main() -> int:
    os.makedirs(CONFIG_DIR, exist_ok=True)
    app = UltraspanApp()
    return app.run(sys.argv)

if __name__ == '__main__':
    main()
