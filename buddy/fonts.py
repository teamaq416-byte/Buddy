"""Font lookup for the island renderer (Segoe UI on Windows, sane fallbacks)."""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

_CANDIDATES = {
    "regular": ["segoeui.ttf", "Inter-Regular.otf", "Inter-Regular.ttf", "DejaVuSans.ttf", "Arial.ttf", "arial.ttf"],
    "medium": ["seguisb.ttf", "segoeuib.ttf", "Inter-Medium.otf", "Inter-Medium.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf"],
    "bold": ["segoeuib.ttf", "Inter-SemiBold.otf", "Inter-SemiBold.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf"],
    "mono": ["consola.ttf", "CascadiaMono.ttf", "DejaVuSansMono.ttf", "cour.ttf"],
}


def _font_dirs() -> list[Path]:
    dirs = []
    if sys.platform == "win32":
        dirs.append(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts")
        dirs.append(Path.home() / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        dirs += [Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library" / "Fonts"]
    dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"]
    return [d for d in dirs if d.exists()]


@lru_cache(maxsize=None)
def _locate(filename: str) -> str | None:
    for folder in _font_dirs():
        direct = folder / filename
        if direct.exists():
            return str(direct)
        try:
            for hit in folder.rglob(filename):
                return str(hit)
        except OSError:
            continue
    return None


@lru_cache(maxsize=64)
def font(weight: str = "regular", size: int = 13) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in _CANDIDATES.get(weight, _CANDIDATES["regular"]):
        path = _locate(name)
        if path:
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()
