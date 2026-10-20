"""Tk windows: chat panel, settings, tasks and the Connect AI dialog.

All windows are plain tkinter styled with one dark palette so the app has
no extra dependencies. The `Buddy` app object (app.py) owns state and
provides the callbacks used here.
"""
from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

from . import VERSION
from .providers import PROVIDERS

# Palette -------------------------------------------------------------------
BG = "#0d0f15"
BG2 = "#141720"
BG3 = "#1c2030"
LINE = "#242838"
FG = "#eef0fa"
MUTED = "#9aa0b8"
DIM = "#5f6680"
ACCENT = "#7dd3fc"
DANGER = "#ff7882"
OK = "#5eead4"
FONT = ("Segoe UI", 10)
FONT_SMALL = ("Segoe UI", 9)
FONT_BOLD = ("Segoe UI Semibold", 10)
FONT_TITLE = ("Segoe UI Semibold", 13)
FONT_MONO = ("Consolas", 9)


class Button(tk.Label):
    """Flat pill button with hover state (tk.Button cannot be styled this far)."""

    def __init__(self, parent, text, command, primary=False, danger=False, padx=14, pady=5, **kw):
        self.primary, self.danger = primary, danger
        self.command = command
        self.enabled = True
        bg = ACCENT if primary else (DANGER if danger else BG3)
        fg = BG if primary else (FG if not danger else BG)
        super().__init__(parent, text=text, bg=bg, fg=fg, font=FONT_BOLD if primary else FONT,
                         padx=padx, pady=pady, cursor="hand2", **kw)
        self.base_bg = bg
        self.bind("<Enter>", lambda e: self.enabled and self.configure(bg=self._hover()))
        self.bind("<Leave>", lambda e: self.configure(bg=self.base_bg if self.enabled else BG2))
        self.bind("<Button-1>", lambda e: self.enabled and self.command())

    def _hover(self):
        return "#a5e3ff" if self.primary else ("#ff98a0" if self.danger else "#262b3d")

    def set_enabled(self, enabled: bool):
        self.enabled = enabled
        self.configure(bg=self.base_bg if enabled else BG2, fg=(BG if self.primary else FG) if enabled else DIM,
                       cursor="hand2" if enabled else "arrow")


class Segmented(tk.Frame):
    """Row of mutually exclusive options."""

    def __init__(self, parent, options: list[tuple[str, str]], value: str, command):
        super().__init__(parent, bg=BG2)
        self.command = command
        self.value = value
        self.items: dict[str, tk.Label] = {}
        for key, label in options:
            item = tk.Label(self, text=label, bg=BG2, fg=MUTED, font=FONT, padx=12, pady=4, cursor="hand2")
            item.pack(side="left", padx=1)
            item.bind("<Button-1>", lambda e, k=key: self.select(k, True))
            self.items[key] = item
        self._paint()

    def _paint(self):
        for key, item in self.items.items():
            active = key == self.value
            item.configure(bg=BG3 if active else BG2, fg=FG if active else MUTED)

    def select(self, key: str, fire=False):
        self.value = key
        self._paint()
        if fire:
            self.command(key)


class Dropdown(tk.Menubutton):
    def __init__(self, parent, values: list[str], value: str, command, width=18):
        super().__init__(parent, text=value or "—", bg=BG3, fg=FG, font=FONT, relief="flat", padx=10, pady=4,
                         activebackground="#262b3d", activeforeground=FG, cursor="hand2", width=width, anchor="w",
                         indicatoron=False)
        self.command = command
        self.menu = tk.Menu(self, tearoff=0, bg=BG2, fg=FG, activebackground=BG3, activeforeground=FG,
                            relief="flat", bd=0, font=FONT)
        self.configure(menu=self.menu)
        self.set_values(values, value)

    def set_values(self, values: list[str], value: str):
        self.menu.delete(0, "end")
        for v in values:
            self.menu.add_command(label=v, command=lambda v=v: self._pick(v))
        if not values:
            self.menu.add_command(label="No models found", state="disabled")
        self.configure(text=value or (values[0] if values else "No models"))

    def _pick(self, value):
        self.configure(text=value)
        self.command(value)


def _window(parent, title, size, min_size=None):
    win = tk.Toplevel(parent)
    win.title(title)
    win.configure(bg=BG)
    win.geometry(size)
    if min_size:
        win.minsize(*min_size)
    return win


def _label(parent, text, fg=FG, font=FONT, **kw):
    return tk.Label(parent, text=text, bg=kw.pop("bg", BG), fg=fg, font=font, anchor="w", **kw)


def _entry(parent, var, width=30):
    return tk.Entry(parent, textvariable=var, bg=BG3, fg=FG, insertbackground=FG, relief="flat",
                    font=FONT, width=width, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)


# ---------------------------------------------------------------- chat panel
class ChatPanel:
    def __init__(self, app):
        self.app = app
        self.win = _window(app.root, f"{app.assistant_name} · Chat", "520x680", (420, 480))
        self.win.protocol("WM_DELETE_WINDOW", self.win.withdraw)
        self.win.withdraw()
        self.win.bind("<Escape>", lambda e: self.win.withdraw())
        self._build()
        self.render_history()

    # layout -------------------------------------------------------
    def _build(self):
        root = self.win
        header = tk.Frame(root, bg=BG)
        header.pack(fill="x", padx=18, pady=(16, 8))
        self.title = _label(header, self.app.assistant_name, font=FONT_TITLE)
        self.title.pack(side="left")
        self.status = _label(header, "", fg=MUTED, font=FONT_SMALL)
        self.status.pack(side="left", padx=12, pady=(3, 0))
        Button(header, "⋯", self.app.show_menu_at_pointer, padx=8, pady=2).pack(side="right")

        bar = tk.Frame(root, bg=BG)
        bar.pack(fill="x", padx=18, pady=(0, 8))
        options = [(name, cls.label) for name, cls in PROVIDERS.items()]
        self.provider = Segmented(bar, options, self.app.state.settings["provider"], self.app.set_provider)
        self.provider.pack(side="left")
        self.model = Dropdown(bar, [], self.app.state.settings.get("ollama_model", ""), self.app.set_model, width=16)
        self.model.pack(side="left", padx=(10, 0))
        self.model_refresh = Button(bar, "↻", self.app.refresh_models, padx=8, pady=3)
        self.model_refresh.pack(side="left", padx=(4, 0))

        body = tk.Frame(root, bg=BG2, highlightthickness=1, highlightbackground=LINE)
        body.pack(fill="both", expand=True, padx=18)
        self.text = tk.Text(body, bg=BG2, fg=FG, wrap="word", relief="flat", font=FONT, padx=14, pady=12,
                            state="disabled", height=6, cursor="arrow", spacing1=2, spacing3=6, insertbackground=FG,
                            selectbackground=BG3, highlightthickness=0)
        scroll = tk.Scrollbar(body, command=self.text.yview, bg=BG2, troughcolor=BG2, relief="flat", bd=0, width=8)
        self.text.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.text.pack(fill="both", expand=True)
        t = self.text
        t.tag_configure("who_me", foreground=ACCENT, font=FONT_BOLD, spacing1=10)
        t.tag_configure("who_ai", foreground=FG, font=FONT_BOLD, spacing1=10)
        t.tag_configure("who_sys", foreground=MUTED, font=FONT_BOLD, spacing1=10)
        t.tag_configure("body", foreground=FG, lmargin1=0, lmargin2=0)
        t.tag_configure("sys", foreground=MUTED)
        t.tag_configure("error", foreground=DANGER)
        t.tag_configure("step", foreground=DIM, font=FONT_MONO, lmargin1=10, lmargin2=10)
        t.tag_configure("code", font=FONT_MONO, background=BG3)
        t.tag_configure("meta", foreground=DIM, font=FONT_SMALL)

        files = tk.Frame(root, bg=BG)
        files.pack(fill="x", padx=18, pady=(8, 0))
        self.files_frame = files
        self.files_list = tk.Listbox(files, bg=BG2, fg=MUTED, relief="flat", font=FONT_SMALL, height=3,
                                     selectbackground=BG3, selectforeground=FG, highlightthickness=0,
                                     activestyle="none")
        self.files_list.pack(side="left", fill="x", expand=True)
        tools = tk.Frame(files, bg=BG)
        tools.pack(side="right", padx=(8, 0))
        Button(tools, "Open", self._open_selected, padx=10, pady=2).pack(fill="x", pady=1)
        Button(tools, "Remove", self._remove_selected, padx=10, pady=2).pack(fill="x", pady=1)
        self.files_list.bind("<Double-Button-1>", lambda e: self._open_selected())

        composer = tk.Frame(root, bg=BG)
        composer.pack(fill="x", padx=18, pady=(10, 16))
        self.composer = composer
        box = tk.Frame(composer, bg=BG3, highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT)
        box.pack(fill="x")
        self.input = tk.Text(box, bg=BG3, fg=FG, insertbackground=FG, relief="flat", font=FONT, height=3,
                             wrap="word", padx=12, pady=10, highlightthickness=0, undo=True)
        self.input.pack(fill="x")
        self.input.bind("<Return>", self._on_return)
        self.input.bind("<Shift-Return>", lambda e: None)
        self.input.bind("<Control-Return>", self._on_return)
        self.input.bind("<FocusIn>", self._clear_placeholder)
        self.input.bind("<FocusOut>", self._set_placeholder)
        self.placeholder = True
        self._set_placeholder()
        actions = tk.Frame(composer, bg=BG)
        actions.pack(fill="x", pady=(8, 0))
        self.stop = Button(actions, "Stop", self.app.stop_chat, danger=True)
        self.send = Button(actions, "Send", self.send_message, primary=True)
        self.send.pack(side="right")
        Button(actions, "Attach", self.app.pick_files).pack(side="left")
        _label(actions, "Enter sends · Shift+Enter newline · /help", fg=DIM, font=FONT_SMALL).pack(side="left", padx=10)
        self.refresh_files()

    # behaviour ----------------------------------------------------
    def show(self):
        self.win.deiconify()
        self.win.lift()
        self.input.focus_set()

    def _set_placeholder(self, *_):
        if not self.input.get("1.0", "end").strip():
            self.placeholder = True
            self.input.delete("1.0", "end")
            self.input.insert("1.0", f"Message {self.app.assistant_name}…")
            self.input.configure(fg=DIM)

    def _clear_placeholder(self, *_):
        if self.placeholder:
            self.placeholder = False
            self.input.delete("1.0", "end")
            self.input.configure(fg=FG)

    def _on_return(self, event):
        if event.state & 0x0001 and event.keysym == "Return" and not (event.state & 0x0004):  # Shift held
            return None
        self.send_message()
        return "break"

    def send_message(self):
        if self.placeholder:
            return
        text = self.input.get("1.0", "end").strip()
        if not text:
            return
        self.input.delete("1.0", "end")
        self.app.submit(text)

    def set_busy(self, busy: bool):
        if busy:
            self.send.pack_forget()
            self.stop.pack(side="right")
        else:
            self.stop.pack_forget()
            self.send.pack(side="right")

    def set_status(self, text: str, color: str = MUTED):
        self.status.configure(text=text, fg=color)

    def set_models(self, models: list[str], current: str):
        self.model.set_values(models, current)

    def show_model_picker(self, visible: bool):
        if visible:
            self.model.pack(side="left", padx=(10, 0))
            self.model_refresh.pack(side="left", padx=(4, 0))
        else:
            self.model.pack_forget()
            self.model_refresh.pack_forget()

    # transcript ---------------------------------------------------
    def _append(self, who: str, text: str, who_tag: str, body_tag: str = "body"):
        t = self.text
        t.configure(state="normal")
        if t.index("end-1c") != "1.0":
            t.insert("end", "\n")
        if who:
            t.insert("end", who + "\n", who_tag)
        t.insert("end", text, body_tag)
        t.configure(state="disabled")
        t.see("end")

    def add_user(self, text: str):
        self._append("You", text, "who_me")

    def begin_reply(self, label: str):
        self._append(label, "", "who_ai")
        self.text.configure(state="normal")
        self.text.mark_set("reply", "end-1c")
        self.text.mark_gravity("reply", "left")
        self.text.configure(state="disabled")

    def stream(self, chunk: str):
        t = self.text
        t.configure(state="normal")
        t.insert("end", chunk, "body")
        t.configure(state="disabled")
        t.see("end")

    def add_step(self, tool: str, detail: str, status: str):
        icon = {"running": "◌", "done": "✓", "error": "✕"}.get(status, "•")
        self._append("", f"{icon} {tool} {detail}".rstrip(), "", "step")

    def add_system(self, text: str, error: bool = False):
        self._append(self.app.assistant_name, text, "who_sys", "error" if error else "sys")

    def end_reply(self):
        self.text.see("end")

    def clear(self):
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.configure(state="disabled")

    def render_history(self):
        self.clear()
        for message in self.app.state.chat[-40:]:
            if message["role"] == "user":
                self.add_user(message["text"])
            elif message["role"] == "assistant":
                self._append(message.get("provider", "").title() or self.app.assistant_name, message["text"], "who_ai")
        if self.app.state.chat:
            self._append("", "— earlier messages —", "", "meta")

    def refresh_files(self):
        self.files_list.delete(0, "end")
        for path in self.app.state.files:
            p = Path(path)
            self.files_list.insert("end", f"{p.name}   ·   {p.parent}")
        if self.app.state.files:
            self.files_frame.pack(fill="x", padx=18, pady=(8, 0), before=self.composer)
        else:
            self.files_frame.pack_forget()

    def _selected(self) -> str | None:
        sel = self.files_list.curselection()
        if not sel:
            return None
        return self.app.state.files[sel[0]]

    def _open_selected(self):
        path = self._selected()
        if path:
            self.app.open_path(path)

    def _remove_selected(self):
        path = self._selected()
        if path:
            self.app.state.remove_file(path)


# ------------------------------------------------------------------- tasks
class TasksWindow:
    def __init__(self, app):
        self.app = app
        self.win = _window(app.root, "Tasks", "420x460", (320, 300))
        self.win.protocol("WM_DELETE_WINDOW", self.win.withdraw)
        self.win.bind("<Escape>", lambda e: self.win.withdraw())
        _label(self.win, "Tasks", font=FONT_TITLE).pack(anchor="w", padx=18, pady=(16, 6))
        row = tk.Frame(self.win, bg=BG)
        row.pack(fill="x", padx=18)
        self.var = tk.StringVar()
        entry = _entry(row, self.var, 30)
        entry.pack(side="left", fill="x", expand=True, ipady=5)
        entry.bind("<Return>", lambda e: self._add())
        Button(row, "Add", self._add, primary=True).pack(side="left", padx=(8, 0))
        self.list = tk.Frame(self.win, bg=BG)
        self.list.pack(fill="both", expand=True, padx=18, pady=10)
        foot = tk.Frame(self.win, bg=BG)
        foot.pack(fill="x", padx=18, pady=(0, 14))
        Button(foot, "Clear done", self.app.state.clear_done_tasks).pack(side="right")
        self.refresh()
        entry.focus_set()

    def _add(self):
        text = self.var.get().strip()
        if text:
            self.app.state.add_task(text)
            self.var.set("")

    def refresh(self):
        for child in self.list.winfo_children():
            child.destroy()
        if not self.app.state.tasks:
            _label(self.list, "No tasks yet. Add one above, type /task in chat, or let your AI add them.",
                   fg=DIM, font=FONT_SMALL, wraplength=360, justify="left").pack(anchor="w")
        for task in self.app.state.tasks:
            var = tk.BooleanVar(value=task["done"])
            check = tk.Checkbutton(self.list, text=task["text"], variable=var, bg=BG, fg=DIM if task["done"] else FG,
                                   selectcolor=BG3, activebackground=BG, activeforeground=FG, font=FONT,
                                   anchor="w", justify="left", wraplength=340, cursor="hand2",
                                   command=lambda t=task, v=var: self.app.state.set_task_done(t["id"], v.get()))
            check.pack(anchor="w", fill="x")

    def show(self):
        self.refresh()
        self.win.deiconify()
        self.win.lift()


# ----------------------------------------------------------------- settings
class SettingsWindow:
    def __init__(self, app):
        self.app = app
        s = app.state.settings
        self.win = _window(app.root, "Settings", "460x560", (420, 520))
        self.win.protocol("WM_DELETE_WINDOW", self.win.withdraw)
        self.win.bind("<Escape>", lambda e: self.win.withdraw())
        pad = {"padx": 20}
        _label(self.win, "Settings", font=FONT_TITLE).pack(anchor="w", pady=(16, 10), **pad)

        self.assistant = tk.StringVar(value=s["assistant_name"])
        self.boss = tk.StringVar(value=s["boss_name"])
        self.mode = tk.StringVar(value=s["display_mode"])
        self.ollama_url = tk.StringVar(value=s["ollama_url"])
        self.workdir = tk.StringVar(value=s["workdir"])
        self.autostart = tk.BooleanVar(value=False)

        grid = tk.Frame(self.win, bg=BG)
        grid.pack(fill="x", **pad)
        for r, (label, var) in enumerate((("Assistant name", self.assistant), ("Your name", self.boss),
                                           ("Ollama URL", self.ollama_url))):
            _label(grid, label, fg=MUTED).grid(row=r, column=0, sticky="w", pady=4)
            _entry(grid, var, 28).grid(row=r, column=1, sticky="ew", pady=4, ipady=4)
        grid.columnconfigure(1, weight=1)
        _label(grid, "Working folder", fg=MUTED).grid(row=3, column=0, sticky="w", pady=4)
        wd = tk.Frame(grid, bg=BG)
        wd.grid(row=3, column=1, sticky="ew")
        _entry(wd, self.workdir, 20).pack(side="left", fill="x", expand=True, ipady=4)
        Button(wd, "Browse", self._browse, padx=10, pady=3).pack(side="left", padx=(6, 0))
        _label(self.win, "Codex and Claude run read-only in this folder (empty = your home folder).",
               fg=DIM, font=FONT_SMALL, wraplength=410, justify="left").pack(anchor="w", pady=(2, 10), **pad)

        _label(self.win, "Where Buddy lives", fg=MUTED).pack(anchor="w", **pad)
        modes = tk.Frame(self.win, bg=BG)
        modes.pack(anchor="w", pady=(2, 10), **pad)
        for value, label in (("notch", "Top of screen (notch)"), ("pet", "Floating pet")):
            tk.Radiobutton(modes, text=label, value=value, variable=self.mode, bg=BG, fg=FG, selectcolor=BG3,
                           activebackground=BG, activeforeground=FG, font=FONT, cursor="hand2").pack(side="left", padx=(0, 14))

        self.autostart_check = tk.Checkbutton(self.win, text="Start Buddy when I sign in to Windows",
                                              variable=self.autostart, bg=BG, fg=FG, selectcolor=BG3,
                                              activebackground=BG, activeforeground=FG, font=FONT, cursor="hand2")
        self.autostart_check.pack(anchor="w", **pad)
        try:
            from . import startup
            self.autostart.set(startup.enabled())
        except Exception:
            self.autostart_check.configure(state="disabled")

        _label(self.win, "Chat memory", fg=MUTED).pack(anchor="w", pady=(14, 2), **pad)
        row = tk.Frame(self.win, bg=BG)
        row.pack(anchor="w", **pad)
        Button(row, "Clear conversation", self.app.clear_chat).pack(side="left")
        _label(row, "Forgets history and CLI sessions.", fg=DIM, font=FONT_SMALL).pack(side="left", padx=10)

        foot = tk.Frame(self.win, bg=BG)
        foot.pack(fill="x", side="bottom", pady=16, **pad)
        Button(foot, "Save", self._save, primary=True).pack(side="right")
        Button(foot, "Connect AI apps…", self.app.show_connect).pack(side="left")
        _label(foot, f"v{VERSION}", fg=DIM, font=FONT_SMALL).pack(side="left", padx=10)

    def _browse(self):
        folder = filedialog.askdirectory(parent=self.win, title="Working folder for Codex / Claude")
        if folder:
            self.workdir.set(folder)

    def _save(self):
        assistant, boss = self.assistant.get().strip(), self.boss.get().strip()
        if not (1 <= len(assistant) <= 24 and 1 <= len(boss) <= 24):
            messagebox.showerror("Check names", "Both names must be 1–24 characters.", parent=self.win)
            return
        url = self.ollama_url.get().strip().rstrip("/") or "http://127.0.0.1:11434"
        if not url.startswith(("http://", "https://")):
            messagebox.showerror("Ollama URL", "The Ollama URL must start with http:// or https://", parent=self.win)
            return
        workdir = self.workdir.get().strip()
        if workdir and not Path(workdir).is_dir():
            messagebox.showerror("Working folder", "That folder does not exist.", parent=self.win)
            return
        self.app.apply_settings(assistant_name=assistant, boss_name=boss, display_mode=self.mode.get(),
                                ollama_url=url, workdir=workdir, autostart=self.autostart.get())
        self.win.withdraw()

    def show(self):
        self.win.deiconify()
        self.win.lift()


# ------------------------------------------------------------------ connect
class ConnectWindow:
    ROWS = (
        ("claude_desktop", "Claude Desktop", "Adds Buddy tools to Claude's desktop app."),
        ("claude_code", "Claude Code", "Adds Buddy as a user-scope MCP server for the `claude` CLI."),
        ("codex", "Codex", "Adds Buddy to ~/.codex/config.toml for the Codex app and CLI."),
    )
    STATUS = {
        "configured": ("Connected", OK), "not_configured": ("Not connected", MUTED),
        "other": ("Name 'buddy' taken", DANGER), "other_install": ("Another Buddy copy", DANGER),
        "missing": ("App not found", DIM),
    }

    def __init__(self, app):
        self.app = app
        self.win = _window(app.root, "Connect AI apps", "500x400", (460, 360))
        self.win.protocol("WM_DELETE_WINDOW", self.win.withdraw)
        self.win.bind("<Escape>", lambda e: self.win.withdraw())
        _label(self.win, "Connect your AI apps to Buddy", font=FONT_TITLE).pack(anchor="w", padx=20, pady=(16, 2))
        _label(self.win, "One click adds a local `buddy` MCP server. Existing settings are kept and backed up. "
               "No API keys, no accounts — the AI reports its progress to Buddy, reads your attached files, "
               "and can add tasks and reminders.", fg=MUTED, font=FONT_SMALL, wraplength=460,
               justify="left").pack(anchor="w", padx=20, pady=(0, 12))
        self.labels: dict[str, tk.Label] = {}
        for key, title, blurb in self.ROWS:
            row = tk.Frame(self.win, bg=BG2, highlightthickness=1, highlightbackground=LINE)
            row.pack(fill="x", padx=20, pady=4)
            left = tk.Frame(row, bg=BG2)
            left.pack(side="left", fill="x", expand=True, padx=12, pady=8)
            _label(left, title, font=FONT_BOLD, bg=BG2).pack(anchor="w")
            _label(left, blurb, fg=MUTED, font=FONT_SMALL, bg=BG2).pack(anchor="w")
            self.labels[key] = _label(left, "", fg=MUTED, font=FONT_SMALL, bg=BG2)
            self.labels[key].pack(anchor="w")
            right = tk.Frame(row, bg=BG2)
            right.pack(side="right", padx=12)
            Button(right, "Connect", lambda k=key: self._connect(k), primary=True).pack()
            if key == "claude_desktop":
                Button(right, "Browse…", self._browse_claude, padx=8, pady=2).pack(pady=(4, 0))
        _label(self.win, "After connecting: restart the app (or start a new chat/session) so it loads the Buddy tools.",
               fg=DIM, font=FONT_SMALL, wraplength=460, justify="left").pack(anchor="w", padx=20, pady=(10, 0))
        self.refresh()

    def refresh(self):
        from . import connect
        try:
            status = connect.status()
        except Exception as exc:  # never block the window on a config read error
            status = {k: "missing" for k, _, _ in self.ROWS}
            self.labels["codex"].configure(text=str(exc))
        for key, _, _ in self.ROWS:
            text, color = self.STATUS.get(status.get(key, "missing"), ("Unknown", MUTED))
            self.labels[key].configure(text="● " + text, fg=color)

    def _connect(self, key: str):
        from . import connect
        actions = {"claude_desktop": connect.connect_claude_desktop, "claude_code": connect.connect_claude_code,
                   "codex": connect.connect_codex}
        try:
            message = actions[key]()
            messagebox.showinfo("Buddy connection", message, parent=self.win)
        except Exception as exc:
            messagebox.showerror("Connection needs attention", str(exc), parent=self.win)
        self.refresh()

    def _browse_claude(self):
        from . import connect
        folder = filedialog.askdirectory(parent=self.win, title="Claude: Settings → Developer → Edit Config folder")
        if folder:
            try:
                messagebox.showinfo("Buddy connection", connect.connect_claude_desktop(folder), parent=self.win)
            except Exception as exc:
                messagebox.showerror("Connection needs attention", str(exc), parent=self.win)
            self.refresh()

    def show(self):
        self.refresh()
        self.win.deiconify()
        self.win.lift()
