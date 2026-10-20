"""Global hotkey (Windows): Win+Shift+B summons the chat from anywhere."""
from __future__ import annotations

import ctypes
import sys
import threading
from typing import Callable

MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x0004, 0x0008, 0x4000
WM_HOTKEY, WM_QUIT = 0x0312, 0x0012
VK_B = 0x42


class Hotkey:
    def __init__(self, callback: Callable[[], None]):
        self.callback = callback
        self.thread_id = 0
        self.thread: threading.Thread | None = None
        self.registered = False

    def start(self) -> bool:
        if sys.platform != "win32":
            return False
        self.thread = threading.Thread(target=self._loop, daemon=True, name="buddy-hotkey")
        self.thread.start()
        return True

    def _loop(self) -> None:
        from ctypes import wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32")
        self.thread_id = kernel32.GetCurrentThreadId()
        if not user32.RegisterHotKey(None, 1, MOD_WIN | MOD_SHIFT | MOD_NOREPEAT, VK_B):
            return  # already taken by another app; Buddy still works without it
        self.registered = True
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == WM_HOTKEY:
                try:
                    self.callback()
                except Exception:
                    pass
        user32.UnregisterHotKey(None, 1)

    def stop(self) -> None:
        if self.thread_id:
            try:
                ctypes.WinDLL("user32").PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0)
            except OSError:
                pass
