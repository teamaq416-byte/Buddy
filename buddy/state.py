"""Persistent local state plus the tool surface used by the MCP bridge.

Everything is plain JSON in the data folder. No cloud requests and no
arbitrary shell execution happen here.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

AGENTS = ("claude", "codex", "ollama")
STATES = ("idle", "working", "waiting", "done", "error")
TEXT_TYPES = {
    ".txt", ".md", ".markdown", ".json", ".toml", ".yaml", ".yml", ".ini", ".cfg",
    ".csv", ".tsv", ".log", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css",
    ".cs", ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".rs", ".go", ".rb", ".php",
    ".sh", ".bat", ".cmd", ".ps1", ".xml", ".sql", ".env", ".gitignore", ".svg",
}
MAX_READ_BYTES = 32 * 1024
MAX_STEPS = 12
MAX_CHAT = 60
ACTIVITY_TTL = 90.0  # seconds after which a reported state is considered stale
HEARTBEAT_TTL = 25.0

DEFAULT_SETTINGS: dict[str, Any] = {
    "assistant_name": "Buddy",
    "boss_name": "Boss",
    "display_mode": "notch",      # notch | pet
    "provider": "ollama",         # ollama | codex | claude
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "",
    "workdir": "",                # folder the CLI agents work in ("" = home)
    "autostart": False,
    "sessions": {},               # provider -> resumable session id
    "pet_pos": None,              # [x, y] of the floating pet window
    "agent_mode": False,          # True = "Do": Codex/Claude may edit files and run commands
    "reduce_motion": False,
}


class State:
    def __init__(self, folder: Path | str):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.path = self.folder / "state.json"
        self.lock = threading.RLock()
        self.listeners: list[Callable[[str, dict], None]] = []

        self.files: list[str] = []
        self.tasks: list[dict] = []
        self.reminders: list[dict] = []
        self.chat: list[dict] = []
        self.settings: dict[str, Any] = dict(DEFAULT_SETTINGS)
        # Runtime-only agent activity reported through the bridge.
        self.agents: dict[str, dict] = {name: self._blank_agent() for name in AGENTS}
        self._load()

    # ------------------------------------------------------------------ io
    @staticmethod
    def _blank_agent() -> dict:
        return {"state": "idle", "message": "", "at": 0.0, "heartbeat": 0.0,
                "session": "", "steps": []}

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except (ValueError, OSError):
            return
        if not isinstance(data, dict):
            return
        self.files = [f for f in data.get("files", []) if isinstance(f, str) and Path(f).exists()]
        self.tasks = [t for t in data.get("tasks", []) if isinstance(t, dict) and t.get("text")]
        self.reminders = [r for r in data.get("reminders", []) if isinstance(r, dict) and r.get("at")]
        self.chat = [m for m in data.get("chat", []) if isinstance(m, dict)][-MAX_CHAT:]
        settings = data.get("settings", {})
        if isinstance(settings, dict):
            self.settings.update({k: v for k, v in settings.items() if k in DEFAULT_SETTINGS})
        if not isinstance(self.settings.get("sessions"), dict):
            self.settings["sessions"] = {}

    def save(self) -> None:
        with self.lock:
            payload = {
                "files": self.files,
                "tasks": self.tasks,
                "reminders": self.reminders,
                "chat": self.chat[-MAX_CHAT:],
                "settings": self.settings,
            }
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), "utf-8")
            tmp.replace(self.path)

    # ------------------------------------------------------------ events
    def emit(self, kind: str, **data: Any) -> None:
        for listener in list(self.listeners):
            try:
                listener(kind, data)
            except Exception:  # listeners must never break the tool call
                pass

    # ------------------------------------------------------------- files
    def add_files(self, paths) -> list[str]:
        added = []
        with self.lock:
            for raw in paths:
                p = Path(str(raw)).expanduser()
                try:
                    p = p.resolve()
                except OSError:
                    continue
                if not p.exists():
                    continue
                text = str(p)
                if text not in self.files:
                    self.files.append(text)
                    added.append(text)
            if added:
                self.save()
        if added:
            self.emit("files", added=added)
        return added

    def remove_file(self, path: str) -> None:
        with self.lock:
            if path in self.files:
                self.files.remove(path)
                self.save()
        self.emit("files", removed=[path])

    def preview(self, raw: str) -> str:
        p = Path(str(raw)).expanduser()
        try:
            p = p.resolve()
        except OSError as exc:
            raise ValueError(f"Cannot resolve path: {exc}") from exc
        if str(p) not in self.files:
            raise ValueError("Attach this file in Buddy first; only attached files can be read.")
        if not p.is_file():
            raise ValueError("Attached path is not a file.")
        if p.suffix.lower() not in TEXT_TYPES and p.suffix:
            raise ValueError("Preview supports text and code files. Open other formats in their own app.")
        with open(p, "rb") as handle:
            blob = handle.read(MAX_READ_BYTES + 1)
        text = blob[:MAX_READ_BYTES].decode("utf-8", "replace")
        if len(blob) > MAX_READ_BYTES:
            text += "\n[Preview truncated at 32 KB]"
        return text

    # ------------------------------------------------------------- tasks
    def add_task(self, text: str) -> dict:
        text = str(text).strip()
        if not text:
            raise ValueError("Task text is required.")
        task = {"id": uuid.uuid4().hex[:8], "text": text[:300], "done": False, "created": time.time()}
        with self.lock:
            self.tasks.append(task)
            self.save()
        self.emit("tasks")
        return task

    def set_task_done(self, task_id: str, done: bool = True) -> dict:
        with self.lock:
            for task in self.tasks:
                if task["id"] == task_id:
                    task["done"] = bool(done)
                    self.save()
                    self.emit("tasks")
                    return task
        raise ValueError("Unknown task id.")

    def clear_done_tasks(self) -> None:
        with self.lock:
            self.tasks = [t for t in self.tasks if not t.get("done")]
            self.save()
        self.emit("tasks")

    # --------------------------------------------------------- reminders
    def add_reminder(self, seconds: int, message: str) -> dict:
        seconds = int(seconds)
        message = str(message).strip() or "Reminder"
        if not 1 <= seconds <= 366 * 24 * 3600:
            raise ValueError("Reminder must be between 1 second and 1 year.")
        reminder = {"id": uuid.uuid4().hex[:8], "at": time.time() + seconds, "message": message[:300]}
        with self.lock:
            self.reminders.append(reminder)
            self.save()
        self.emit("reminders")
        return reminder

    def due_reminders(self, now: float | None = None) -> list[dict]:
        """Pop and return reminders whose time has come (each fires once)."""
        now = time.time() if now is None else now
        with self.lock:
            due = [r for r in self.reminders if r["at"] <= now]
            if due:
                self.reminders = [r for r in self.reminders if r["at"] > now]
                self.save()
        return due

    # -------------------------------------------------------------- chat
    def add_chat(self, role: str, text: str, provider: str = "") -> None:
        with self.lock:
            self.chat.append({"role": role, "text": text, "provider": provider, "at": time.time()})
            self.chat = self.chat[-MAX_CHAT:]
            self.save()

    def clear_chat(self) -> None:
        with self.lock:
            self.chat = []
            self.settings["sessions"] = {}
            self.save()

    # ------------------------------------------------------------ agents
    def agent(self, name: str) -> dict:
        name = str(name or "").lower()
        if name not in self.agents:
            raise ValueError("Client must identify as claude, codex or ollama.")
        return self.agents[name]

    def set_agent_state(self, name: str, state: str, message: str = "", session: str = "", source: str = "mcp") -> dict:
        state = str(state or "").lower()
        if state not in STATES:
            raise ValueError(f"Unknown state '{state}'. Use one of: {', '.join(STATES)}.")
        with self.lock:
            agent = self.agent(name)
            agent.update(state=state, message=str(message or "")[:160], at=time.time())
            if session:
                agent["session"] = session
            if state in ("done", "error", "idle"):
                for step in agent["steps"]:
                    if step["status"] == "running":
                        step["status"] = "done" if state == "done" else "error"
            if state == "idle":
                agent["steps"] = []
        self.emit("agent", agent=name, state=state, message=agent["message"], source=source)
        return agent

    def add_agent_step(self, name: str, tool: str, detail: str = "", status: str = "running") -> dict:
        tool = str(tool or "").strip()[:32]
        if not tool:
            raise ValueError("Tool name is required.")
        status = str(status or "running").lower()
        if status not in ("running", "done", "error"):
            raise ValueError("Step status must be running, done or error.")
        step = {"tool": tool, "detail": str(detail or "")[:120], "status": status, "at": time.time()}
        with self.lock:
            agent = self.agent(name)
            # A new running step completes the previous running one.
            for previous in agent["steps"]:
                if previous["status"] == "running":
                    previous["status"] = "done"
            agent["steps"].append(step)
            agent["steps"] = agent["steps"][-MAX_STEPS:]
            if agent["state"] != "working":
                agent.update(state="working", at=time.time())
        self.emit("step", agent=name, step=step)
        return step

    def heartbeat(self, name: str, session: str = "") -> None:
        with self.lock:
            agent = self.agent(name)
            agent["heartbeat"] = time.time()
            if session:
                agent["session"] = session

    def agent_linked(self, name: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        return now - self.agents[name]["heartbeat"] < HEARTBEAT_TTL

    def agent_activity(self, name: str, now: float | None = None) -> dict:
        """Current reported state, or idle when the last report is stale."""
        now = time.time() if now is None else now
        agent = self.agents[name]
        fresh = agent["at"] and (now - agent["at"] < ACTIVITY_TTL or agent["state"] in ("working", "waiting"))
        if not fresh:
            return {"state": "idle", "message": "", "steps": agent["steps"][-MAX_STEPS:]}
        return {"state": agent["state"], "message": agent["message"], "steps": agent["steps"][-MAX_STEPS:]}

    def headline(self, now: float | None = None) -> tuple[str, str, str]:
        """(agent, state, message) of the most relevant live activity."""
        now = time.time() if now is None else now
        # Live activity (working/waiting) beats finished states; ties go to the most recent report.
        priority = {"waiting": 2, "working": 2, "error": 1, "done": 1, "idle": 0}
        best = ("", "idle", "")
        best_rank = (-1, 0.0)
        for name in AGENTS:
            activity = self.agent_activity(name, now)
            rank = (priority[activity["state"]], self.agents[name]["at"])
            if activity["state"] != "idle" and rank > best_rank:
                best_rank = rank
                best = (name, activity["state"], activity["message"])
        return best

    # ------------------------------------------------------- tool calls
    def execute(self, name: str, args: dict | None) -> dict:
        """Execute a bridge tool. Raises ValueError with a user-facing message."""
        args = args or {}
        agent = str(args.get("agent", "")).lower()
        if name == "buddy_heartbeat":
            self.heartbeat(agent, str(args.get("session", "")))
            return {"connected": True}
        if name == "buddy_status":
            self.set_agent_state(agent, args.get("state", ""), args.get("message", ""), str(args.get("session", "")))
            return {"updated": True, "agent": agent, "state": self.agents[agent]["state"]}
        if name == "buddy_step":
            step = self.add_agent_step(agent, args.get("tool", ""), args.get("detail", ""), args.get("status", "running"))
            return {"recorded": True, "step": step}
        if name == "buddy_say":
            text = str(args.get("text", "")).strip()
            if not text:
                raise ValueError("Text is required.")
            self.emit("say", agent=agent, text=text[:200])
            return {"shown": True}
        if name == "buddy_files":
            return {"files": list(self.files)}
        if name == "buddy_read_file":
            return {"path": str(args.get("path", "")), "text": self.preview(args.get("path", ""))}
        if name == "buddy_remind":
            reminder = self.add_reminder(args.get("seconds", 0), args.get("message", ""))
            return {"scheduled": True, "id": reminder["id"], "at": reminder["at"]}
        if name == "buddy_task":
            return {"added": True, "task": self.add_task(args.get("text", ""))}
        if name == "buddy_tasks":
            return {"tasks": list(self.tasks)}
        if name == "buddy_complete_task":
            return {"task": self.set_task_done(str(args.get("id", "")), True)}
        raise ValueError(f"Unknown tool: {name}")
