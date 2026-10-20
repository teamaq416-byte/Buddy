"""Buddy's face: a soft squircle "pebble" with expressive eyes.

Everything is drawn 4x oversampled and downscaled with Lanczos, so edges
are smooth at any size. The body sprite is cached; only eyes, mouth and
accents are redrawn per frame.
"""
from __future__ import annotations

import math
from functools import lru_cache

from PIL import Image, ImageDraw

SS = 4  # supersampling factor

BODY_TOP = (250, 250, 255, 255)
BODY_BOTTOM = (226, 229, 242, 255)
INK = (24, 27, 40, 255)
BLUSH = (255, 150, 160, 110)
SHADOW = (0, 0, 0, 90)

EXPRESSIONS = ("idle", "working", "waiting", "done", "error", "receive", "speak", "sleep", "poke")


def _squircle_points(cx: float, cy: float, rx: float, ry: float, n: float = 2.0, steps: int = 240):
    """Body outline. n=2 is a perfect circle/ellipse (Buddy is round)."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = cx + rx * math.copysign(abs(c) ** (2 / n), c)
        y = cy + ry * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    return pts


def _tint(color, alpha_mask: Image.Image) -> Image.Image:
    """Solid colour layer whose alpha is `alpha_mask` (L mode)."""
    layer = Image.new("RGBA", alpha_mask.size, color + (0,))
    layer.putalpha(alpha_mask)
    return layer


@lru_cache(maxsize=16)
def body_sprite(size: int) -> Image.Image:
    """Flat white disc (no gradient, no shadow) at `size` px, with padding for eye travel."""
    big = size * SS
    pad = int(big * 0.18)
    canvas = Image.new("RGBA", (big + pad * 2, big + pad * 2), (0, 0, 0, 0))
    cx = cy = big / 2 + pad
    ImageDraw.Draw(canvas).polygon(_squircle_points(cx, cy, big * 0.5, big * 0.5), fill=(243, 244, 251, 255))
    return canvas.resize((canvas.width // SS, canvas.height // SS), Image.Resampling.LANCZOS)


def render(size: int, expression: str = "idle", t: float = 0.0, look=(0.0, 0.0), blink: float = 0.0,
           accent=(140, 160, 255), energy: float = 0.0, squash: float = 0.0) -> Image.Image:
    """Return an RGBA image (with padding) of the face.

    size        body width in output pixels
    expression  one of EXPRESSIONS
    t           seconds, drives subtle animation
    look        (-1..1, -1..1) gaze offset
    blink       0 open … 1 closed
    energy      0..1 extra motion (used for 'receive'/'poke' bounce)
    squash      -1..1 vertical squash/stretch for bounce feedback
    """
    base = body_sprite(size)
    face = Image.new("RGBA", (base.width * SS, base.height * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(face)
    s = size * SS
    cx, cy = base.width * SS / 2, base.height * SS / 2
    ex = s * 0.17  # eye x offset from centre
    ey = cy - s * 0.02
    eye_w, eye_h = s * 0.075, s * 0.17
    gaze_x, gaze_y = look[0] * s * 0.12, look[1] * s * 0.05

    def eye_capsule(x, y, w, h, fill=INK):
        d.rounded_rectangle([x - w, y - h, x + w, y + h], radius=w, fill=fill)

    def closed_eye(x, y, w, happy=True):
        if happy:
            d.arc([x - w * 1.6, y - w * 1.4, x + w * 1.6, y + w * 1.2], 200, 340, fill=INK, width=int(s * 0.03))
        else:
            d.rounded_rectangle([x - w * 1.5, y - w * 0.25, x + w * 1.5, y + w * 0.25], radius=w * 0.25, fill=INK)

    expression = expression if expression in EXPRESSIONS else "idle"
    open_amount = max(0.0, 1.0 - blink)

    if expression == "done":
        for sign in (-1, 1):
            closed_eye(cx + sign * ex + gaze_x * 0.3, ey, eye_w, happy=True)
        # Smile + blush
        d.arc([cx - s * 0.1, ey + s * 0.02, cx + s * 0.1, ey + s * 0.17], 15, 165, fill=INK, width=int(s * 0.028))
        for sign in (-1, 1):
            d.ellipse([cx + sign * ex * 1.45 - s * 0.06, ey + s * 0.08, cx + sign * ex * 1.45 + s * 0.06, ey + s * 0.15], fill=BLUSH)
    elif expression == "sleep":
        for sign in (-1, 1):
            closed_eye(cx + sign * ex, ey + s * 0.03, eye_w, happy=False)
        d.rounded_rectangle([cx - s * 0.03, ey + s * 0.12, cx + s * 0.03, ey + s * 0.135], radius=s * 0.01, fill=INK)
    elif expression == "error":
        # Dizzy spirals
        for sign in (-1, 1):
            x0, y0 = cx + sign * ex, ey
            pts = []
            for i in range(90):
                a = i / 90 * math.pi * 4 + t * 6 * sign
                r = s * 0.11 * i / 90
                pts.append((x0 + math.cos(a) * r, y0 + math.sin(a) * r * 0.9))
            d.line(pts, fill=INK, width=int(s * 0.03), joint="curve")
        d.rounded_rectangle([cx - s * 0.06, ey + s * 0.13, cx + s * 0.06, ey + s * 0.16], radius=s * 0.012, fill=INK)
    else:
        wide = {"waiting": 1.18, "receive": 1.2, "poke": 1.15}.get(expression, 1.0)
        narrow = 0.72 if expression == "working" else 1.0
        h = eye_h * wide * narrow * open_amount
        w = eye_w * (1.08 if expression in ("waiting", "receive") else 1.0)
        for sign in (-1, 1):
            x = cx + sign * ex + gaze_x
            y = ey + gaze_y
            if h < eye_w * 0.5:  # mid blink: thin line
                d.rounded_rectangle([x - w, y - eye_w * 0.35, x + w, y + eye_w * 0.35], radius=eye_w * 0.3, fill=INK)
            else:
                eye_capsule(x, y, w, h)
        if expression == "waiting":
            # Raised brows
            for sign in (-1, 1):
                x = cx + sign * ex + gaze_x
                d.arc([x - w * 1.5, ey - eye_h * 1.5 - s * 0.02, x + w * 1.5, ey - eye_h * 0.9],
                      200, 340, fill=INK, width=int(s * 0.022))
            d.ellipse([cx - s * 0.035, ey + s * 0.11, cx + s * 0.035, ey + s * 0.17], outline=INK, width=int(s * 0.024))
        elif expression == "receive":
            m = 0.5 + 0.5 * math.sin(t * 14)
            d.ellipse([cx - s * 0.06, ey + s * 0.10, cx + s * 0.06, ey + s * 0.12 + s * 0.08 * m], fill=INK)
        elif expression == "speak":
            m = 0.5 + 0.5 * math.sin(t * 11)
            d.rounded_rectangle([cx - s * 0.055, ey + s * 0.11, cx + s * 0.055, ey + s * 0.125 + s * 0.06 * m],
                                radius=s * 0.025, fill=INK)
        elif expression == "working":
            d.rounded_rectangle([cx - s * 0.045, ey + s * 0.125, cx + s * 0.045, ey + s * 0.145], radius=s * 0.01, fill=INK)
        elif expression == "poke":
            d.ellipse([cx - s * 0.04, ey + s * 0.1, cx + s * 0.04, ey + s * 0.16], fill=INK)
        else:
            pass  # idle: just the eyes, like the reference

    face = face.resize(base.size, Image.Resampling.LANCZOS)
    out = base.copy()
    out.alpha_composite(face)

    if squash:
        w, h = out.size
        out = out.resize((max(1, round(w * (1 + 0.08 * squash))), max(1, round(h * (1 - 0.12 * squash)))),
                         Image.Resampling.BICUBIC)
    return out
