"""Native file drop (WM_DROPFILES) for any Tk window on Windows.

Subclasses the window procedure so dropped paths are delivered to `receive`
on the Tk thread. On other platforms `install()` returns None.
"""
from __future__ import annotations

import ctypes
import sys
import tkinter as tk
from typing import Callable

IS_WINDOWS = sys.platform == "win32"


class WindowsDrop:
    GWLP_WNDPROC = -4
    WM_DROPFILES = 0x0233

    def __init__(self, window: tk.Misc, receive: Callable[[list[str]], None], hwnd: int | None = None):
        from ctypes import wintypes

        self.window = window
        self.receive = receive
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.shell = ctypes.WinDLL("shell32", use_last_error=True)
        u, s = self.user, self.shell
        u.GetParent.argtypes = [wintypes.HWND]
        u.GetParent.restype = wintypes.HWND
        u.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        u.CallWindowProcW.restype = ctypes.c_ssize_t
        is64 = ctypes.sizeof(ctypes.c_void_p) == 8
        self.setter = u.SetWindowLongPtrW if is64 else u.SetWindowLongW
        self.setter.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        self.setter.restype = ctypes.c_ssize_t
        s.DragAcceptFiles.argtypes = [wintypes.HWND, wintypes.BOOL]
        s.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPWSTR, wintypes.UINT]
        s.DragQueryFileW.restype = wintypes.UINT
        s.DragFinish.argtypes = [wintypes.HANDLE]

        window.update_idletasks()
        self.hwnd = hwnd or u.GetParent(window.winfo_id()) or window.winfo_id()
        proc_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        self.callback = proc_type(self._handle)  # keep a strong reference for the window's lifetime
        self.old = self.setter(self.hwnd, self.GWLP_WNDPROC, ctypes.cast(self.callback, ctypes.c_void_p).value)
        if not self.old:
            raise ctypes.WinError(ctypes.get_last_error())
        s.DragAcceptFiles(self.hwnd, True)

    def _handle(self, hwnd, msg, wp, lp):
        if msg == self.WM_DROPFILES:
            paths = []
            try:
                count = self.shell.DragQueryFileW(wp, 0xFFFFFFFF, None, 0)
                for i in range(min(count, 200)):
                    length = self.shell.DragQueryFileW(wp, i, None, 0) + 1
                    buffer = ctypes.create_unicode_buffer(length)
                    self.shell.DragQueryFileW(wp, i, buffer, length)
                    paths.append(buffer.value)
            finally:
                self.shell.DragFinish(wp)
            if paths:
                self.window.after(0, lambda: self.receive(paths))
            return 0
        return self.user.CallWindowProcW(self.old, hwnd, msg, wp, lp)

    def close(self) -> None:
        try:
            self.shell.DragAcceptFiles(self.hwnd, False)
            self.setter(self.hwnd, self.GWLP_WNDPROC, self.old)
        except OSError:
            pass


def install(window: tk.Misc, receive: Callable[[list[str]], None], hwnd: int | None = None):
    if not IS_WINDOWS:
        return None
    try:
        return WindowsDrop(window, receive, hwnd)
    except OSError:
        return None
