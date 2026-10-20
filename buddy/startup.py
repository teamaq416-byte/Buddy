"""Launch-at-sign-in toggle (Windows per-user Run key)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from .runtime import FROZEN, IS_WINDOWS

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE = "Buddy"


def command() -> str:
    if FROZEN:
        return subprocess.list2cmdline([sys.executable])
    python = Path(sys.executable)
    if IS_WINDOWS and python.name.lower() == "python.exe" and python.with_name("pythonw.exe").exists():
        python = python.with_name("pythonw.exe")
    main = Path(__file__).resolve().parent.parent / "main.py"
    return subprocess.list2cmdline([str(python), str(main)])


def enabled() -> bool:
    if not IS_WINDOWS:
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, VALUE)
            return bool(str(value).strip())
    except FileNotFoundError:
        return False
    except OSError:
        return False


def set_enabled(enable: bool) -> None:
    if not IS_WINDOWS:
        return
    import winreg
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enable:
            winreg.SetValueEx(key, VALUE, 0, winreg.REG_SZ, command())
        else:
            try:
                winreg.DeleteValue(key, VALUE)
            except FileNotFoundError:
                pass
