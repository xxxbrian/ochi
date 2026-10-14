from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse
import xml.etree.ElementTree as ET


WORKSPACE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("desktop_prepare", WORKSPACE / "desktop-prepare.py")
assert SPEC is not None and SPEC.loader is not None
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)
LAUNCH_SPEC = importlib.util.spec_from_file_location("desktop_launch", WORKSPACE / "desktop-browser-launch.py")
assert LAUNCH_SPEC is not None and LAUNCH_SPEC.loader is not None
LAUNCH = importlib.util.module_from_spec(LAUNCH_SPEC)
LAUNCH_SPEC.loader.exec_module(LAUNCH)


class DesktopDefaultsTests(unittest.TestCase):
    def test_seeding_preserves_user_edits_and_browser_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            preferences = data / "browser-profiles" / "main" / "Preferences"
            preferences.parent.mkdir(parents=True)
            preferences.write_bytes(b"existing browser state")
            destinations = [data / "desktop" / name for name in ("config", "share", "state", "cache")]
            seeded = PREPARE.prepare_desktop(WORKSPACE / "desktop-defaults", *destinations)
            self.assertGreater(seeded, 10)
            pref = destinations[0] / "gtk-3.0" / "settings.ini"
            pref.write_text("[Settings]\ngtk-theme-name=user-preference\n", encoding="utf-8")
            self.assertEqual(PREPARE.prepare_desktop(WORKSPACE / "desktop-defaults", *destinations), 0)
            self.assertIn("user-preference", pref.read_text(encoding="utf-8"))
            self.assertEqual(preferences.read_bytes(), b"existing browser state")

    def test_existing_symlink_is_not_followed_or_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            config = data / "config"
            target = data / "user-settings"
            target.write_bytes(b"private user preference")
            (config / "gtk-3.0").mkdir(parents=True)
            link = config / "gtk-3.0" / "settings.ini"
            link.symlink_to(target)
            PREPARE.prepare_desktop(WORKSPACE / "desktop-defaults", config, data / "share", data / "state", data / "cache")
            self.assertTrue(link.is_symlink())
            self.assertEqual(target.read_bytes(), b"private user preference")

    def test_xfce_configs_are_well_formed_with_real_desktop_clients(self) -> None:
        for path in (WORKSPACE / "desktop-defaults").rglob("*.xml"):
            tree = ET.parse(path)
            self.assertEqual(tree.getroot().tag, "channel")
        session = ET.parse(WORKSPACE / "desktop-defaults/config/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml")
        clients = {item.attrib["value"] for item in session.findall(".//value[@type='string']")}
        self.assertTrue({"xfwm4", "xfsettingsd", "xfce4-panel", "Thunar", "xfdesktop"}.issubset(clients))
        browser = (WORKSPACE / "desktop-defaults/share/applications/chromium.desktop").read_text(encoding="utf-8")
        self.assertIn("Exec=workspace-browser-launch %U", browser)
        self.assertNotIn("--user-data-dir", browser)

    def test_manual_browser_launcher_only_calls_private_managed_browser(self) -> None:
        with patch.object(LAUNCH.urllib.request, "build_opener") as build:
            opener = build.return_value
            opener.open.return_value.__enter__.side_effect = [io.BytesIO(b'{"status":"ok"}') for _ in range(2)]
            urls = ["https://example.org/path?a=1&b=2", "file:///data/work/report.html"]
            LAUNCH.launch(urls)
            calls = opener.open.call_args_list
            self.assertEqual(len(calls), 2)
            for call, original in zip(calls, urls):
                parsed = urllib.parse.urlsplit(call.args[0])
                self.assertEqual(parsed.netloc, "127.0.0.1:8080")
                self.assertEqual(parsed.path, "/browser/desktop-launch")
                self.assertEqual(urllib.parse.parse_qs(parsed.query), {"url": [original]})
            self.assertIsInstance(build.call_args.args[0], LAUNCH.urllib.request.ProxyHandler)
            self.assertEqual(build.call_args.args[0].proxies, {})

    def test_panel_has_expanding_space_and_time_only_clock(self) -> None:
        panel = ET.parse(WORKSPACE / "desktop-defaults/config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml")
        plugins = panel.find("./property[@name='plugins']")
        self.assertIsNotNone(plugins)
        assert plugins is not None
        order = [item.attrib["value"] for item in panel.findall(".//property[@name='plugin-ids']/value")]
        by_id = {item.attrib["name"].removeprefix("plugin-"): item for item in plugins}
        expanding = [key for key, item in by_id.items() if item.attrib["value"] == "separator" and
                     item.find("./property[@name='expand'][@value='true']") is not None]
        self.assertEqual(len(expanding), 1)
        space_index = order.index(expanding[0])
        self.assertEqual(by_id[order[space_index - 1]].attrib["value"], "tasklist")
        self.assertEqual(by_id[order[-1]].attrib["value"], "clock")
        clock = by_id[order[-1]]
        self.assertEqual(clock.find("./property[@name='digital-layout']").attrib["value"], "3")
        self.assertEqual(clock.find("./property[@name='digital-time-format']").attrib["value"], "%H:%M")
        self.assertEqual(clock.find("./property[@name='digital-time-font']").attrib["value"], "Noto Sans 10")


if __name__ == "__main__":
    unittest.main()
