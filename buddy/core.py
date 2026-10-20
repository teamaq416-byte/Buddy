"""GUI-agnostic brain of Buddy.

`Core` owns state, the tool server, the active provider and the chat
orchestration. Any front-end (the Tk island, the web panel, the fallback Tk
panel) subscribes to its events and calls its methods; everything is safe to
call from any thread. Events are delivered on the thread that produced them,
so front-ends must hop to their own UI thread.

Events (kind, payload):
    chat.user       {text}
    chat.begin      {provider, label}
    chat.text       {chunk}
    chat.step       {tool, detail, status}
    chat.done       {text, provider}
    chat.error      {message, stopped}
    chat.system     {text, error}          Buddy's own voice (commands, info)
    chat.cleared    {}
    provider        {name, label, accent, detail, ok, models, model, checking}
    files           {files, added, removed}
    tasks           {tasks}
    agent           {agent, state, message}  (from the MCP bridge)
    step            {agent, step}
    say             {agent, text}
    reminder        {message}
    settings        {settings}
    hotkey          {}
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from . import providers
from .runtime import IS_WINDOWS
from .server import ToolServer
from .state import State

HELP = (
    "Commands\n"
    "/task Buy milk — add a task\n"
    "/remind 10m Stretch — reminder (s, m, h, d)\n"
    "/files — list attached files\n"
    "/model llama3.2 — pick an Ollama model\n"
    "/ollama · /codex · /claude — switch provider\n"
    "/clear — forget the conversation\n"
    "Drop files on Buddy or the chat to attach them."
)
REMIND_RE = re.compile(r"(\d+)\s*([smhd])\s+(.+)", re.I)
UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
RISKY = (".exe", ".bat", ".cmd", ".ps1", ".msi", ".vbs", ".js", ".scr")


class Core:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.state = State(self.folder)
        self.state.listeners.append(self._on_state_event)
        self.server = ToolServer(self.state, self.folder)
        self.server.start()
        self._subs: list[Callable[[str, dict], None]] = []
        self._lock = threading.RLock()
        self.provider: providers.Provider = providers.make(
            self.state.settings["provider"], base_url=self.state.settings["ollama_url"])
        self.chat_busy = False
        self.models: list[str] = []
        self.provider_ok: bool | None = None
        self.provider_detail = ""
        self.closing = False
        self._reply = ""
        self._ticker = threading.Thread(target=self._tick_loop, daemon=True, name="buddy-ticker")

    # ---------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._ticker.start()
        self.check_provider()
        self.refresh_models()
        threading.Timer(1.5, self.auto_connect).start()

    def auto_connect(self) -> None:
        """Wire every installed AI app to this Buddy on start (idempotent, silent on no-ops)."""
        from . import connect
        status = self.connect_status()
        done, failed = [], []
        want = lambda k: status.get(k) in ("not_configured", "other_install")  # noqa: E731
        try:
            if want("claude_desktop"):
                connect.connect_claude_desktop()
                done.append("Claude Desktop")
        except Exception as exc:
            failed.append(f"Claude Desktop: {exc}")
        try:
            if want("claude_code"):
                connect.connect_claude_code()
                done.append("Claude Code")
            elif status.get("claude_code") == "configured":
                connect.plant_claude_code()
        except Exception as exc:
            failed.append(f"Claude Code: {exc}")
        try:
            if want("codex"):
                connect.connect_codex()
                done.append("Codex")
            elif status.get("codex") == "configured":
                connect.plant_codex()
        except Exception as exc:
            failed.append(f"Codex: {exc}")
        if done:
            self.system(f"Connected automatically: {', '.join(done)}. Restart that app (or start a new chat) once so it loads the Buddy tools.")
        for f in failed:
            self.system(f, error=True)

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        try:
            self.provider.cancel()
        except Exception:
            pass
        self.state.save()
        self.server.close()

    # ------------------------------------------------------------ events
    def subscribe(self, fn: Callable[[str, dict], None]) -> None:
        self._subs.append(fn)

    def emit(self, kind: str, **payload) -> None:
        for fn in list(self._subs):
            try:
                fn(kind, payload)
            except Exception as exc:  # a broken front-end must not break the core
                print(f"subscriber error on {kind}: {exc}", file=sys.stderr)

    def _on_state_event(self, kind: str, data: dict) -> None:
        if kind == "files":
            self.emit("files", files=list(self.state.files), added=data.get("added", []),
                      removed=data.get("removed", []))
        elif kind == "tasks":
            self.emit("tasks", tasks=list(self.state.tasks))
        elif kind in ("agent", "step", "say"):
            self.emit(kind, **data)

    def _tick_loop(self) -> None:
        while not self.closing:
            for reminder in self.state.due_reminders():
                self.emit("reminder", message=reminder["message"])
            time.sleep(1.0)

    # ----------------------------------------------------------- snapshot
    @property
    def settings(self) -> dict:
        return self.state.settings

    @property
    def assistant_name(self) -> str:
        return self.state.settings["assistant_name"]

    @property
    def boss_name(self) -> str:
        return self.state.settings["boss_name"]

    def accent_rgb(self) -> tuple[int, int, int]:
        color = self.provider.accent.lstrip("#")
        return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]

    def provider_info(self, checking: bool = False) -> dict:
        return {
            "name": self.provider.name, "label": self.provider.label, "accent": self.provider.accent,
            "detail": self.provider_detail, "ok": self.provider_ok, "models": list(self.models),
            "model": self.state.settings.get("ollama_model", ""), "checking": checking,
            "all": [{"name": n, "label": c.label, "accent": c.accent} for n, c in providers.PROVIDERS.items()],
        }

    def snapshot(self) -> dict:
        """Everything a front-end needs to draw itself from scratch."""
        from . import VERSION
        return {
            "version": VERSION,
            "settings": dict(self.state.settings),
            "provider": self.provider_info(),
            "chat": list(self.state.chat[-60:]),
            "files": list(self.state.files),
            "tasks": list(self.state.tasks),
            "busy": self.chat_busy,
            "agents": {name: self.state.agent_activity(name) for name in ("claude", "codex", "ollama")},
            "agent_mode": self.agent_mode,
            "linked": {name: self.state.agent_linked(name) for name in ("claude", "codex")},
            "windows": IS_WINDOWS,
        }

    # ----------------------------------------------------------- provider
    def set_provider(self, name: str) -> None:
        if name not in providers.PROVIDERS:
            return
        with self._lock:
            if self.chat_busy:
                self.stop()
            self.state.settings["provider"] = name
            self.state.save()
            self.provider = providers.make(name, base_url=self.state.settings["ollama_url"])
            self.provider_ok, self.provider_detail = None, ""
        self.check_provider()

    def check_provider(self) -> None:
        provider = self.provider
        self.emit("provider", **self.provider_info(checking=True))

        def worker():
            ok, detail = provider.available()
            if provider is not self.provider:
                return
            self.provider_ok = ok
            if provider.name == "ollama":
                self.provider_detail = self.state.settings.get("ollama_model", "") if ok else "offline"
            else:
                self.provider_detail = "ready" if ok else "not installed"
            self.emit("provider", **self.provider_info())
            if not ok:
                self.system(detail, error=True)

        threading.Thread(target=worker, daemon=True, name="buddy-probe").start()

    def refresh_models(self) -> None:
        url = self.state.settings["ollama_url"]

        def worker():
            try:
                models = providers.OllamaProvider(url).models()
            except Exception:
                models = []
            self.models = models
            current = self.state.settings.get("ollama_model", "")
            if models and current not in models:
                self.state.settings["ollama_model"] = current = models[0]
                self.state.save()
            if models and self.provider.name == "ollama":
                self.provider_detail = current
            self.emit("provider", **self.provider_info())

        threading.Thread(target=worker, daemon=True, name="buddy-models").start()

    def set_model(self, model: str) -> None:
        model = str(model).strip()
        if not model:
            return
        self.state.settings["ollama_model"] = model
        self.state.save()
        if self.provider.name == "ollama":
            self.provider_detail = model
        self.emit("provider", **self.provider_info())

    # --------------------------------------------------------------- chat
    def system(self, text: str, error: bool = False) -> None:
        self.emit("chat.system", text=text, error=error)

    def _system_prompt(self, agent: bool = False) -> str:
        parts = [
            f"You are {self.assistant_name}, a friendly and concise desktop assistant for {self.boss_name}. "
            f"You live inside Buddy, a small companion app on their PC. Answer in the user's language, keep replies "
            f"short and practical. Markdown is fine (code blocks, short lists)."
        ]
        if agent:
            parts.append("Do mode: the user asked you to act, not only advise. Make the change in the working folder "
                         "yourself (edit files, run commands), verify it, then report briefly what you did.")
        if self.state.files:
            if self.provider.name == "ollama":
                budget = 24_000
                parts.append("The user attached these files:")
                for path in self.state.files:
                    p = Path(path)
                    try:
                        text = self.state.preview(path)[:8_000]
                    except ValueError:
                        parts.append(f"- {p.name} (binary/unsupported, path: {path})")
                        continue
                    if budget <= 0:
                        parts.append(f"- {p.name} (omitted: context budget reached)")
                        continue
                    budget -= len(text)
                    parts.append(f"- {p.name} ({path}):\n```\n{text}\n```")
            else:
                parts.append("The user attached these files; read them with your file tools when relevant:\n" +
                             "\n".join(f"- {path}" for path in self.state.files))
        return "\n\n".join(parts)

    def set_agent_mode(self, enabled: bool) -> None:
        self.state.settings["agent_mode"] = bool(enabled)
        self.state.save()
        self.emit("settings", settings=dict(self.state.settings))

    @property
    def agent_mode(self) -> bool:
        return bool(self.state.settings.get("agent_mode"))

    def submit(self, text: str, agent: bool | None = None) -> None:
        text = str(text).strip()
        if not text:
            return
        if text.startswith("/"):
            self._command(text)
            return
        agent = self.agent_mode if agent is None else bool(agent)
        with self._lock:
            if self.chat_busy:
                self.system("Still replying — press Stop first.", error=True)
                return
            self.chat_busy = True
            provider = self.provider
            self._reply = ""
        if agent and provider.name == "ollama":
            agent = False  # Ollama chats; it has no tools to act with
        self.state.add_chat("user", text, provider.name)
        self.emit("chat.user", text=text)
        self.emit("chat.begin", provider=provider.name, label=provider.label, agent=agent)
        self.state.set_agent_state(provider.name, "working", ("Doing: " if agent else "") + text[:70], source="chat")
        history = [{"role": m["role"], "content": m["text"]} for m in self.state.chat[:-1]
                   if m["role"] in ("user", "assistant")]
        ctx = providers.ChatContext(
            system=self._system_prompt(agent), history=history,
            session=self.state.settings["sessions"].get(provider.name, ""),
            workdir=self.state.settings["workdir"] or str(Path.home()),
            files=list(self.state.files), model=self.state.settings.get("ollama_model", ""),
            base_url=self.state.settings["ollama_url"], agent=agent,
        )

        def worker():
            provider.run(text, ctx, lambda kind, payload: self._chat_event(provider, kind, payload))

        threading.Thread(target=worker, daemon=True, name="buddy-chat").start()

    def _chat_event(self, provider: providers.Provider, kind: str, data) -> None:
        if provider is not self.provider and kind not in ("done", "error"):
            return
        name = provider.name
        if kind == "text":
            self._reply += data
            self.emit("chat.text", chunk=data)
        elif kind == "step":
            if data.get("tool"):
                self.emit("chat.step", tool=data["tool"], detail=data.get("detail", ""),
                          status=data.get("status", "running"))
                try:
                    self.state.add_agent_step(name, data["tool"], data.get("detail", ""), data.get("status", "running"))
                except ValueError:
                    pass
            else:
                self.emit("chat.step", tool="", detail="", status=data.get("status", "done"))
                for step in self.state.agents[name]["steps"]:
                    if step["status"] == "running":
                        step["status"] = data.get("status", "done")
        elif kind == "session":
            self.state.settings["sessions"][name] = data
            self.state.save()
        elif kind == "done":
            self.chat_busy = False
            self.state.add_chat("assistant", data, name)
            first = data.strip().splitlines()[0] if data.strip() else "Done"
            self.state.set_agent_state(name, "done", first[:70], source="chat")
            self.emit("chat.done", text=data, provider=name)
        elif kind == "error":
            self.chat_busy = False
            stopped = data == "Stopped."
            if not stopped and ("session" in data.lower() or "resume" in data.lower()):
                self.state.settings["sessions"].pop(name, None)
                self.state.save()
            self.state.set_agent_state(name, "idle" if stopped else "error", "" if stopped else data[:70], source="chat")
            self.emit("chat.error", message=data, stopped=stopped)

    def stop(self) -> None:
        if self.chat_busy:
            self.provider.cancel()

    def clear_chat(self) -> None:
        self.state.clear_chat()
        self.emit("chat.cleared")
        self.system("Conversation cleared.")

    def _command(self, text: str) -> None:
        cmd, _, arg = text[1:].partition(" ")
        cmd, arg = cmd.lower(), arg.strip()
        if cmd == "help":
            self.system(HELP)
        elif cmd == "task" and arg:
            self.state.add_task(arg)
            self.system(f"Added task: {arg}")
            self.emit("say", agent="", text="Task added.", reaction="done")
        elif cmd == "remind":
            match = REMIND_RE.fullmatch(arg)
            if not match:
                self.system("Use: /remind 10m Stretch  (s, m, h, d)", error=True)
                return
            seconds = int(match.group(1)) * UNITS[match.group(2).lower()]
            try:
                self.state.add_reminder(seconds, match.group(3))
            except ValueError as exc:
                self.system(str(exc), error=True)
                return
            self.system(f"Reminder set for {match.group(1)}{match.group(2)}: {match.group(3)}")
            self.emit("say", agent="", text="I'll remind you.", reaction="done")
        elif cmd == "files":
            self.system("\n".join(self.state.files) if self.state.files else "No files attached.")
        elif cmd == "clear":
            self.clear_chat()
        elif cmd == "model" and arg:
            self.set_model(arg)
            self.system(f"Ollama model: {arg}")
        elif cmd in providers.PROVIDERS:
            self.set_provider(cmd)
        else:
            self.system("Unknown command. Type /help.", error=True)

    # -------------------------------------------------------------- files
    def attach(self, paths) -> list[str]:
        return self.state.add_files(paths)

    def remove_file(self, path: str) -> None:
        self.state.remove_file(path)

    def open_path(self, path: str, confirmed: bool = False) -> bool:
        """Open with the default app. Returns False when confirmation is needed."""
        if Path(path).suffix.lower() in RISKY and not confirmed:
            return False
        try:
            if IS_WINDOWS:
                os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
        except OSError as exc:
            self.system(f"Could not open: {exc}", error=True)
        return True

    # -------------------------------------------------------------- tasks
    def add_task(self, text: str) -> None:
        self.state.add_task(text)

    def set_task_done(self, task_id: str, done: bool) -> None:
        self.state.set_task_done(task_id, done)

    def clear_done_tasks(self) -> None:
        self.state.clear_done_tasks()

    # ----------------------------------------------------------- settings
    def apply_settings(self, changes: dict) -> list[str]:
        """Validate + apply. Returns a list of human-readable problems (empty = saved)."""
        problems = []
        clean: dict = {}
        if "assistant_name" in changes or "boss_name" in changes:
            for key in ("assistant_name", "boss_name"):
                value = str(changes.get(key, self.state.settings[key])).strip()
                if not 1 <= len(value) <= 24:
                    problems.append("Names must be 1–24 characters.")
                clean[key] = value
        if "ollama_url" in changes:
            url = str(changes["ollama_url"]).strip().rstrip("/") or "http://127.0.0.1:11434"
            if not url.startswith(("http://", "https://")):
                problems.append("Ollama URL must start with http:// or https://")
            clean["ollama_url"] = url
        if "workdir" in changes:
            workdir = str(changes["workdir"]).strip()
            if workdir and not Path(workdir).is_dir():
                problems.append("Working folder does not exist.")
            clean["workdir"] = workdir
        if "display_mode" in changes and changes["display_mode"] in ("notch", "pet"):
            clean["display_mode"] = changes["display_mode"]
        if "reduce_motion" in changes:
            clean["reduce_motion"] = bool(changes["reduce_motion"])
        if problems:
            return problems
        autostart = changes.get("autostart")
        url_changed = clean.get("ollama_url", self.state.settings["ollama_url"]) != self.state.settings["ollama_url"]
        self.state.settings.update(clean)
        self.state.save()
        if autostart is not None and IS_WINDOWS:
            from . import startup
            try:
                if startup.enabled() != bool(autostart):
                    startup.set_enabled(bool(autostart))
            except OSError as exc:
                problems.append(f"Saved, but Windows startup could not be changed: {exc}")
        if url_changed:
            self.set_provider(self.state.settings["provider"])
            self.refresh_models()
        self.emit("settings", settings=dict(self.state.settings))
        self.emit("say", agent="", text=f"Saved. I'm {self.assistant_name}, here for {self.boss_name}.", reaction="done")
        return problems

    def autostart_enabled(self) -> bool:
        if not IS_WINDOWS:
            return False
        from . import startup
        try:
            return startup.enabled()
        except Exception:
            return False

    # ------------------------------------------------------------ connect
    def connect_status(self) -> dict:
        from . import connect
        try:
            return connect.status()
        except Exception:
            return {"claude_desktop": "missing", "claude_code": "missing", "codex": "missing"}

    def connect(self, key: str, explicit_path: str | None = None) -> tuple[bool, str]:
        from . import connect
        actions = {
            "claude_desktop": lambda: connect.connect_claude_desktop(explicit_path),
            "claude_code": connect.connect_claude_code,
            "codex": connect.connect_codex,
        }
        if key == "claude":
            out, errs = [], []
            for label, fn in (("Claude Desktop", actions["claude_desktop"]), ("Claude Code", actions["claude_code"])):
                try:
                    out.append(fn())
                except Exception as exc:
                    errs.append(f"{label}: {exc}")
            return bool(out), "\n\n".join(out + errs)
        if key not in actions:
            return False, "Unknown target."
        try:
            return True, actions[key]()
        except Exception as exc:
            return False, str(exc)
