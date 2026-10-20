"""Buddy MCP bridge — dependency-free stdio MCP server.

Claude Desktop, Claude Code and Codex start this process. It forwards tool
calls to the running Buddy app over loopback HTTP using the port/token in
`<data folder>/connection.json`. If Buddy is not running, every tool returns
a clear error instead of pretending to succeed.

Environment:
    BUDDY_DATA_DIR  data folder written by Buddy (set by the connect step)
    BUDDY_AGENT     "claude" | "codex" — which client this bridge serves
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
VERSION = "1.0.0"
HEARTBEAT_SECONDS = 10


def data_folder() -> Path:
    custom = os.environ.get("BUDDY_DATA_DIR")
    if custom:
        return Path(custom).expanduser()
    if getattr(sys, "frozen", False):
        # <data>/bin/BuddyBridge-<hash>.exe -> <data>
        return Path(sys.executable).resolve().parent.parent
    # <project>/buddy/mcp_bridge.py -> <project>/Buddy-data
    return Path(__file__).resolve().parent.parent / "Buddy-data"


AGENT = os.environ.get("BUDDY_AGENT", "").strip().lower() or "claude"
SESSION = uuid.uuid4().hex[:12]
STOP = threading.Event()
_heartbeat_started = False
_write_lock = threading.Lock()


TOOLS = [
    {
        "name": "buddy_status",
        "description": (
            "Update the user's desktop companion (Buddy). Call with state='working' when you start a "
            "task, 'waiting' when you need the user, 'done' when finished, 'error' on failure. "
            "Include a short message (what you are doing). Report only real activity."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "enum": ["working", "waiting", "done", "error", "idle"]},
                "message": {"type": "string", "description": "Short status, max 160 chars"},
            },
            "required": ["state"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_step",
        "description": (
            "Show a tool step in Buddy's activity feed, e.g. tool='Read' detail='src/app.py', or "
            "tool='Bash' detail='npm test'. Each new running step completes the previous one. "
            "Use status='done' or 'error' to close the last step explicitly."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "description": "Read, Edit, Bash, Search, Test, …"},
                "detail": {"type": "string", "description": "File, command or short note"},
                "status": {"type": "string", "enum": ["running", "done", "error"]},
            },
            "required": ["tool"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_say",
        "description": "Show a short speech bubble from Buddy on the user's screen (max 200 chars).",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_files",
        "description": "List files the user attached or dropped onto Buddy.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "buddy_read_file",
        "description": "Read up to 32 KB of an attached text/code file. Only attached files can be read.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_remind",
        "description": "Schedule a local reminder shown by Buddy after N seconds (Buddy must be running).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "seconds": {"type": "integer", "minimum": 1, "maximum": 31622400},
                "message": {"type": "string"},
            },
            "required": ["seconds", "message"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_task",
        "description": "Add a task to the user's local checklist in Buddy.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "buddy_tasks",
        "description": "List the user's Buddy checklist (id, text, done).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "buddy_complete_task",
        "description": "Mark a Buddy task as done by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]

INSTRUCTIONS = (
    "Buddy is the user's desktop companion. When you begin a user task call buddy_status(state='working', "
    "message=...); call buddy_step as you read/edit/run things; call buddy_status(state='waiting') when you "
    "need the user, and buddy_status(state='done'|'error') when you finish. Report only real activity. "
    "Attached files, reminders and the checklist are also available through the buddy_* tools."
)


def local_call(name: str, arguments: dict) -> dict:
    """Forward one tool call to the running Buddy app."""
    connection = data_folder() / "connection.json"
    try:
        info = json.loads(connection.read_text("utf-8"))
    except (OSError, ValueError):
        raise RuntimeError("Buddy is not running. Start Buddy, then try again.")
    body = json.dumps({"name": name, "arguments": arguments}).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{int(info['port'])}/tool",
        data=body,
        headers={"Authorization": "Bearer " + str(info["token"]), "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Buddy is not reachable ({exc.reason}). Start Buddy, then try again.")
    if payload.get("error"):
        raise RuntimeError(payload["error"])
    return payload.get("result", {})


def heartbeat() -> None:
    while not STOP.is_set():
        try:
            local_call("buddy_heartbeat", {"agent": AGENT, "session": SESSION})
        except Exception:
            pass
        STOP.wait(HEARTBEAT_SECONDS)


def start_heartbeat() -> None:
    global _heartbeat_started
    if not _heartbeat_started:
        _heartbeat_started = True
        threading.Thread(target=heartbeat, daemon=True, name="buddy-heartbeat").start()


def tool_result(text: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def dispatch(method: str, params: dict) -> dict:
    if method == "initialize":
        requested = str(params.get("protocolVersion", ""))
        version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        start_heartbeat()
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "buddy", "version": VERSION},
            "instructions": INSTRUCTIONS,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method in ("prompts/list", "resources/list", "resources/templates/list"):
        return {method.split("/")[0]: []} if method != "resources/templates/list" else {"resourceTemplates": []}
    if method == "tools/call":
        name = str(params.get("name", ""))
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        if name not in {tool["name"] for tool in TOOLS}:
            return tool_result(f"Unknown tool: {name}", True)
        arguments = dict(arguments)
        arguments["agent"] = AGENT  # identity comes from config, never from the model
        if name == "buddy_status":
            arguments["session"] = SESSION
        try:
            result = local_call(name, arguments)
        except Exception as exc:
            return tool_result(f"Buddy tool failed: {exc}", True)
        return tool_result(json.dumps(result, ensure_ascii=False))
    raise KeyError(method)


def write(message: dict) -> None:
    data = json.dumps(message, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()


def main() -> None:
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        request_id = message.get("id")
        method = str(message.get("method", ""))
        params = message.get("params") or {}
        if request_id is None:  # notification: never answer
            continue
        try:
            result = dispatch(method, params if isinstance(params, dict) else {})
            write({"jsonrpc": "2.0", "id": request_id, "result": result})
        except KeyError:
            write({"jsonrpc": "2.0", "id": request_id,
                   "error": {"code": -32601, "message": f"Method not found: {method}"}})
        except Exception as exc:
            write({"jsonrpc": "2.0", "id": request_id,
                   "error": {"code": -32603, "message": f"Internal error: {exc}"}})
    STOP.set()


if __name__ == "__main__":
    main()
