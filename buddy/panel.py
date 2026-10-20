"""Web chat panel (pywebview + Edge WebView2) and its Python↔JS bridge.

`WebPanel.available()` tells the app whether pywebview can be used; when it
cannot, the app falls back to the Tk panel in ui.py. The panel is a
frameless, always-on-top sheet that the island shows and hides.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .core import Core
from .runtime import resource

WIDTH, HEIGHT = 480, 660


class Api:
    """Methods callable from JS as window.pywebview.api.<name>(...)."""

    def __init__(self, panel: "WebPanel"):
        self.panel = panel
        self.core = panel.core

    # chat
    def boot(self):
        return self.core.snapshot()

    def send(self, text, agent=None):
        self.core.submit(str(text), None if agent is None else bool(agent))

    def set_agent_mode(self, enabled):
        self.core.set_agent_mode(bool(enabled))

    def stop(self):
        self.core.stop()

    def set_provider(self, name):
        self.core.set_provider(str(name))

    def set_model(self, name):
        self.core.set_model(str(name))

    def refresh_models(self):
        self.core.refresh_models()

    def clear_chat(self):
        self.core.clear_chat()

    # files
    def attach(self):
        import webview  # noqa: F811  (lazy: pywebview may be absent)
        paths = self.panel.window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True)
        if paths:
            self.core.attach(list(paths))
        return list(paths or [])

    def remove_file(self, path):
        self.core.remove_file(str(path))

    def open_path(self, path, confirmed=False):
        return self.core.open_path(str(path), bool(confirmed))

    # tasks
    def add_task(self, text):
        self.core.add_task(str(text))

    def set_task_done(self, task_id, done):
        self.core.set_task_done(str(task_id), bool(done))

    def clear_done_tasks(self):
        self.core.clear_done_tasks()

    # settings
    def get_settings(self):
        from .runtime import IS_WINDOWS
        return {"settings": dict(self.core.settings), "autostart": self.core.autostart_enabled(), "windows": IS_WINDOWS}

    def save_settings(self, changes):
        if not isinstance(changes, dict):
            return ["Invalid settings."]
        before = self.core.settings.get("display_mode")
        problems = self.core.apply_settings(changes)
        after = self.core.settings.get("display_mode")
        if not problems and before != after:
            self.core.emit("display", mode=after)
        return problems

    def save_file(self, src):
        import shutil
        import webview
        src = str(src)
        if not Path(src).is_file():
            return None
        target = self.panel.window.create_file_dialog(webview.SAVE_DIALOG, directory=str(Path.home() / "Downloads"),
                                                       save_filename=Path(src).name)
        if not target:
            return None
        target = target[0] if isinstance(target, (list, tuple)) else target
        shutil.copyfile(src, target)
        return str(target)

    def browse_folder(self):
        import webview
        paths = self.panel.window.create_file_dialog(webview.FOLDER_DIALOG)
        return paths[0] if paths else None

    # connect
    def instructions_text(self):
        from .connect import BUDDY_INSTRUCTIONS
        return BUDDY_INSTRUCTIONS.split("\n", 1)[1]

    def connect_status(self):
        return self.core.connect_status()

    # Google Chat lives in the Buddy 2.0 desktop edition; keep the shared panel working here.
    def gchat_status(self):
        return {"account": "", "client": False, "apps": {}, "error": "Google Chat is available in the Buddy 2.0 desktop edition (Buddy-Setup.cmd)."}

    def gchat_pick_client(self):
        return self.gchat_status()

    def gchat_sign_in(self):
        return self.gchat_status()

    def gchat_disconnect(self):
        return self.gchat_status()

    def open_url(self, url=""):
        import webbrowser
        if str(url).startswith("https://"):
            webbrowser.open(url)
        return True

    def memory_get(self):
        return {"profile": "", "projects": "", "notes": "Memory and skills live in the Buddy 2.0 desktop edition (Buddy-Setup.cmd)."}

    def memory_set(self, *_):
        return False

    def open_memory_folder(self):
        return False

    def skills(self):
        return []

    def open_skills_folder(self):
        return False

    def remote_status(self):
        return {"telegram": {"configured": False}, "slack": {"configured": False}, "notify": True}

    def remote_connect(self, *_):
        return {"error": "Phone remote (Telegram/Slack) is available in the Buddy 2.0 desktop edition."}

    def remote_unlink(self, *_):
        return self.remote_status()

    def remote_notify(self, *_):
        return self.remote_status()

    def open_session(self):
        return False

    def install_cli(self, *_):
        return False

    def skin_pick_image(self):
        return {"error": "Custom skins are available in the Buddy 2.0 desktop edition."}

    def snip(self):
        return False

    def permission_reply(self, *_):
        return False

    def always_allowed(self):
        return []

    def forget_always_allow(self):
        return True

    def connect(self, key):
        ok, message = self.core.connect(str(key))
        return {"ok": ok, "message": message}

    def browse_claude(self):
        import webview
        paths = self.panel.window.create_file_dialog(webview.FOLDER_DIALOG)
        if not paths:
            return None
        ok, message = self.core.connect("claude_desktop", paths[0])
        return {"ok": ok, "message": message}

    def paste_clipboard(self):
        return []

    def login_code(self, code=""):
        return False

    def login_cancel(self):
        return True

    def login_status(self):
        return None

    def update_status(self):
        return None

    def update_check(self):
        return None

    def update_apply(self):
        return False

    def login_open(self):
        return False

    def open_login(self, which="claude"):
        import subprocess
        from .runtime import IS_WINDOWS
        cmd = "codex login" if which == "codex" else "claude"
        if IS_WINDOWS:
            subprocess.Popen(["cmd.exe", "/c", "start", "Sign in", "cmd", "/k", cmd], creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
        else:
            self.core.system(f"Open a terminal and run: {cmd}")
        return True

    def uninstall(self, keep_data=True):
        import subprocess
        from .runtime import IS_WINDOWS, app_folder, data_folder
        if not IS_WINDOWS:
            return {"error": "Uninstall is automated on Windows only. Delete the Buddy folder to remove it."}
        folder, data = str(app_folder()), str(data_folder())
        try:
            from . import startup
            startup.set_enabled(False)
        except Exception:
            pass
        lines = ["@echo off", "timeout /t 2 /nobreak >nul", "taskkill /f /im Buddy.exe >nul 2>nul", "timeout /t 1 /nobreak >nul",
                 'del /q "%USERPROFILE%\\Desktop\\Buddy.lnk" "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Buddy.lnk" >nul 2>nul']
        if keep_data and data.startswith(folder):
            lines += [f'move /y "{data}" "%TEMP%\\Buddy-data-keep" >nul 2>nul', f'rd /s /q "{folder}"', f'mkdir "{folder}"',
                      f'move /y "%TEMP%\\Buddy-data-keep" "{data}" >nul 2>nul', f'echo Buddy removed. Your data is still in "{data}" & pause']
        else:
            lines += [f'rd /s /q "{folder}"'] + ([f'rd /s /q "{data}"'] if not keep_data and not data.startswith(folder) else []) + ["echo Buddy removed. & timeout /t 3 >nul"]
        lines.append('del "%~f0"')
        script = Path(os.environ.get("TEMP", ".")) / "buddy-uninstall.cmd"
        script.write_text("\r\n".join(lines) + "\r\n", "utf-8")
        subprocess.Popen(["cmd.exe", "/c", "start", "Buddy uninstall", str(script)], creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
        self.core.emit("quit")
        return {"ok": True}

    # window
    def hide(self):
        self.panel.hide()

    def quit(self):
        self.core.emit("quit")


class WebPanel:
    @staticmethod
    def available() -> bool:
        try:
            import webview  # noqa: F401
            return True
        except Exception:
            return False

    def __init__(self, core: Core):
        import webview

        self.core = core
        self.visible = False
        self.ready = threading.Event()
        html_path = Path(__file__).resolve().parent / "web" / "panel.html"
        if not html_path.exists():
            html_path = resource("buddy") / "web" / "panel.html"
        self.api = Api(self)
        self.window = webview.create_window(
            "Buddy", url=html_path.as_uri(), js_api=self.api, width=WIDTH, height=HEIGHT,
            frameless=True, easy_drag=False, on_top=True, hidden=True, resizable=False,
            background_color="#0c0e14", text_select=True,
        )
        self.window.events.loaded += self._on_loaded
        core.subscribe(self._on_event)

    # lifecycle ------------------------------------------------------------
    def _on_loaded(self):
        self.ready.set()

    def run(self, on_start=None) -> None:
        """Blocks on the GUI loop (must be the main thread)."""
        import webview
        from .runtime import data_folder
        webview.start(on_start, private_mode=False, debug=False, storage_path=str(data_folder() / "webview"))

    def close(self) -> None:
        try:
            self.window.destroy()
        except Exception:
            pass

    # show / hide ----------------------------------------------------------
    def show(self, x: int | None = None, y: int | None = None, view: str = "chat") -> None:
        try:
            if x is not None and y is not None:
                self.window.move(x, y)
            self.window.show()
            self.window.restore()
            self.visible = True
            self._js("show", {"view": view})
        except Exception:
            pass

    def hide(self) -> None:
        try:
            self.window.hide()
        except Exception:
            pass
        self.visible = False

    def toggle(self, x: int | None = None, y: int | None = None) -> None:
        if self.visible:
            self.hide()
        else:
            self.show(x, y)

    # events ---------------------------------------------------------------
    def _js(self, kind: str, payload: dict) -> None:
        if not self.ready.is_set():
            return
        try:
            self.window.evaluate_js(f"window.buddy && window.buddy.on({json.dumps(kind)}, {json.dumps(payload, ensure_ascii=False)})")
        except Exception:
            pass

    def _on_event(self, kind: str, payload: dict) -> None:
        if kind in ("chat.user", "chat.begin", "chat.text", "chat.step", "chat.done", "chat.error", "chat.system",
                    "chat.cleared", "provider", "files", "tasks", "settings", "reminder", "agent"):
            self._js(kind, payload)
