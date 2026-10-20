"""The island window (Tk) — input, animation loop and routing of core events.

The island works with either front-end for the chat:
  * WebPanel (pywebview)   — preferred; the island runs on a worker thread
  * Tk panel (ui.py)       — fallback when pywebview is unavailable
"""
from __future__ import annotations

import queue
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

from . import APP_NAME, WINDOW_TITLE, dragdrop
from .compositor import dpi_scale, enable_dpi_awareness, make_surface
from .core import Core
from .island import NOTCH_W, Island, Scene
from .runtime import IS_WINDOWS, data_folder

PANEL_W, PANEL_H = 480, 660


class Buddy:
    def __init__(self, core: Core, web_panel=None):
        self.core = core
        self.state = core.state
        self.web = web_panel
        self.events: queue.Queue = queue.Queue()
        core.subscribe(lambda kind, data: self.events.put((kind, data)))

        self.toast: tuple[str, float] | None = None
        self.reaction: tuple[str, float] | None = None
        self.pinned = False
        self.hover_until = 0.0
        self.open_until = 0.0
        self.pointer: tuple[int, int] | None = None
        self.drag: tuple[int, int, int, int] | None = None
        self.moved = False
        self.closing = False
        self.composer = ""
        self.composer_focus = False
        self.typing_until = 0.0
        self.reply = ""
        self.reply_live = False
        self.reply_until = 0.0

        self.root = tk.Tk()
        self.root.title(WINDOW_TITLE)
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#000000")
        self.scale = dpi_scale()
        self.island = Island(self.state.settings["display_mode"])
        self._place_window()
        self.surface = make_surface(self.root, *self.island.size, self.scale)
        self.root.update_idletasks()
        self._bind_input()
        self.drops = dragdrop.install(self.root, self.core.attach, hwnd=self.surface.hwnd)

        # Fallback Tk panel
        self.panel = None
        self.panel_drops = None
        self.tasks_win = self.settings_win = self.connect_win = None
        if self.web is None:
            from .ui import ChatPanel
            self.panel = ChatPanel(self)
            self.panel_drops = dragdrop.install(self.panel.win, self.core.attach)
            self.panel.show_model_picker(self.state.settings["provider"] == "ollama")
            self.panel.set_models(self.core.models, self.state.settings.get("ollama_model", ""))

        self._frame()
        self._poll()

    # ------------------------------------------------------------ helpers
    @property
    def assistant_name(self) -> str:
        return self.core.assistant_name

    @property
    def boss_name(self) -> str:
        return self.core.boss_name

    def _bind_input(self):
        target = getattr(self.surface, "canvas", self.root)
        target.bind("<Motion>", self._on_motion)
        target.bind("<Leave>", self._on_leave)
        target.bind("<ButtonPress-1>", self._on_press)
        target.bind("<B1-Motion>", self._on_drag)
        target.bind("<ButtonRelease-1>", self._on_release)
        target.bind("<Double-Button-1>", self._on_double)
        target.bind("<Button-3>", self._on_menu)
        self.root.bind("<Key>", self._on_key)
        self.root.bind("<FocusOut>", lambda e: self._blur())

    def _blur(self):
        self.composer_focus = False

    def _on_double(self, event):
        hit = self.island.hit(*self._island_coords(event))
        if hit not in ("input", "mode", "send"):
            self.show_chat()

    def _on_key(self, event):
        if not self.composer_focus or self.island.mode != "notch":
            return
        key = event.keysym
        now = time.perf_counter()
        self.typing_until = now + 25
        if key == "Return":
            if self.core.chat_busy:
                return "break"
            text, self.composer = self.composer.strip(), ""
            if text:
                self.core.submit(text)
        elif key == "Escape":
            self.composer = ""
            self.composer_focus = False
            self.typing_until = 0.0
        elif key == "BackSpace":
            self.composer = self.composer[:-1]
        elif key.lower() == "v" and (event.state & 0x0004):
            try:
                self.composer += self.root.clipboard_get().replace("\n", " ")
            except tk.TclError:
                pass
        elif event.char and event.char.isprintable() and not (event.state & 0x0004):
            self.composer += event.char
        return "break"

    def _place_window(self):
        w, h = self.island.size
        ow, oh = round(w * self.scale), round(h * self.scale)
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        if self.island.mode == "notch":
            x, y = (sw - ow) // 2, 0
        else:
            saved = self.state.settings.get("pet_pos")
            if isinstance(saved, list) and len(saved) == 2:
                x, y = max(0, min(sw - ow, int(saved[0]))), max(0, min(sh - oh, int(saved[1])))
            else:
                x, y = sw - ow - 16, sh - oh - 64
        self.root.geometry(f"{ow}x{oh}+{x}+{y}")

    def say(self, text: str, reaction: str | None = None, bounce: float = 0.0, keep_open: float = 5.0):
        now = time.perf_counter()
        self.toast = (text, now)
        if reaction:
            self.reaction = (reaction, now)
        if bounce:
            self.island.bounce(bounce)
        self.open_until = max(self.open_until, now + keep_open)

    def _scene(self, now: float) -> Scene:
        core = self.core
        return Scene(
            now=now, mode=self.island.mode, pointer=self.pointer or getattr(self, 'cursor', None),
            expanded=self.pinned or now < self.hover_until or now < self.open_until
                     or now < self.typing_until or core.chat_busy or now < self.reply_until,
            assistant_name=self.assistant_name, boss_name=self.boss_name,
            headline=self.state.headline(),
            feeds={name: self.state.agent_activity(name) for name in ("claude", "codex")},
            linked={name: self.state.agent_linked(name) for name in ("claude", "codex")},
            provider=core.provider.name, provider_label=core.provider.label,
            provider_detail=core.provider_detail, accent=core.accent_rgb(),
            files_count=len(self.state.files),
            tasks_open=sum(1 for t in self.state.tasks if not t.get("done")),
            toast=self.toast, reaction=self.reaction, chat_busy=core.chat_busy,
            composer=self.composer, composer_focus=self.composer_focus and self.island.mode == "notch",
            agent_mode=core.agent_mode, reply=self.reply if now < self.reply_until else "",
            reply_live=self.reply_live,
            idle_for=now - max(getattr(self, 'last_cursor_move', 0.0), self.open_until - 5, self.typing_until - 25),
        )

    # ---------------------------------------------------------- main loop
    def _frame(self):
        if self.closing:
            return
        now = time.perf_counter()
        try:  # global cursor so the eyes follow the mouse anywhere on screen
            gx, gy = self.root.winfo_pointerxy()
            cursor = (round((gx - self.root.winfo_x()) / self.scale), round((gy - self.root.winfo_y()) / self.scale))
            if cursor != getattr(self, "cursor", None):
                if getattr(self.island, "asleep", False):  # wake up with a jolt
                    self.reaction = ("poke", now)
                    self.island.bounce(1.4)
                self.last_cursor_move = now
            self.cursor = cursor
        except tk.TclError:
            self.cursor = None
        scene = self._scene(now)
        try:
            self.surface.update(self.island.render(scene))
        except Exception as exc:
            if now - getattr(self, "_last_render_error", 0) > 60:
                self._last_render_error = now
                print(f"render error: {exc}", file=sys.stderr)
        if self.toast and now - self.toast[1] > 6.5:
            self.toast = None
        if self.reaction and now - self.reaction[1] > 2.5:
            self.reaction = None
        if not scene.expanded:
            self.composer_focus = False
            if self.reply and not self.reply_live:
                self.reply, self.reply_until = "", 0.0
        animating = self.island.is_animating(scene) or self.pointer is not None
        delay = 16 if animating else 50
        self.root.after(delay, self._frame)

    def _poll(self):
        if self.closing:
            return
        try:
            while True:
                kind, data = self.events.get_nowait()
                self._event(kind, data)
        except queue.Empty:
            pass
        self.root.after(40, self._poll)

    # ------------------------------------------------------------ events
    def _event(self, kind: str, d: dict):
        now = time.perf_counter()
        p = self.panel  # Tk fallback panel (None when the web panel is active)
        if kind == "agent" and d.get("source") == "chat":
            return  # inline chat progress is drawn from the feed; toasts come from chat.* events
        if kind == "agent":
            agent, state, message = d["agent"], d["state"], d.get("message", "")
            self.open_until = max(self.open_until, now + (12 if state in ("waiting", "error") else 5))
            suffix = f": {message}" if message else "."
            if state == "done":
                self.say(f"{agent.title()} finished{suffix}", reaction="done", bounce=0.8)
            elif state == "error":
                self.say(f"{agent.title()} hit an error{suffix}", reaction="error", bounce=0.6, keep_open=10)
            elif state == "waiting":
                self.say(f"{agent.title()} needs you{suffix}", reaction="waiting", bounce=0.6, keep_open=10)
        elif kind == "say":
            self.say(d["text"], reaction=d.get("reaction") or "speak", bounce=0.4)
        elif kind == "files":
            added = d.get("added") or []
            if added:
                names = ", ".join(Path(x).name for x in added[:3]) + ("…" if len(added) > 3 else "")
                self.say(f"Got it — {names}", reaction="receive", bounce=1.0)
            if p:
                p.refresh_files()
                if added:
                    p.add_system(f"Attached: {names}")
        elif kind == "reminder":
            self.say(f"Reminder: {d['message']}", reaction="waiting", bounce=1.0, keep_open=10)
            try:
                self.root.bell()
            except tk.TclError:
                pass
            if p:
                p.add_system(f"Reminder: {d['message']}")
        elif kind == "chat.begin":
            self.open_until = max(self.open_until, now + 4)
            if self.island.mode == "notch":
                self.reply, self.reply_live, self.reply_until = "", True, now + 3600
            if p:
                p.begin_reply(d["label"])
                p.set_busy(True)
        elif kind == "chat.text":
            if self.reply_live:
                self.reply += d["chunk"]
            if p:
                p.stream(d["chunk"])
        elif kind == "chat.done":
            if self.reply_live:
                self.reply, self.reply_live, self.reply_until = d["text"], False, now + 30
                self.reaction = ("speak", now)
                self.island.bounce(0.5)
            else:
                snippet = d["text"].strip().splitlines()[0] if d["text"].strip() else "Done."
                self.say(snippet[:140] + ("…" if len(snippet) > 140 else ""), reaction="speak", bounce=0.5)
            if p:
                p.set_busy(False)
                p.end_reply()
        elif kind == "chat.error":
            if self.reply_live:
                self.reply_live = False
                self.reply, self.reply_until = ("" if d["stopped"] else d["message"]), now + 12
            if not d["stopped"]:
                self.say(d["message"][:140], reaction="error", bounce=0.4)
            if p:
                p.set_busy(False)
                p.end_reply()
                p.add_system(d["message"], error=True)
        elif kind == "hotkey":
            self.show_chat()
        elif kind == "display":
            self.set_display(d["mode"])
        elif kind == "quit":
            self.close()
        elif p:  # remaining events only matter to the Tk panel
            if kind == "chat.user":
                p.add_user(d["text"])
            elif kind == "chat.step":
                if d["tool"]:
                    p.add_step(d["tool"], d["detail"], d["status"])
            elif kind == "chat.system":
                p.add_system(d["text"], error=d.get("error", False))
            elif kind == "chat.cleared":
                p.render_history()
            elif kind == "provider":
                p.provider.select(d["name"])
                p.show_model_picker(d["name"] == "ollama")
                p.set_models(d["models"], d["model"])
                color = "#ff7882" if d["ok"] is False else "#9aa0b8"
                text = f"Checking {d['label']}…" if d["checking"] else f"{d['label']}" + (f" · {d['detail']}" if d["detail"] else "")
                p.set_status(text, color)
            elif kind == "tasks":
                if self.tasks_win and self.tasks_win.win.winfo_viewable():
                    self.tasks_win.refresh()
            elif kind == "settings":
                p.title.configure(text=self.assistant_name)
                p.win.title(f"{self.assistant_name} · Chat")

    # ------------------------------------------- delegates for the Tk panel
    def submit(self, text):
        self.core.submit(text)

    def set_provider(self, name):
        self.core.set_provider(name)

    def set_model(self, model):
        self.core.set_model(model)

    def refresh_models(self):
        self.core.refresh_models()

    def stop_chat(self):
        self.core.stop()

    def clear_chat(self):
        self.core.clear_chat()

    def pick_files(self):
        parent = self.panel.win if self.panel else self.root
        paths = filedialog.askopenfilenames(parent=parent, title="Attach files to Buddy")
        if paths:
            self.core.attach(paths)

    def open_path(self, path: str):
        if not self.core.open_path(path):
            if messagebox.askyesno("Open executable?", "This file can run code on your computer. Open it?",
                                   parent=self.panel.win if self.panel else self.root):
                self.core.open_path(path, confirmed=True)

    def apply_settings(self, **changes):
        problems = self.core.apply_settings(changes)
        if problems:
            messagebox.showwarning("Settings", "\n".join(problems), parent=self.settings_win.win if self.settings_win else self.root)
        elif changes.get("display_mode") and changes["display_mode"] != self.island.mode:
            self.set_display(changes["display_mode"])

    # ------------------------------------------------------------ windows
    def _panel_anchor(self) -> tuple[int, int]:
        """Screen position for the web panel: under the island (notch) or above the pet."""
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        if self.island.mode == "notch":
            x = self.root.winfo_x() + round(NOTCH_W * self.scale) // 2 - PANEL_W // 2
            y = round(self.island.height.value * self.scale) + 10
        else:
            x = self.root.winfo_x() + round(self.island.size[0] * self.scale) // 2 - PANEL_W // 2
            y = self.root.winfo_y() - PANEL_H - 8
        return max(8, min(sw - PANEL_W - 8, x)), max(8, min(sh - PANEL_H - 8, y))

    def _open(self, view: str):
        if self.web:
            x, y = self._panel_anchor()
            if view == "chat" and self.web.visible:
                self.web.hide()
            else:
                self.web.show(x, y, view)
            return
        if view == "chat":
            self.panel.show()
        elif view == "tasks":
            from .ui import TasksWindow
            self.tasks_win = self.tasks_win or TasksWindow(self)
            self.tasks_win.show()
        elif view == "settings":
            from .ui import SettingsWindow
            self.settings_win = self.settings_win or SettingsWindow(self)
            self.settings_win.show()
        elif view == "connect":
            from .ui import ConnectWindow
            self.connect_win = self.connect_win or ConnectWindow(self)
            self.connect_win.show()

    def show_chat(self):
        self._open("chat")

    def show_tasks(self):
        self._open("tasks")

    def show_settings(self):
        self._open("settings")

    def show_connect(self):
        self._open("connect")

    def set_display(self, mode: str):
        if mode not in ("notch", "pet") or mode == self.island.mode:
            return
        self.state.settings["display_mode"] = mode
        self.state.save()
        self.pinned = False
        self.island = Island(mode)
        self.surface.close()
        if hasattr(self.surface, "canvas"):
            self.surface.canvas.destroy()
        self._place_window()
        self.root.update_idletasks()
        self.surface = make_surface(self.root, *self.island.size, self.scale)
        if hasattr(self.surface, "canvas"):
            self._bind_input()

    # ------------------------------------------------------- mouse input
    def _island_coords(self, event) -> tuple[int, int]:
        return round(event.x / self.scale), round(event.y / self.scale)

    def _on_motion(self, event):
        self.pointer = self._island_coords(event)
        if self.island.hit(*self.pointer):
            self.hover_until = time.perf_counter() + 0.7

    def _on_leave(self, _event):
        self.pointer = None

    def _on_press(self, event):
        self.drag = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())
        self.moved = False

    def _on_drag(self, event):
        if not self.drag:
            return
        dx, dy = event.x_root - self.drag[0], event.y_root - self.drag[1]
        if abs(dx) + abs(dy) > 4:
            self.moved = True
        if not self.moved:
            return
        w, h = (round(v * self.scale) for v in self.island.size)
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        x = max(0, min(sw - w, self.drag[2] + dx))
        y = 0 if self.island.mode == "notch" else max(0, min(sh - h, self.drag[3] + dy))
        self.root.geometry(f"+{x}+{y}")

    def _on_release(self, event):
        self.drag = None
        if self.moved:
            if self.island.mode == "pet":
                self.state.settings["pet_pos"] = [self.root.winfo_x(), self.root.winfo_y()]
                self.state.save()
            return
        hit = self.island.hit(*self._island_coords(event))
        now = time.perf_counter()
        if hit == "input":
            self.composer_focus = True
            self.typing_until = now + 25
            try:
                self.root.focus_force()
            except tk.TclError:
                pass
            return
        if hit == "mode":
            self.core.set_agent_mode(not self.core.agent_mode)
            self.typing_until = max(self.typing_until, now + 8)
            return
        if hit == "send":
            if self.core.chat_busy:
                self.core.stop()
            else:
                text, self.composer = self.composer.strip(), ""
                if text:
                    self.core.submit(text)
            return
        if hit == "reply":
            self.show_chat()
            return
        if hit in ("chat", "tasks", "settings"):
            self._open(hit)
        elif hit == "files":
            self.pick_files()
        elif hit == "mascot":
            self.island.bounce(1.2)
            self.reaction = ("poke", time.perf_counter())
            if self.island.mode == "pet":
                self.show_chat()
        elif hit == "island":
            if self.island.mode == "pet":
                self.show_chat()
            else:
                self.pinned = not self.pinned

    def _on_menu(self, event):
        menu = tk.Menu(self.root, tearoff=0, bg="#141720", fg="#eef0fa", activebackground="#1c2030",
                       activeforeground="#eef0fa", relief="flat", bd=0, font=("Segoe UI", 10))
        menu.add_command(label="Open chat  (Win+Shift+B)" if IS_WINDOWS else "Open chat", command=self.show_chat)
        menu.add_command(label="Attach files…", command=self.pick_files)
        menu.add_command(label="Tasks", command=self.show_tasks)
        menu.add_separator()
        mode = tk.StringVar(value=self.island.mode)
        menu.add_radiobutton(label="Top of screen (notch)", variable=mode, value="notch", command=lambda: self.set_display("notch"))
        menu.add_radiobutton(label="Floating pet", variable=mode, value="pet", command=lambda: self.set_display("pet"))
        menu.add_separator()
        menu.add_command(label="Settings…", command=self.show_settings)
        menu.add_command(label="Connect AI apps…", command=self.show_connect)
        menu.add_separator()
        menu.add_command(label=f"Quit {APP_NAME}", command=self.close)
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def show_menu_at_pointer(self):
        event = type("E", (), {"x_root": self.root.winfo_pointerx(), "y_root": self.root.winfo_pointery()})()
        self._on_menu(event)

    # ---------------------------------------------------------------- end
    def close(self):
        if self.closing:
            return
        self.closing = True
        try:
            self.state.save()
            for drops in (self.drops, self.panel_drops):
                if drops:
                    drops.close()
            self.surface.close()
        finally:
            self.core.close()
            if self.web:
                self.web.close()
            try:
                self.root.destroy()
            except tk.TclError:
                pass

    def run(self):
        self.root.mainloop()


def launch() -> int:
    """Entry used by main.py: picks the web panel when available."""
    enable_dpi_awareness()
    core = Core(data_folder())
    core.start()
    from .hotkey import Hotkey
    hotkey = Hotkey(lambda: core.emit("hotkey"))
    hotkey.start()
    web = None
    try:
        from .panel import WebPanel
        if WebPanel.available():
            web = WebPanel(core)
    except Exception as exc:  # any problem with WebView2 → Tk panel
        print(f"web panel unavailable: {exc}", file=sys.stderr)
        web = None
    if web is None:
        Buddy(core).run()
    else:
        failure: list[BaseException] = []

        def island_thread():
            try:
                Buddy(core, web).run()
            except BaseException as exc:  # surface island crashes instead of hanging the GUI loop
                failure.append(exc)
            finally:
                web.close()

        threading.Thread(target=island_thread, daemon=True, name="buddy-island").start()
        web.run()
        if failure:
            raise failure[0]
    hotkey.stop()
    core.close()
    return 0
