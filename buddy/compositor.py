"""Window surfaces that display an RGBA frame.

LayeredSurface   Windows: per-pixel alpha via UpdateLayeredWindow (no
                 background, click-through on transparent pixels).
CanvasSurface    Fallback for non-Windows development: draws the frame on
                 a Tk canvas over a dark background.
"""
from __future__ import annotations

import ctypes
import sys
import tkinter as tk

from PIL import Image

IS_WINDOWS = sys.platform == "win32"


def dpi_scale() -> float:
    if not IS_WINDOWS:
        return 1.0
    try:
        user32 = ctypes.WinDLL("user32")
        return max(1.0, user32.GetDpiForSystem() / 96.0)
    except (OSError, AttributeError):
        return 1.0


def enable_dpi_awareness() -> None:
    if not IS_WINDOWS:
        return
    try:
        ctypes.WinDLL("user32").SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2
    except (OSError, AttributeError):
        try:
            ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
        except (OSError, AttributeError):
            pass


class Surface:
    def __init__(self, window: tk.Tk, width: int, height: int, scale: float = 1.0):
        self.window = window
        self.width, self.height = width, height
        self.scale = scale
        self.out_w, self.out_h = round(width * scale), round(height * scale)

    @property
    def hwnd(self) -> int:
        return 0

    def update(self, image: Image.Image) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass


class CanvasSurface(Surface):
    def __init__(self, window, width, height, scale=1.0):
        super().__init__(window, width, height, scale)
        self.canvas = tk.Canvas(window, width=self.out_w, height=self.out_h, bg="#1c1f2b",
                                highlightthickness=0, bd=0)
        self.canvas.pack()
        self.photo = None
        self.item = None

    def update(self, image: Image.Image) -> None:
        from PIL import ImageTk
        if (image.width, image.height) != (self.out_w, self.out_h):
            image = image.resize((self.out_w, self.out_h), Image.Resampling.LANCZOS)
        bg = Image.new("RGBA", image.size, (28, 31, 43, 255))
        bg.alpha_composite(image)
        self.photo = ImageTk.PhotoImage(bg)
        if self.item is None:
            self.item = self.canvas.create_image(0, 0, anchor="nw", image=self.photo)
        else:
            self.canvas.itemconfigure(self.item, image=self.photo)


if IS_WINDOWS:
    from ctypes import wintypes

    class _POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    class _SIZE(ctypes.Structure):
        _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]

    class _BLENDFUNCTION(ctypes.Structure):
        _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                    ("SourceConstantAlpha", ctypes.c_ubyte), ("AlphaFormat", ctypes.c_ubyte)]

    class _BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

    GWL_EXSTYLE = -20
    WS_EX_LAYERED = 0x00080000
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_TOPMOST = 0x00000008
    WS_EX_APPWINDOW = 0x00040000
    ULW_ALPHA = 0x00000002
    AC_SRC_OVER = 0x00
    AC_SRC_ALPHA = 0x01

    class LayeredSurface(Surface):
        def __init__(self, window: tk.Tk, width: int, height: int, scale: float = 1.0):
            super().__init__(window, width, height, scale)
            self.user = ctypes.WinDLL("user32", use_last_error=True)
            self.gdi = ctypes.WinDLL("gdi32", use_last_error=True)
            self.winmm = ctypes.WinDLL("winmm", use_last_error=True)
            u, g = self.user, self.gdi
            is64 = ctypes.sizeof(ctypes.c_void_p) == 8
            self._get_long = u.GetWindowLongPtrW if is64 else u.GetWindowLongW
            self._set_long = u.SetWindowLongPtrW if is64 else u.SetWindowLongW
            self._get_long.argtypes = [wintypes.HWND, ctypes.c_int]
            self._get_long.restype = ctypes.c_ssize_t
            self._set_long.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
            self._set_long.restype = ctypes.c_ssize_t
            u.GetParent.argtypes = [wintypes.HWND]
            u.GetParent.restype = wintypes.HWND
            u.GetDC.argtypes = [wintypes.HWND]
            u.GetDC.restype = wintypes.HDC
            u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
            u.UpdateLayeredWindow.argtypes = [wintypes.HWND, wintypes.HDC, ctypes.POINTER(_POINT), ctypes.POINTER(_SIZE),
                                              wintypes.HDC, ctypes.POINTER(_POINT), wintypes.COLORREF,
                                              ctypes.POINTER(_BLENDFUNCTION), wintypes.DWORD]
            u.UpdateLayeredWindow.restype = wintypes.BOOL
            g.CreateCompatibleDC.argtypes = [wintypes.HDC]
            g.CreateCompatibleDC.restype = wintypes.HDC
            g.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(_BITMAPINFOHEADER), wintypes.UINT,
                                           ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
            g.CreateDIBSection.restype = wintypes.HBITMAP
            g.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
            g.SelectObject.restype = wintypes.HGDIOBJ
            g.DeleteObject.argtypes = [wintypes.HGDIOBJ]
            g.DeleteDC.argtypes = [wintypes.HDC]

            window.update_idletasks()
            self._hwnd = u.GetParent(window.winfo_id()) or window.winfo_id()
            style = self._get_long(self._hwnd, GWL_EXSTYLE)
            style = (style | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) & ~WS_EX_APPWINDOW
            self._set_long(self._hwnd, GWL_EXSTYLE, style)

            header = _BITMAPINFOHEADER()
            header.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
            header.biWidth = self.out_w
            header.biHeight = -self.out_h  # top-down
            header.biPlanes = 1
            header.biBitCount = 32
            header.biCompression = 0  # BI_RGB
            self.bits = ctypes.c_void_p()
            screen = u.GetDC(None)
            self.dc = g.CreateCompatibleDC(screen)
            self.bitmap = g.CreateDIBSection(screen, ctypes.byref(header), 0, ctypes.byref(self.bits), None, 0)
            u.ReleaseDC(None, screen)
            if not self.bitmap or not self.dc:
                raise ctypes.WinError(ctypes.get_last_error())
            self.old = g.SelectObject(self.dc, self.bitmap)
            self.closed = False
            self.winmm.timeBeginPeriod(1)
            self._size = _SIZE(self.out_w, self.out_h)
            self._src = _POINT(0, 0)
            self._blend = _BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
            self._buffer_len = self.out_w * self.out_h * 4

        @property
        def hwnd(self) -> int:
            return self._hwnd

        def update(self, image: Image.Image) -> None:
            if self.closed:
                return
            if (image.width, image.height) != (self.out_w, self.out_h):
                image = image.resize((self.out_w, self.out_h), Image.Resampling.LANCZOS)
            raw = image.convert("RGBa").tobytes("raw", "BGRa")  # premultiplied BGRA
            ctypes.memmove(self.bits, raw, min(len(raw), self._buffer_len))
            if not self.user.UpdateLayeredWindow(self._hwnd, None, None, ctypes.byref(self._size), self.dc,
                                                 ctypes.byref(self._src), 0, ctypes.byref(self._blend), ULW_ALPHA):
                raise ctypes.WinError(ctypes.get_last_error())

        def close(self) -> None:
            if self.closed:
                return
            self.closed = True
            self.gdi.SelectObject(self.dc, self.old)
            self.gdi.DeleteObject(self.bitmap)
            self.gdi.DeleteDC(self.dc)
            self.winmm.timeEndPeriod(1)


def make_surface(window: tk.Tk, width: int, height: int, scale: float = 1.0) -> Surface:
    if IS_WINDOWS:
        return LayeredSurface(window, width, height, scale)
    return CanvasSurface(window, width, height, scale)
