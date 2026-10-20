"""Generate assets/buddy.ico and docs/preview.png from the mascot renderer."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

from buddy import mascot  # noqa: E402
from buddy.island import NOTCH_H, NOTCH_W, Island, Scene  # noqa: E402


def icon() -> None:
    frames = []
    for size in (256, 128, 64, 48, 32, 16):
        face = mascot.render(round(size * 0.86), "idle", t=0.0)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(face, ((size - face.width) // 2, (size - face.height) // 2))
        frames.append(canvas)
    out = ROOT / "assets" / "buddy.ico"
    out.parent.mkdir(exist_ok=True)
    frames[0].save(out, format="ICO", sizes=[(f.width, f.height) for f in frames], append_images=frames[1:])
    print("wrote", out)


def preview() -> None:
    feeds = {"claude": {"steps": [
        {"tool": "Read", "detail": "src/invoice.ts", "status": "done", "at": 0},
        {"tool": "Edit", "detail": "src/invoice.ts", "status": "done", "at": 0},
        {"tool": "Bash", "detail": "npm test -- invoice", "status": "running", "at": 0}]}}
    scenes = [
        Scene(now=0, files_count=2),
        Scene(now=0, expanded=True, headline=("claude", "working", "Refactoring invoice totals"), feeds=feeds,
              linked={"claude": True}, provider_label="Ollama", provider_detail="llama3.2"),
    ]
    sheet = Image.new("RGBA", (NOTCH_W, NOTCH_H * 2), (24, 26, 36, 255))
    for i, scene in enumerate(scenes):
        island = Island()
        for step in range(90):
            scene.now = step / 60
            frame = island.render(scene)
        sheet.alpha_composite(frame, (0, i * NOTCH_H))
    out = ROOT / "docs" / "preview.png"
    out.parent.mkdir(exist_ok=True)
    sheet.save(out)
    print("wrote", out)


if __name__ == "__main__":
    icon()
    preview()
