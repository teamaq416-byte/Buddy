"""The floating island: layout, animation and hit-testing.

`Island.render(scene)` returns the RGBA frame for the transparent window.
The app owns the window and timing; this module is pure drawing + a bit of
spring physics so it can be rendered head-less in tests.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter

from . import mascot
from .fonts import font

# Window sizes (the transparent window is always this big; content floats inside)
NOTCH_W, NOTCH_H = 560, 320
PET_W, PET_H = 300, 260

# Collapsed / expanded plate sizes in notch mode
PILL_W, PILL_H = 236, 38
PLATE_W, PLATE_H = 520, 196
PLATE_H_REPLY = 290

PLATE = (12, 13, 18, 246)
PLATE_EDGE = (255, 255, 255, 22)
TEXT = (238, 240, 250, 255)
MUTED = (150, 156, 178, 255)
DIM = (96, 102, 124, 255)
GOOD = (94, 234, 212)
WARN = (251, 191, 119)
BAD = (255, 120, 130)
BUTTON = (255, 255, 255, 14)
BUTTON_HOVER = (255, 255, 255, 34)

STATE_LABEL = {"idle": "Ready", "working": "Working", "waiting": "Needs you", "done": "Finished", "error": "Error"}
STATE_COLOR = {"idle": MUTED[:3], "working": (125, 211, 252), "waiting": WARN, "done": GOOD, "error": BAD}

QUICK_ACTIONS = ("chat", "files", "tasks", "settings")
ACTION_LABEL = {"chat": "Chat", "files": "Files", "tasks": "Tasks", "settings": "Settings"}


@dataclass
class Scene:
    now: float
    mode: str = "notch"                    # notch | pet
    pointer: tuple[int, int] | None = None # pointer in window coords (None = outside)
    expanded: bool = False                 # target
    assistant_name: str = "Buddy"
    boss_name: str = "Boss"
    headline: tuple[str, str, str] = ("", "idle", "")   # (agent, state, message)
    feeds: dict = field(default_factory=dict)            # agent -> {state, message, steps}
    linked: dict = field(default_factory=dict)           # agent -> bool
    provider: str = "ollama"
    provider_label: str = "Ollama"
    provider_detail: str = ""
    accent: tuple = (125, 211, 252)
    files_count: int = 0
    tasks_open: int = 0
    toast: tuple[str, float] | None = None               # (text, shown_at)
    reaction: tuple[str, float] | None = None            # (expression, started_at)
    chat_busy: bool = False
    composer: str = ""                                    # text typed into the island
    composer_focus: bool = False
    agent_mode: bool = False                              # Ask (False) / Do (True)
    reply: str = ""                                       # streaming / last reply shown inline
    reply_live: bool = False
    idle_for: float = 0.0                                 # seconds since last cursor move / activity


class Spring:
    """Critically-damped-ish spring for smooth UI motion."""

    def __init__(self, value: float = 0.0, stiffness: float = 180.0, damping: float = 22.0):
        self.value = value
        self.velocity = 0.0
        self.target = value
        self.stiffness = stiffness
        self.damping = damping

    def step(self, dt: float) -> float:
        dt = min(dt, 1 / 20)
        accel = (self.target - self.value) * self.stiffness - self.velocity * self.damping
        self.velocity += accel * dt
        self.value += self.velocity * dt
        if abs(self.value - self.target) < 0.0015 and abs(self.velocity) < 0.01:
            self.value, self.velocity = self.target, 0.0
        return self.value

    @property
    def settled(self) -> bool:
        return self.value == self.target and self.velocity == 0.0


def _smooth(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


@lru_cache(maxsize=8)
def _plate(width: int, height: int, radius: int, top_flat: bool) -> Image.Image:
    """Dark rounded plate with a hairline edge and a soft outer shadow."""
    ss = 3
    pad = 18 * ss
    w, h = width * ss, height * ss
    img = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("L", img.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + 6 * ss, pad + w, pad + h + 6 * ss], radius=radius * ss, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(9 * ss))
    img.alpha_composite(mascot._tint((0, 0, 0), shadow))
    d = ImageDraw.Draw(img)
    box = [pad, pad - (radius * ss if top_flat else 0), pad + w, pad + h]
    d.rounded_rectangle(box, radius=radius * ss, fill=PLATE)
    d.rounded_rectangle(box, radius=radius * ss, outline=PLATE_EDGE, width=ss)
    if top_flat:  # crop the part above the screen edge
        img = img.crop((0, pad, img.width, img.height))
    return img.resize((img.width // ss, img.height // ss), Image.Resampling.LANCZOS)


class _Layer:
    """Transparent RGBA drawing surface composited with one global alpha."""

    def __init__(self, size):
        self.img = Image.new("RGBA", size, (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def text(self, xy, text, fnt, color=TEXT):
        if text:
            self.d.text(xy, text, font=fnt, fill=tuple(color[:3]) + (255,))

    def dot(self, center, r, color):
        x, y = center
        self.d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(color[:3]) + (255,))

    def line(self, a, b, color):
        self.d.line([a, b], fill=color, width=1)

    def rounded(self, box, radius, fill):
        self.d.rounded_rectangle(box, radius=radius, fill=fill)

    def blit(self, image, pos):
        self.img.alpha_composite(image, pos)

    def step_icon(self, center, status, color, now):
        x, y = center
        rgba = tuple(color[:3]) + (255,)
        if status == "running":
            start = (now * 260) % 360
            self.d.arc([x - 5, y - 5, x + 5, y + 5], start, start + 250, fill=rgba, width=2)
        elif status == "done":
            self.d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=rgba)
            self.d.line([(x - 2.5, y), (x - 0.5, y + 2), (x + 3, y - 2.5)], fill=PLATE, width=2)
        else:
            self.d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=rgba)
            self.d.line([(x - 2.5, y - 2.5), (x + 2.5, y + 2.5)], fill=PLATE, width=2)
            self.d.line([(x - 2.5, y + 2.5), (x + 2.5, y - 2.5)], fill=PLATE, width=2)

    def composite_onto(self, img, alpha=1.0):
        Island._blit_alpha(img, self.img, (0, 0), alpha)


class Island:
    def __init__(self, mode: str = "notch"):
        self.mode = mode
        self.expand = Spring(0.0, 170.0, 20.0)
        self.height = Spring(PLATE_H, 170.0, 20.0)
        self.squash = Spring(0.0, 320.0, 14.0)
        self.hover_glow = Spring(0.0, 90.0, 16.0)
        self.look = [0.0, 0.0]
        self.last = time.perf_counter()
        self.blink_at = self.last + 2.5
        self.hits: dict[str, tuple[int, int, int, int]] = {}
        self.hover_action: str | None = None
        self.asleep = False
        self.frame: Image.Image | None = None

    # ---------------------------------------------------------------- api
    @property
    def size(self) -> tuple[int, int]:
        return (NOTCH_W, NOTCH_H) if self.mode == "notch" else (PET_W, PET_H)

    def bounce(self, strength: float = 1.0) -> None:
        self.squash.velocity += 9.0 * strength

    def hit(self, x: int, y: int) -> str | None:
        """Most specific region under (x, y); 'island' (the whole plate) is the fallback."""
        best, best_area = None, None
        for name, (x0, y0, x1, y1) in self.hits.items():
            if x0 <= x <= x1 and y0 <= y <= y1:
                area = (x1 - x0) * (y1 - y0)
                if best_area is None or area < best_area:
                    best, best_area = name, area
        return best

    def is_animating(self, scene: Scene) -> bool:
        if not (self.expand.settled and self.squash.settled and self.hover_glow.settled and self.height.settled):
            return True
        if scene.composer_focus or scene.reply_live:
            return True
        state = scene.headline[1]
        if state in ("working",) or scene.chat_busy:
            return True
        if scene.toast and scene.now - scene.toast[1] < 6.0:
            return True
        if scene.reaction and scene.now - scene.reaction[1] < 2.5:
            return True
        return scene.now > self.blink_at - 0.05 and scene.now < self.blink_at + 0.3

    # ------------------------------------------------------------ helpers
    def _expression(self, scene: Scene) -> tuple[str, float]:
        """(expression, blink) for this frame."""
        now = scene.now
        if scene.reaction and now - scene.reaction[1] < 2.2:
            return scene.reaction[0], 0.0
        state = scene.headline[1]
        if scene.chat_busy and state == "idle":
            state = "working"
        if state in ("idle", "done") and not scene.chat_busy and scene.idle_for > 60:
            self.asleep = True
            return "sleep", 0.0
        self.asleep = False
        expression = {"idle": "idle", "working": "working", "waiting": "waiting", "done": "done", "error": "error"}[state]
        # Blink
        blink = 0.0
        if now >= self.blink_at:
            phase = (now - self.blink_at) / 0.22
            if phase >= 1.0:
                self.blink_at = now + 2.2 + (hash(int(now * 7)) % 100) / 40.0
            else:
                blink = math.sin(phase * math.pi)
        return expression, blink

    def _update_look(self, scene: Scene, face_center: tuple[float, float], dt: float) -> None:
        if scene.pointer is None:
            tx, ty = 0.0, 0.0
        else:
            dx = (scene.pointer[0] - face_center[0]) / 420.0
            dy = (scene.pointer[1] - face_center[1]) / 320.0
            tx, ty = max(-1.0, min(1.0, dx)), max(-1.0, min(1.0, dy))
        k = min(1.0, dt * 14.0)
        self.look[0] += (tx - self.look[0]) * k
        self.look[1] += (ty - self.look[1]) * k

    @staticmethod
    def _wrap(draw, text: str, fnt, max_w: int, max_lines: int) -> list[str]:
        """Greedy word wrap; the last line gets an ellipsis if text is cut."""
        lines: list[str] = []
        for para in text.split("\n"):
            words, current = para.split(), ""
            if not words:
                lines.append("")
            for word in words:
                probe = (current + " " + word).strip()
                if draw.textlength(probe, font=fnt) <= max_w or not current:
                    current = probe
                else:
                    lines.append(current)
                    current = word
            if current:
                lines.append(current)
            if len(lines) > max_lines:
                break
        lines = [ln for ln in lines if ln is not None]
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = Island._ellipsize(draw, lines[-1] + " …", fnt, max_w)
        return lines or [""]

    @staticmethod
    def _ellipsize(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> str:
        if draw.textlength(text, font=fnt) <= max_w:
            return text
        while text and draw.textlength(text + "…", font=fnt) > max_w:
            text = text[:-1]
        return text.rstrip() + "…"

    # ------------------------------------------------------------- render
    def render(self, scene: Scene) -> Image.Image:
        now = scene.now
        dt = max(0.0, min(0.1, now - self.last))
        self.last = now
        self.expand.target = 1.0 if (scene.expanded and self.mode == "notch") else 0.0
        self.height.target = PLATE_H_REPLY if scene.reply else PLATE_H
        self.squash.target = 0.0
        p = _smooth(self.expand.step(dt))
        self.height.step(dt)
        squash = max(-1.0, min(1.0, self.squash.step(dt)))
        self.hits = {}
        if self.mode == "pet":
            return self._render_pet(scene, dt, squash)
        return self._render_notch(scene, dt, p, squash)

    # notch -------------------------------------------------------------
    def _render_notch(self, scene: Scene, dt: float, p: float, squash: float) -> Image.Image:
        W, H = NOTCH_W, NOTCH_H
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        plate_w = round(PILL_W + (PLATE_W - PILL_W) * p)
        plate_h = round(PILL_H + (self.height.value - PILL_H) * p)
        radius = round(18 + 10 * p)
        plate = _plate(plate_w, plate_h, radius, True)
        px = (W - plate_w) // 2
        img.alpha_composite(plate, (px - 18, 0))
        self.hits["island"] = (px, 0, px + plate_w, plate_h)
        measure = ImageDraw.Draw(img)

        expression, blink = self._expression(scene)
        agent, state, message = scene.headline
        accent = STATE_COLOR.get(state, scene.accent) if state != "idle" else scene.accent
        busy = state == "working" or scene.chat_busy

        # --- collapsed content (fades out as we expand)
        if p < 0.999:
            layer = _Layer((W, H))
            alpha = 1.0 - _smooth(p * 1.6)
            face_size = 26
            face = mascot.render(face_size, expression, scene.now, tuple(self.look), blink, accent, squash=squash)
            fx = px + 14 - (face.width - face_size) // 2
            fy = (PILL_H - face.height) // 2 + 1
            layer.blit(face, (fx, fy))
            if state != "idle":
                label = f"{scene.assistant_name} · {STATE_LABEL.get(state, 'Ready')}"
            elif scene.chat_busy:
                label = f"{scene.assistant_name} · Thinking"
            else:
                label = scene.assistant_name
            text_font = font("medium", 13)
            layer.text((px + 50, 11), self._ellipsize(measure, label, text_font, plate_w - 84), text_font)
            dot_color = STATE_COLOR.get(state, scene.accent) if (state != "idle" or scene.chat_busy) else scene.accent
            if busy:
                pulse = 0.65 + 0.35 * math.sin(scene.now * 4)
                dot_color = tuple(round(c * pulse + 30 * (1 - pulse)) for c in dot_color[:3])
            layer.dot((px + plate_w - 18, PILL_H // 2), 3.5, dot_color)
            self._update_look(scene, (fx + face.width / 2, fy + face.height / 2), dt)
            layer.composite_onto(img, alpha)

        # --- expanded content (fades in)
        if p > 0.05:
            layer = _Layer((W, H))
            alpha = _smooth((p - 0.35) / 0.65)
            face_size = 62
            face = mascot.render(face_size, expression, scene.now, tuple(self.look), blink, accent, squash=squash)
            fx = px + 22 - (face.width - face_size) // 2
            fy = 22 - (face.height - face_size) // 2 + round(2 * math.sin(scene.now * 1.6))
            layer.blit(face, (fx, fy))
            self.hits["mascot"] = (fx + 6, fy + 4, fx + face.width - 6, fy + face.height - 4)
            if p > 0.5:
                self._update_look(scene, (fx + face.width / 2, fy + face.height / 2), dt)
            name_font, small = font("bold", 13), font("regular", 11)
            layer.text((px + 24, 96), self._ellipsize(measure, scene.assistant_name, name_font, 92), name_font)
            layer.text((px + 24, 114), self._ellipsize(measure, f"for {scene.boss_name}", small, 92), small, MUTED)
            layer.line((px + 126, 20), (px + 126, plate_h - 20), (255, 255, 255, 18))

            # Middle column: headline + feed
            col_x, col_w = px + 142, 220
            head_font = font("bold", 14)
            if agent:
                title = f"{agent.title()} · {STATE_LABEL.get(state, state.title())}"
                head_color = STATE_COLOR.get(state, scene.accent)
            elif scene.chat_busy:
                title = f"{scene.provider_label} · Thinking"
                head_color = scene.accent
            else:
                title = f"{scene.assistant_name} · Ready"
                head_color = DIM
            layer.dot((col_x + 4, 27), 3.2, head_color)
            layer.text((col_x + 14, 18), self._ellipsize(measure, title, head_font, col_w - 14), head_font)
            sub = message or ("Ready when you are" if not agent else "")
            if not agent and scene.chat_busy:
                sub = f"Replying via {scene.provider_label}"
            body_font = font("regular", 12)
            layer.text((col_x, 38), self._ellipsize(measure, sub, body_font, col_w), body_font, MUTED)
            steps = (scene.feeds.get(agent) or {}).get("steps", [])[-3:] if agent else []
            y = 64
            mono = font("mono", 11)
            composer_y = plate_h - 48
            if scene.reply:
                # Two most recent steps stay visible above the reply while working
                for step in steps[-2:] if scene.reply_live else []:
                    color = {"running": STATE_COLOR["working"], "done": GOOD, "error": BAD}[step["status"]]
                    layer.step_icon((col_x + 6, y + 8), step["status"], color, scene.now)
                    layer.text((col_x + 18, y), self._ellipsize(measure, step["tool"], body_font, 56), body_font)
                    layer.text((col_x + 76, y + 1), self._ellipsize(measure, step["detail"], mono, col_w - 76), mono, MUTED)
                    y += 20
                # Inline reply bubble: full width under the quick actions, clipped above the composer
                ry = max(y + 4, 108)
                rx0, rx1 = col_x - 6, px + plate_w - 24
                reply_font = font("regular", 12)
                max_lines = max(1, (composer_y - 12 - ry - 10) // 17)
                lines = self._wrap(measure, scene.reply.strip().replace("\r", ""), reply_font, rx1 - rx0 - 22, max_lines)
                box_h = len(lines) * 17 + 14
                layer.rounded((rx0, ry, rx1, ry + box_h), 12, (255, 255, 255, 10))
                for i, line in enumerate(lines):
                    layer.text((rx0 + 11, ry + 7 + i * 17), line, reply_font, TEXT)
                if scene.reply_live and int(scene.now * 2.2) % 2 == 0:
                    cx_ = rx0 + 11 + measure.textlength(lines[-1], font=reply_font) + 3
                    yy = ry + 9 + (len(lines) - 1) * 17
                    layer.rounded((cx_, yy, cx_ + 6, yy + 13), 2, scene.accent + (255,))
                self.hits["reply"] = (rx0, ry, rx1, ry + box_h)
            elif steps:
                for step in steps:
                    color = {"running": STATE_COLOR["working"], "done": GOOD, "error": BAD}[step["status"]]
                    layer.step_icon((col_x + 6, y + 8), step["status"], color, scene.now)
                    layer.text((col_x + 18, y), self._ellipsize(measure, step["tool"], body_font, 56), body_font)
                    layer.text((col_x + 76, y + 1), self._ellipsize(measure, step["detail"], mono, col_w - 76), mono, MUTED)
                    y += 20
            else:
                rows = []
                for name in ("claude", "codex"):
                    linked = scene.linked.get(name)
                    rows.append((name.title(), "Linked" if linked else "Not linked", GOOD if linked else DIM))
                rows.append(("Chat", scene.provider_label + (f" · {scene.provider_detail}" if scene.provider_detail else ""), scene.accent))
                for label, value, color in rows:
                    layer.dot((col_x + 6, y + 8), 2.6, color)
                    layer.text((col_x + 18, y), label, body_font)
                    layer.text((col_x + 86, y), self._ellipsize(measure, value, body_font, col_w - 86), body_font, MUTED)
                    y += 20

            # Right column: quick actions 2x2
            bw, bh, gap = 62, 34, 8
            bx, by = px + plate_w - 24 - 2 * bw - gap, 22
            button_font = font("medium", 12)
            hover = scene.pointer if p > 0.9 else None
            self.hover_action = None
            for i, action in enumerate(QUICK_ACTIONS):
                x0 = bx + (i % 2) * (bw + gap)
                y0 = by + (i // 2) * (bh + gap)
                box = (x0, y0, x0 + bw, y0 + bh)
                hovered = hover is not None and box[0] <= hover[0] <= box[2] and box[1] <= hover[1] <= box[3]
                if hovered:
                    self.hover_action = action
                layer.rounded(box, 11, BUTTON_HOVER if hovered else BUTTON)
                label = ACTION_LABEL[action]
                if action == "files" and scene.files_count:
                    label = f"Files · {scene.files_count}"
                if action == "tasks" and scene.tasks_open:
                    label = f"Tasks · {scene.tasks_open}"
                tw = measure.textlength(label, font=button_font)
                layer.text((x0 + (bw - tw) / 2, y0 + 9), label, button_font)
                if p > 0.9:
                    self.hits[action] = box
            foot = font("regular", 11)
            foot_text = scene.provider_label + (f" · {scene.provider_detail}" if scene.provider_detail else "")
            if not scene.reply:
                layer.text((bx, by + 2 * bh + gap + 10), self._ellipsize(measure, foot_text, foot, 2 * bw + gap), foot, DIM)

            # Inline composer: [ text … ] [Ask|Do] [➤]
            cx0, cx1 = px + 24, px + plate_w - 24
            cy0, cy1 = composer_y, composer_y + 34
            focused = scene.composer_focus
            layer.rounded((cx0, cy0, cx1, cy1), 17, (255, 255, 255, 20 if focused else 12))
            if focused:
                layer.d.rounded_rectangle((cx0, cy0, cx1, cy1), radius=17, outline=scene.accent + (150,), width=1)
            mode_w, send_w = 46, 26
            text_x, text_w = cx0 + 14, cx1 - cx0 - 14 - mode_w - send_w - 24
            in_font = font("regular", 12.5 if False else 12)
            if scene.composer:
                shown = scene.composer
                while shown and measure.textlength(shown, font=in_font) > text_w:
                    shown = shown[1:]
                layer.text((text_x, cy0 + 8), shown, in_font, TEXT)
                caret_x = text_x + measure.textlength(shown, font=in_font) + 1
            else:
                hint = "Do a task…" if scene.agent_mode else f"Ask {scene.assistant_name}…"
                layer.text((text_x, cy0 + 8), hint if not scene.chat_busy else "Thinking…", in_font, DIM)
                caret_x = text_x
            if focused and int(scene.now * 2) % 2 == 0 and not scene.chat_busy:
                layer.d.rectangle((caret_x, cy0 + 9, caret_x + 1, cy1 - 9), fill=TEXT)
            # mode chip
            mx0 = cx1 - send_w - 10 - mode_w
            chip_fill = scene.accent + (255,) if scene.agent_mode else (255, 255, 255, 22)
            layer.rounded((mx0, cy0 + 6, mx0 + mode_w, cy1 - 6), 11, chip_fill)
            chip_font = font("medium", 11)
            chip_text = "Do" if scene.agent_mode else "Ask"
            tw = measure.textlength(chip_text, font=chip_font)
            layer.text((mx0 + (mode_w - tw) / 2, cy0 + 9), chip_text, chip_font, (12, 13, 18) if scene.agent_mode else TEXT)
            self.hits["mode"] = (mx0, cy0, mx0 + mode_w, cy1)
            # send / stop button
            sx0 = cx1 - send_w - 5
            layer.dot((sx0 + send_w / 2, (cy0 + cy1) / 2), send_w / 2, BAD if scene.chat_busy else scene.accent)
            if scene.chat_busy:
                layer.d.rounded_rectangle((sx0 + 9, cy0 + 12, sx0 + send_w - 9, cy1 - 12), radius=2, fill=(12, 13, 18, 255))
            else:
                ax, ay = sx0 + send_w / 2, (cy0 + cy1) / 2
                layer.d.line([(ax, ay + 5), (ax, ay - 5)], fill=(12, 13, 18, 255), width=2)
                layer.d.line([(ax - 4, ay - 1), (ax, ay - 5), (ax + 4, ay - 1)], fill=(12, 13, 18, 255), width=2)
            self.hits["send"] = (sx0, cy0, sx0 + send_w, cy1)
            self.hits["input"] = (cx0, cy0, mx0 - 4, cy1)
            layer.composite_onto(img, alpha)

        if busy:
            self._shimmer(img, px, plate_h - 3, plate_w, radius, accent, scene.now)
        if scene.toast:
            self._toast(img, scene, (W // 2, plate_h + 12), above=False)
        return img

    # pet ---------------------------------------------------------------
    def _render_pet(self, scene: Scene, dt: float, squash: float) -> Image.Image:
        W, H = PET_W, PET_H
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        expression, blink = self._expression(scene)
        agent, state, message = scene.headline
        accent = STATE_COLOR.get(state, scene.accent) if state != "idle" else scene.accent
        size = 92
        face = mascot.render(size, expression, scene.now, tuple(self.look), blink, accent, squash=squash)
        bob = round(3 * math.sin(scene.now * 1.4))
        fx = (W - face.width) // 2
        fy = H - face.height - 24 + bob
        img.alpha_composite(face, (fx, fy))
        self.hits["mascot"] = (fx + 8, fy + 8, fx + face.width - 8, fy + face.height - 8)
        self._update_look(scene, (fx + face.width / 2, fy + face.height / 2), dt)
        layer = _Layer((W, H))
        measure = layer.d
        if state != "idle":
            label = f"{scene.assistant_name} · {STATE_LABEL.get(state, state.title())}"
        elif scene.chat_busy:
            label = f"{scene.assistant_name} · Thinking"
        else:
            label = scene.assistant_name
        tag_font = font("medium", 12)
        tag_w = int(measure.textlength(label, font=tag_font) + 30)
        tx0, ty0 = (W - tag_w) // 2, H - 20
        layer.rounded((tx0, ty0 - 2, tx0 + tag_w, ty0 + 18), 10, PLATE)
        layer.dot((tx0 + 11, ty0 + 8), 3, accent if (state != "idle" or scene.chat_busy) else DIM)
        layer.text((tx0 + 20, ty0 + 1), label, tag_font)
        layer.composite_onto(img)
        self.hits["island"] = (tx0, ty0 - 2, tx0 + tag_w, ty0 + 18)
        if scene.toast:
            self._toast(img, scene, (W // 2, fy - 10), above=True)
        return img

    # drawing primitives --------------------------------------------------
    # All content is drawn with opaque inks onto transparent overlay layers,
    # then alpha-composited; ImageDraw itself replaces pixels, so drawing
    # translucent shapes straight onto the plate would punch holes in it.
    @staticmethod
    def _blit_alpha(img: Image.Image, layer: Image.Image, pos, alpha: float):
        if alpha <= 0.02:
            return
        if alpha < 0.999:
            layer = layer.copy()
            layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha)))
        img.alpha_composite(layer, pos)

    @staticmethod
    def _shimmer(img: Image.Image, x: int, y: int, w: int, radius: int, color, now: float):
        bar = Image.new("RGBA", (w, 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(bar)
        center = ((now * 0.6) % 1.4 - 0.2) * w
        for i in range(0, w, 2):
            dist = abs(i - center) / (w * 0.22)
            a = int(170 * max(0.0, 1 - dist) ** 2)
            if a:
                d.line([(i, 0), (i, 2)], fill=tuple(color[:3]) + (a,))
        # Keep the shimmer inside the rounded corners
        mask = Image.new("L", (w, 2), 0)
        ImageDraw.Draw(mask).rectangle([radius // 2, 0, w - radius // 2, 2], fill=255)
        bar.putalpha(Image.composite(bar.getchannel("A"), mask, mask))
        img.alpha_composite(bar, (x, y))

    def _toast(self, img: Image.Image, scene: Scene, anchor, above: bool):
        text, since = scene.toast
        age = scene.now - since
        life = 6.0
        if age > life:
            return
        enter = _smooth(min(1.0, age / 0.28))
        leave = _smooth(min(1.0, max(0.0, (life - age) / 0.35)))
        alpha = enter * leave
        offset = round((1 - enter) * 10)
        d = ImageDraw.Draw(img)
        fnt = font("regular", 12)
        max_w = min(img.width - 40, 360)
        # wrap
        words, lines, current = text.split(), [], ""
        for word in words:
            probe = (current + " " + word).strip()
            if d.textlength(probe, font=fnt) <= max_w - 28:
                current = probe
            else:
                if current:
                    lines.append(current)
                current = word
        if current:
            lines.append(current)
        lines = lines[:3]
        line_h = 17
        tw = max(d.textlength(line, font=fnt) for line in lines) if lines else 0
        bw, bh = int(tw + 28), int(len(lines) * line_h + 16)
        x0 = anchor[0] - bw // 2
        y0 = (anchor[1] - bh - offset) if above else (anchor[1] + offset)
        box = (x0, y0, x0 + bw, y0 + bh)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle(box, radius=14, fill=PLATE, outline=PLATE_EDGE, width=1)
        # little pointer
        cx = anchor[0]
        if above:
            ld.polygon([(cx - 6, y0 + bh - 1), (cx + 6, y0 + bh - 1), (cx, y0 + bh + 6)], fill=PLATE)
        else:
            ld.polygon([(cx - 6, y0 + 1), (cx + 6, y0 + 1), (cx, y0 - 6)], fill=PLATE)
        for i, line in enumerate(lines):
            ld.text((x0 + 14, y0 + 8 + i * line_h), line, font=fnt, fill=TEXT)
        self._blit_alpha(img, layer, (0, 0), alpha)
