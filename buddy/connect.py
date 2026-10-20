"""One-click MCP setup for Claude Desktop, Claude Code and Codex.

Existing configuration is always preserved: we only add or update the
single `buddy` server entry and keep a dated backup of the file we touched.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

from .providers import NO_WINDOW, ClaudeProvider
from .runtime import IS_WINDOWS, bridge_command, data_folder

SERVER_NAME = "buddy"


# ----------------------------------------------------------------- helpers
def _backup(path: Path) -> Path | None:
    if not path.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.buddy-backup-{stamp}")
    shutil.copy2(path, backup)
    return backup


def _server_entry(agent: str) -> dict:
    command = bridge_command()
    return {
        "command": command[0],
        "args": command[1:],
        "env": {"BUDDY_DATA_DIR": str(data_folder()), "BUDDY_AGENT": agent},
    }


def _owned(entry: dict) -> bool:
    """True when an existing `buddy` entry was written by Buddy (any version)."""
    if not isinstance(entry, dict):
        return False
    parts = [str(entry.get("command", ""))] + [str(a) for a in entry.get("args", []) or []]
    joined = " ".join(parts).lower()
    env = entry.get("env") or {}
    return "buddybridge" in joined or "mcp_bridge.py" in joined or "BUDDY_DATA_DIR" in env


# ------------------------------------------------------------ Claude Desktop
def claude_desktop_config_candidates() -> list[Path]:
    home = Path.home()
    found: list[Path] = []
    if IS_WINDOWS:
        roaming = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        found.append(roaming / "Claude" / "claude_desktop_config.json")
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        try:
            for pkg in (local / "Packages").glob("Claude*"):
                found.append(pkg / "LocalCache" / "Roaming" / "Claude" / "claude_desktop_config.json")
        except OSError:
            pass
    elif sys.platform == "darwin":
        found.append(home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json")
    else:
        found.append(home / ".config" / "Claude" / "claude_desktop_config.json")
    return found


def claude_desktop_config(explicit: str | Path | None = None) -> Path:
    override_file = data_folder() / "claude-location.txt"
    if explicit:
        path = Path(explicit)
        if path.is_dir():
            path = path / "claude_desktop_config.json"
        override_file.write_text(str(path), "utf-8")
        return path
    if override_file.exists():
        saved = Path(override_file.read_text("utf-8").strip())
        if saved.parent.exists():
            return saved
    candidates = claude_desktop_config_candidates()
    existing = [c for c in candidates if c.exists()]
    if existing:
        return existing[0]
    for c in candidates:
        if c.parent.exists():
            return c
    raise ValueError(
        "Claude Desktop config folder not found. In Claude: Settings → Developer → Edit Config, "
        "then use 'Browse…' in Buddy to pick that folder."
    )


def connect_claude_desktop(explicit: str | Path | None = None) -> str:
    path = claude_desktop_config(explicit)
    config: dict = {}
    if path.exists():
        try:
            config = json.loads(path.read_text("utf-8-sig") or "{}")
        except ValueError as exc:
            raise ValueError(f"{path} is not valid JSON ({exc}). Fix it in Claude first.") from exc
    servers = config.setdefault("mcpServers", {})
    entry = _server_entry("claude")
    existing = servers.get(SERVER_NAME)
    if existing and not _owned(existing):
        raise ValueError("Another MCP server already uses the name 'buddy'. Rename it in Claude first.")
    if existing == entry:
        return "Claude Desktop is already connected. Fully quit and reopen Claude if tools are missing."
    servers[SERVER_NAME] = entry
    backup = _backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), "utf-8")
    note = f"\nBackup: {backup.name}" if backup else ""
    return f"Claude Desktop connected. Fully quit and reopen Claude Desktop.{note}"


# --------------------------------------------------------------- Claude Code
def claude_code_config() -> Path:
    return Path.home() / ".claude.json"


def connect_claude_code() -> str:
    entry = _server_entry("claude")
    exe = ClaudeProvider.executable()
    if exe:
        # Let the CLI own its config format; remove a stale entry first.
        subprocess.run([exe, "mcp", "remove", "-s", "user", SERVER_NAME], capture_output=True,
                       creationflags=NO_WINDOW, timeout=30)
        args = [exe, "mcp", "add", "-s", "user"]
        for key, value in entry["env"].items():
            args += ["-e", f"{key}={value}"]
        args += [SERVER_NAME, "--", entry["command"], *entry["args"]]
        result = subprocess.run(args, capture_output=True, text=True, creationflags=NO_WINDOW, timeout=60)
        if result.returncode == 0:
            plant_claude_code()
            return "Claude Code connected (+ Buddy instructions in ~/.claude/CLAUDE.md). Start a new `claude` session to load Buddy tools."
        detail = (result.stderr or result.stdout).strip()[-300:]
        # Fall through to the file-based method with the CLI's complaint as context.
        cli_note = f" (CLI said: {detail})" if detail else ""
    else:
        cli_note = ""
    path = claude_code_config()
    config: dict = {}
    if path.exists():
        try:
            config = json.loads(path.read_text("utf-8-sig") or "{}")
        except ValueError as exc:
            raise ValueError(f"{path} is not valid JSON ({exc}).{cli_note}") from exc
    servers = config.setdefault("mcpServers", {})
    existing = servers.get(SERVER_NAME)
    if existing and not _owned(existing):
        raise ValueError("Another MCP server already uses the name 'buddy' in Claude Code. Rename it first.")
    if existing == entry:
        plant_claude_code()
        return "Claude Code is already connected. Start a new `claude` session if tools are missing."
    servers[SERVER_NAME] = entry
    backup = _backup(path)
    path.write_text(json.dumps(config, indent=2), "utf-8")
    plant_claude_code()
    note = f"\nBackup: {backup.name}" if backup else ""
    return f"Claude Code connected via ~/.claude.json. Start a new `claude` session.{note}{cli_note}"


# --------------------------------------------------------------------- Codex
def codex_config() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "config.toml"


def _toml_string(value: str) -> str:
    return json.dumps(value)  # JSON string escaping is valid TOML basic-string escaping


def _codex_block(entry: dict) -> str:
    args = ", ".join(_toml_string(a) for a in entry["args"])
    lines = [
        f"[mcp_servers.{SERVER_NAME}]",
        f"command = {_toml_string(entry['command'])}",
        f"args = [{args}]",
        "",
        f"[mcp_servers.{SERVER_NAME}.env]",
    ]
    for key, value in entry["env"].items():
        lines.append(f"{key} = {_toml_string(value)}")
    return "\n".join(lines) + "\n"


_SECTION = re.compile(r"^\[mcp_servers\.buddy(?:\.[^\]]+)?\]\s*$", re.M)
_ANY_HEADER = re.compile(r"^\[[^\]]+\]\s*$", re.M)


def _strip_buddy_sections(text: str) -> str:
    """Remove `[mcp_servers.buddy]` and its sub-tables, keep everything else."""
    lines = text.splitlines(keepends=True)
    out, skipping = [], False
    for line in lines:
        if _ANY_HEADER.match(line):
            skipping = bool(_SECTION.match(line))
        if not skipping:
            out.append(line)
    return "".join(out)


def connect_codex() -> str:
    path = codex_config()
    text = path.read_text("utf-8") if path.exists() else ""
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"{path} is not valid TOML ({exc}). Fix it in Codex first.") from exc
    entry = _server_entry("codex")
    existing = (parsed.get("mcp_servers") or {}).get(SERVER_NAME)
    if existing and not _owned(existing):
        raise ValueError("Another MCP server already uses the name 'buddy' in Codex. Rename it first.")
    if existing == entry:
        plant_codex()
        return "Codex is already connected. Restart Codex or start a new chat if tools are missing."
    cleaned = _strip_buddy_sections(text).rstrip("\n")
    new_text = (cleaned + "\n\n" if cleaned else "") + _codex_block(entry)
    tomllib.loads(new_text)  # sanity: never write something Codex cannot parse
    backup = _backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(new_text, "utf-8")
    note = f"\nBackup: {backup.name}" if backup else ""
    plant_codex()
    return f"Codex connected (+ Buddy instructions in ~/.codex/AGENTS.md). Restart Codex (app or CLI) to load Buddy tools.{note}"


# ------------------------------------------------------------ instructions
BUDDY_INSTRUCTIONS = "## Buddy\nBuddy (local desktop companion) is connected via MCP. For every user task: call buddy_status(state='working', message=<what you are doing>) when you start, buddy_step(tool, detail) for each file you read/edit and command you run, buddy_status(state='waiting') when you need the user, and buddy_status(state='done'|'error', message=<one-line summary>) when finished. Use buddy_files/buddy_read_file for files the user attached in Buddy. Report only real activity."
_START, _END = "<!-- buddy:start -->", "<!-- buddy:end -->"


def plant_instructions(file: Path) -> bool:
    """Add/refresh the Buddy block in an AGENTS.md / CLAUDE.md file (idempotent)."""
    text = file.read_text("utf-8") if file.exists() else ""
    block = f"{_START}\n{BUDDY_INSTRUCTIONS}\n{_END}"
    pattern = re.compile(re.escape(_START) + r"[\s\S]*?" + re.escape(_END))
    if pattern.search(text):
        new = pattern.sub(lambda _m: block, text)
        if new == text:
            return False
        text = new
    else:
        text = text.rstrip() + ("\n\n" if text.strip() else "") + block + "\n"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, "utf-8")
    return True


def plant_codex() -> bool:
    return plant_instructions(codex_config().parent / "AGENTS.md")


def plant_claude_code() -> bool:
    return plant_instructions(Path.home() / ".claude" / "CLAUDE.md")


# -------------------------------------------------------------------- status
def status() -> dict[str, str]:
    """Config-level view: configured | not_configured | other | missing."""
    result = {}
    entry_claude = _server_entry("claude")
    entry_codex = _server_entry("codex")

    def check(path: Path, servers: dict | None, entry: dict) -> str:
        if servers is None:
            return "missing"
        current = servers.get(SERVER_NAME)
        if not current:
            return "not_configured"
        if not _owned(current):
            return "other"
        return "configured" if current.get("env", {}).get("BUDDY_DATA_DIR") == entry["env"]["BUDDY_DATA_DIR"] else "other_install"

    try:
        path = claude_desktop_config()
        servers = json.loads(path.read_text("utf-8-sig")).get("mcpServers", {}) if path.exists() else {}
        result["claude_desktop"] = check(path, servers, entry_claude)
    except (ValueError, OSError):
        result["claude_desktop"] = "missing"
    try:
        path = claude_code_config()
        servers = json.loads(path.read_text("utf-8-sig")).get("mcpServers", {}) if path.exists() else {}
        result["claude_code"] = check(path, servers, entry_claude) if ClaudeProvider.executable() or path.exists() else "missing"
    except (ValueError, OSError):
        result["claude_code"] = "missing"
    try:
        path = codex_config()
        servers = tomllib.loads(path.read_text("utf-8")).get("mcp_servers", {}) if path.exists() else {}
        result["codex"] = check(path, servers, entry_codex) if path.parent.exists() else "missing"
    except (ValueError, OSError):
        result["codex"] = "missing"
    return result
