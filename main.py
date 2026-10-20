"""Buddy entry point. Run `python main.py` or build with build.cmd."""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def ensure_pillow() -> None:
    """Running from source without Pillow: install it once, quietly."""
    try:
        import PIL  # noqa: F401
        return
    except ImportError:
        pass
    import subprocess
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--user", "pillow"], creationflags=flags)
    try:
        import PIL  # noqa: F401
    except ImportError:
        raise SystemExit("Buddy needs Pillow. Run:  python -m pip install pillow")


def main() -> int:
    ensure_pillow()
    from buddy.runtime import claim_instance, data_folder

    # A windowed (no-console) build has no stdio; keep prints and tracebacks somewhere useful.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(data_folder() / "buddy.log", "a", encoding="utf-8")

    if claim_instance() is None:
        return 0  # another Buddy is already running for this data folder
    try:
        from buddy.app import launch
        return launch()
    except Exception:
        log = data_folder() / "crash.log"
        log.write_text(traceback.format_exc(), "utf-8")
        try:
            import tkinter.messagebox as mb
            mb.showerror("Buddy could not start", f"Details were written to:\n{log}\n\n{traceback.format_exc()[-800:]}")
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
