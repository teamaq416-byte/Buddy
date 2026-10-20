"""Chat providers: Ollama (HTTP), OpenAI Codex CLI and Claude Code CLI.

Every provider exposes the same tiny streaming interface so the UI never
cares which backend is active:

    provider.run(prompt, ctx, emit)   # blocking; call from a worker thread
    provider.cancel()

`emit(kind, payload)` receives:
    ("session", id)          resumable session/thread id (CLI providers)
    ("text", chunk)          streamed assistant text
    ("step", {...})          tool activity: {tool, detail, status}
    ("done", full_text)      finished successfully
    ("error", message)       finished with a user-facing error
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

Emit = Callable[[str, object], None]
IS_WINDOWS = sys.platform == "win32"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CLI_TIMEOUT = 600  # seconds for one CLI turn


@dataclass
class ChatContext:
    system: str = ""
    history: list[dict] = field(default_factory=list)   # [{role, content}] (Ollama only)
    session: str = ""                                    # resumable id (CLI providers)
    workdir: str = ""
    files: list[str] = field(default_factory=list)
    model: str = ""
    base_url: str = "http://127.0.0.1:11434"
    agent: bool = False                                  # True = may edit files / run commands in workdir


class Provider:
    name = "base"
    label = "Base"
    accent = "#8b9cff"

    def __init__(self):
        self._cancel = threading.Event()
        self._process: subprocess.Popen | None = None

    # -- discovery ---------------------------------------------------
    def available(self) -> tuple[bool, str]:
        """(ok, human detail) without side effects beyond a quick probe."""
        raise NotImplementedError

    # -- execution ---------------------------------------------------
    def run(self, prompt: str, ctx: ChatContext, emit: Emit) -> None:
        raise NotImplementedError

    def cancel(self) -> None:
        self._cancel.set()
        proc = self._process
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    # -- helpers -----------------------------------------------------
    def _spawn(self, args: list[str], prompt: str, cwd: str | None) -> tuple[subprocess.Popen, object]:
        self._cancel.clear()
        stderr = tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace")
        env = dict(os.environ)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            cwd=cwd or None,
            env=env,
            creationflags=NO_WINDOW,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._process = proc
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except (OSError, ValueError):
            pass
        return proc, stderr

    def _finish(self, proc: subprocess.Popen, stderr, emit: Emit, text: str, had_error: bool) -> None:
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        self._process = None
        if self._cancel.is_set():
            emit("error", "Stopped.")
            return
        if had_error:
            return
        stderr.seek(0)
        err_text = stderr.read().strip()
        stderr.close()
        if proc.returncode not in (0, None) and not text:
            tail = err_text[-600:] if err_text else f"exit code {proc.returncode}"
            emit("error", f"{self.label} failed: {tail}")
            return
        if not text:
            emit("error", f"{self.label} returned no reply. Check its login and limits.")
            return
        emit("done", text)

    def _iter_json_lines(self, proc: subprocess.Popen):
        for line in proc.stdout:
            if self._cancel.is_set():
                break
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


# ---------------------------------------------------------------- Ollama
class OllamaProvider(Provider):
    name = "ollama"
    label = "Ollama"
    accent = "#7dd3fc"

    def __init__(self, base_url: str = "http://127.0.0.1:11434"):
        super().__init__()
        self.base_url = base_url.rstrip("/")
        self._response = None

    def models(self, base_url: str | None = None, timeout: float = 2.5) -> list[str]:
        url = (base_url or self.base_url).rstrip("/") + "/api/tags"
        with urllib.request.urlopen(url, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        names = [m.get("name", "") for m in data.get("models", []) if isinstance(m, dict)]
        return [n for n in names if n]

    def available(self) -> tuple[bool, str]:
        try:
            models = self.models()
        except urllib.error.URLError:
            return False, "Ollama is not running. Start the Ollama app or run `ollama serve`."
        except (OSError, ValueError) as exc:
            return False, f"Ollama is unreachable: {exc}"
        if not models:
            return False, "Ollama is running but has no models. Run `ollama pull llama3.2` first."
        return True, f"{len(models)} model(s) ready"

    def cancel(self) -> None:
        super().cancel()
        response = self._response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass

    def run(self, prompt: str, ctx: ChatContext, emit: Emit) -> None:
        self._cancel.clear()
        base = (ctx.base_url or self.base_url).rstrip("/")
        model = ctx.model
        if not model:
            try:
                model = (self.models(base) or [""])[0]
            except Exception:
                model = ""
        if not model:
            emit("error", "No Ollama model selected. Pull a model (`ollama pull llama3.2`) and pick it in Settings.")
            return
        messages = []
        if ctx.system:
            messages.append({"role": "system", "content": ctx.system})
        messages.extend(ctx.history[-40:])
        messages.append({"role": "user", "content": prompt})
        body = json.dumps({"model": model, "messages": messages, "stream": True}).encode("utf-8")
        request = urllib.request.Request(
            base + "/api/chat", data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        text = ""
        try:
            self._response = urllib.request.urlopen(request, timeout=120)
            while not self._cancel.is_set():
                line = self._response.readline()
                if not line:
                    break
                try:
                    event = json.loads(line.decode("utf-8"))
                except ValueError:
                    continue
                if event.get("error"):
                    emit("error", f"Ollama: {event['error']}")
                    return
                chunk = (event.get("message") or {}).get("content", "")
                if chunk:
                    text += chunk
                    emit("text", chunk)
                if event.get("done"):
                    break
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code == 404:
                emit("error", f"Model '{model}' is not installed. Run `ollama pull {model}`.")
            else:
                emit("error", f"Ollama error {exc.code}: {detail or exc.reason}")
            return
        except urllib.error.URLError as exc:
            if self._cancel.is_set():
                emit("error", "Stopped.")
            else:
                emit("error", f"Ollama is not reachable at {base}. Is it running? ({exc.reason})")
            return
        except (OSError, ValueError) as exc:
            if self._cancel.is_set():
                emit("error", "Stopped.")
            else:
                emit("error", f"Ollama connection failed: {exc}")
            return
        finally:
            response, self._response = self._response, None
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
        if self._cancel.is_set():
            emit("error", "Stopped.")
        elif text:
            emit("done", text)
        else:
            emit("error", "Ollama returned an empty reply.")


# ----------------------------------------------------------------- Codex
def _which(names: list[str], extra: list[Path]) -> str:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    for path in extra:
        try:
            if path.is_file():
                return str(path)
        except OSError:
            continue
    return ""


def _clean_command(cmd) -> str:
    """Codex reports the full shell invocation; show the meaningful part only."""
    if isinstance(cmd, str) and cmd.lstrip().startswith("["):
        try:
            cmd = json.loads(cmd)
        except ValueError:
            pass
    if isinstance(cmd, list):
        parts = [str(a) for a in cmd]
        for k in range(1, len(parts)):
            if parts[k - 1].lower() in ("-command", "-c", "-lc", "/c"):
                parts = parts[k:]
                break
        cmd = " ".join(parts)
    return " ".join(str(cmd or "").strip('"').replace("\\\\", "\\").split())


class CodexProvider(Provider):
    name = "codex"
    label = "Codex"
    accent = "#5eead4"

    STEP_NAMES = {
        "command_execution": "Bash",
        "file_change": "Edit",
        "mcp_tool_call": "Tool",
        "web_search": "Search",
        "plan_update": "Plan",
        "todo_list": "Plan",
    }

    @staticmethod
    def executable() -> str:
        home = Path.home()
        extra = [home / "AppData" / "Roaming" / "npm" / "codex.cmd"]
        try:
            bundled = sorted((home / "AppData" / "Local" / "OpenAI" / "Codex" / "bin").glob("*/codex.exe"),
                             key=lambda p: p.stat().st_mtime)
            extra.extend(reversed(bundled))
        except OSError:
            pass
        return _which(["codex"], extra)

    def available(self) -> tuple[bool, str]:
        exe = self.executable()
        if not exe:
            return False, "Codex CLI not found. Install it (`npm i -g @openai/codex`) or open the Codex app and sign in."
        return True, Path(exe).name

    def run(self, prompt: str, ctx: ChatContext, emit: Emit) -> None:
        exe = self.executable()
        if not exe:
            emit("error", "Codex CLI not found. Install it with `npm i -g @openai/codex` and run `codex login`.")
            return
        args = [exe, "exec", "--json", "--skip-git-repo-check"]
        args += ["--full-auto"] if ctx.agent else ["-s", "read-only"]
        if ctx.workdir:
            args += ["-C", ctx.workdir]
        if ctx.session:
            args += ["resume", ctx.session]
        args.append("-")
        full_prompt = (ctx.system + "\n\n" + prompt) if (ctx.system and not ctx.session) else prompt
        try:
            proc, stderr = self._spawn(args, full_prompt, ctx.workdir)
        except OSError as exc:
            emit("error", f"Could not start Codex: {exc}")
            return
        text, had_error = "", False
        for event in self._iter_json_lines(proc):
            kind = event.get("type", "")
            if kind == "thread.started" and event.get("thread_id"):
                emit("session", event["thread_id"])
            elif kind in ("item.started", "item.updated", "item.completed"):
                item = event.get("item") or {}
                itype = item.get("type") or item.get("item_type", "")
                if itype in ("agent_message", "assistant_message"):
                    if kind == "item.completed" and item.get("text"):
                        separator = "\n\n" if text else ""
                        text += separator + item["text"]
                        emit("text", separator + item["text"])
                elif itype in self.STEP_NAMES:
                    detail = _clean_command(item.get("command")) or ", ".join(
                        str(c.get("path", "")) for c in item.get("changes", []) if isinstance(c, dict)
                    ) or item.get("server", "") or item.get("query", "")
                    status = "running" if kind == "item.started" else (
                        "error" if item.get("status") == "failed" else "done")
                    emit("step", {"tool": self.STEP_NAMES[itype], "detail": str(detail)[:120], "status": status})
            elif kind in ("turn.failed", "error"):
                message = event.get("message") or (event.get("error") or {}).get("message") or "Codex turn failed."
                emit("error", f"Codex: {message}")
                had_error = True
                break
        self._finish(proc, stderr, emit, text, had_error)


# ---------------------------------------------------------------- Claude
class ClaudeProvider(Provider):
    name = "claude"
    label = "Claude"
    accent = "#fbbf77"

    READ_ONLY_TOOLS = "Read,Glob,Grep,LS,WebSearch,WebFetch"
    AGENT_TOOLS = "Read,Edit,Write,MultiEdit,NotebookEdit,Glob,Grep,LS,Bash,WebSearch,WebFetch"

    @staticmethod
    def executable() -> str:
        home = Path.home()
        extra = [
            home / ".local" / "bin" / "claude.exe",
            home / ".local" / "bin" / "claude",
            home / "AppData" / "Roaming" / "npm" / "claude.cmd",
            home / ".claude" / "local" / "claude",
        ]
        return _which(["claude"], extra)

    def available(self) -> tuple[bool, str]:
        exe = self.executable()
        if not exe:
            return False, "Claude Code CLI not found. Install it (https://claude.com/claude-code) and sign in once."
        return True, Path(exe).name

    def run(self, prompt: str, ctx: ChatContext, emit: Emit) -> None:
        exe = self.executable()
        if not exe:
            emit("error", "Claude Code CLI not found. Install it from https://claude.com/claude-code and run `claude` once to sign in.")
            return
        args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        if ctx.agent:
            args += ["--allowedTools", self.AGENT_TOOLS, "--permission-mode", "acceptEdits"]
        else:
            args += ["--allowedTools", self.READ_ONLY_TOOLS]
        if ctx.session:
            args += ["--resume", ctx.session]
        # The persona goes through stdin with the first message rather than as a
        # command-line flag: multi-line arguments do not survive the .cmd shim.
        full_prompt = (ctx.system + "\n\n" + prompt) if (ctx.system and not ctx.session) else prompt
        try:
            proc, stderr = self._spawn(args, full_prompt, ctx.workdir)
        except OSError as exc:
            emit("error", f"Could not start Claude Code: {exc}")
            return
        text, streamed, had_error = "", False, False
        for event in self._iter_json_lines(proc):
            kind = event.get("type", "")
            if kind == "system" and event.get("session_id"):
                emit("session", event["session_id"])
            elif kind == "stream_event":
                inner = event.get("event") or {}
                itype = inner.get("type")
                if itype == "content_block_delta":
                    delta = inner.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        streamed = True
                        text += delta["text"]
                        emit("text", delta["text"])
                elif itype == "content_block_start":
                    block = inner.get("content_block") or {}
                    if block.get("type") == "tool_use":
                        emit("step", {"tool": block.get("name", "Tool"), "detail": "", "status": "running"})
            elif kind == "assistant" and not streamed:
                for block in (event.get("message") or {}).get("content", []):
                    if block.get("type") == "text" and block.get("text"):
                        text += block["text"]
                        emit("text", block["text"])
                    elif block.get("type") == "tool_use":
                        detail = block.get("input") or {}
                        hint = detail.get("file_path") or detail.get("pattern") or detail.get("query") or ""
                        emit("step", {"tool": block.get("name", "Tool"), "detail": str(hint)[:120], "status": "running"})
            elif kind == "user":
                # Tool results come back as user messages: mark the running step done.
                emit("step", {"tool": "", "detail": "", "status": "done"})
            elif kind == "result":
                if event.get("session_id"):
                    emit("session", event["session_id"])
                if event.get("is_error"):
                    emit("error", f"Claude: {event.get('result') or event.get('subtype') or 'request failed'}")
                    had_error = True
                elif not text and event.get("result"):
                    text = str(event["result"])
                    emit("text", text)
                break
        self._finish(proc, stderr, emit, text, had_error)


PROVIDERS: dict[str, type[Provider]] = {
    OllamaProvider.name: OllamaProvider,
    CodexProvider.name: CodexProvider,
    ClaudeProvider.name: ClaudeProvider,
}


def make(name: str, **kwargs) -> Provider:
    cls = PROVIDERS.get(name, OllamaProvider)
    if cls is OllamaProvider:
        return cls(kwargs.get("base_url", "http://127.0.0.1:11434"))
    return cls()
