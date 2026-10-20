"""Paths, packaging helpers and the single-instance guard.

Works identically from source (`python main.py`) and from the PyInstaller
build (`Buddy.exe` beside an `_internal` folder).
"""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
FROZEN = bool(getattr(sys, "frozen", False))


def app_folder() -> Path:
    """Folder that holds Buddy.exe (frozen) or the project root (source)."""
    if FROZEN:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource(name: str) -> Path:
    """Bundled read-only resource (assets, bridge script)."""
    base = Path(getattr(sys, "_MEIPASS", app_folder()))
    return base / name


def data_folder() -> Path:
    """Writable per-install folder for state, logs and the bridge helper."""
    custom = os.environ.get("BUDDY_DATA_DIR")
    if custom:
        folder = Path(custom).expanduser().resolve()
    else:
        folder = app_folder() / "Buddy-data"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def bridge_command() -> list[str]:
    """Command line that starts the stdio MCP bridge.

    Frozen builds ship `BuddyBridge.exe` inside `_internal/bridge`; a copy is
    placed in the data folder so the MCP config keeps working even if the
    app is updated in place. From source we simply run the script.
    """
    if FROZEN:
        source = resource("bridge") / "BuddyBridge.exe"
        if source.exists():
            digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
            target = data_folder() / "bin" / f"BuddyBridge-{digest}.exe"
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            return [str(target)]
        return [sys.executable]  # bridge missing: still return something sane
    script = Path(__file__).resolve().parent / "mcp_bridge.py"
    python = Path(sys.executable)
    if IS_WINDOWS and python.name.lower() == "python.exe":
        candidate = python.with_name("pythonw.exe")
        if candidate.exists():
            python = candidate
    return [str(python), str(script)]


def claim_instance():
    """Return a mutex handle if this is the only Buddy for this data folder.

    On a second launch, the running instance is asked to show its panel and
    `None` is returned so the caller can exit quietly. Non-Windows platforms
    always succeed (the fallback is only used for development).
    """
    if not IS_WINDOWS:
        return object()
    import ctypes
    from ctypes import wintypes

    from . import WINDOW_TITLE

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    key = hashlib.sha256(str(data_folder()).encode("utf-8")).hexdigest()[:16]
    handle = kernel32.CreateMutexW(None, False, f"Local\\Buddy-{key}")
    error = ctypes.get_last_error()
    if handle and error == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = user32.FindWindowW(None, WINDOW_TITLE)
        if hwnd:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
        return None
    return handle
