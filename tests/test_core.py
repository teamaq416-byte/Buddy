"""Core tests: state, tool server + MCP bridge, providers, connectors.

Run:  python -m pytest -q tests
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from buddy import connect, providers  # noqa: E402
from buddy.server import ToolServer  # noqa: E402
from buddy.state import State  # noqa: E402


# ------------------------------------------------------------------ state
def test_state_roundtrip(tmp_path):
    state = State(tmp_path)
    sample = tmp_path / "hello.txt"
    sample.write_text("hi there", "utf-8")
    assert state.add_files([sample, sample]) == [str(sample.resolve())]
    assert state.add_files([sample]) == []  # dedupe
    task = state.add_task("Ship it")
    reminder = state.add_reminder(5, "Stretch")
    state.add_chat("user", "hello", "ollama")

    again = State(tmp_path)
    assert again.files == [str(sample.resolve())]
    assert again.tasks[0]["id"] == task["id"]
    assert again.reminders[0]["id"] == reminder["id"]
    assert again.chat[0]["text"] == "hello"
    assert again.preview(sample) == "hi there"
    with pytest.raises(ValueError):
        again.preview(tmp_path / "state.json")  # not attached


def test_reminders_fire_once(tmp_path):
    state = State(tmp_path)
    state.add_reminder(1, "soon")
    assert state.due_reminders(now=time.time()) == []
    due = state.due_reminders(now=time.time() + 5)
    assert [r["message"] for r in due] == ["soon"]
    assert state.due_reminders(now=time.time() + 10) == []


def test_agent_activity_and_steps(tmp_path):
    state = State(tmp_path)
    events = []
    state.listeners.append(lambda kind, data: events.append((kind, data)))
    state.execute("buddy_status", {"agent": "claude", "state": "working", "message": "Reading"})
    state.execute("buddy_step", {"agent": "claude", "tool": "Read", "detail": "a.py"})
    state.execute("buddy_step", {"agent": "claude", "tool": "Edit", "detail": "a.py"})
    steps = state.agents["claude"]["steps"]
    assert [s["status"] for s in steps] == ["done", "running"]
    state.execute("buddy_status", {"agent": "codex", "state": "waiting", "message": "Need input"})
    assert state.headline()[:2] == ("codex", "waiting")
    state.execute("buddy_status", {"agent": "claude", "state": "done"})
    assert steps[-1]["status"] == "done"
    assert state.agent_activity("claude", now=time.time() + 1000)["state"] == "idle"  # stale
    assert ("step", {"agent": "claude", "step": steps[0]}) in events
    with pytest.raises(ValueError):
        state.execute("buddy_status", {"agent": "someone", "state": "working"})
    with pytest.raises(ValueError):
        state.execute("buddy_status", {"agent": "claude", "state": "dancing"})


# --------------------------------------------------------- server + bridge
def _bridge_session(data_dir: Path, agent: str = "codex"):
    env = dict(os.environ, BUDDY_DATA_DIR=str(data_dir), BUDDY_AGENT=agent)
    return subprocess.Popen(
        [sys.executable, "-I", str(ROOT / "buddy" / "mcp_bridge.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True,
    )


def _rpc(proc, request_id, method, params=None):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())


def test_server_and_bridge_roundtrip(tmp_path):
    state = State(tmp_path)
    server = ToolServer(state, tmp_path)
    server.start()
    try:
        # Unauthenticated requests are rejected.
        req = urllib.request.Request(f"http://127.0.0.1:{server.port}/tool", data=b"{}", method="POST")
        try:
            urllib.request.urlopen(req)
            assert False, "unauthenticated request accepted"
        except urllib.error.HTTPError as exc:
            assert exc.code == 401

        proc = _bridge_session(tmp_path, "codex")
        init = _rpc(proc, 1, "initialize", {"protocolVersion": "2025-03-26", "clientInfo": {"name": "t", "version": "1"}})
        assert init["result"]["protocolVersion"] == "2025-03-26"
        assert "buddy_status" in init["result"]["instructions"]
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()
        tools = _rpc(proc, 2, "tools/list")["result"]["tools"]
        assert {t["name"] for t in tools} >= {"buddy_status", "buddy_step", "buddy_files", "buddy_read_file",
                                              "buddy_remind", "buddy_task", "buddy_say"}
        sample = tmp_path / "note.md"
        sample.write_text("# note", "utf-8")
        state.add_files([sample])
        # The model cannot impersonate another agent: identity comes from env.
        call = _rpc(proc, 3, "tools/call", {"name": "buddy_status",
                                           "arguments": {"state": "working", "message": "Go", "agent": "claude"}})
        assert call["result"]["isError"] is False
        assert state.agents["codex"]["state"] == "working"
        assert state.agents["claude"]["state"] == "idle"
        files = _rpc(proc, 4, "tools/call", {"name": "buddy_files", "arguments": {}})
        assert str(sample.resolve()) in files["result"]["content"][0]["text"]
        read = _rpc(proc, 5, "tools/call", {"name": "buddy_read_file", "arguments": {"path": str(sample)}})
        assert "# note" in read["result"]["content"][0]["text"]
        bad = _rpc(proc, 6, "tools/call", {"name": "buddy_read_file", "arguments": {"path": str(tmp_path / "state.json")}})
        assert bad["result"]["isError"] is True
        _rpc(proc, 7, "tools/call", {"name": "buddy_task", "arguments": {"text": "Review"}})
        _rpc(proc, 8, "tools/call", {"name": "buddy_remind", "arguments": {"seconds": 30, "message": "Water"}})
        assert state.tasks[0]["text"] == "Review" and state.reminders[0]["message"] == "Water"
        unknown = _rpc(proc, 9, "nope/method")
        assert unknown["error"]["code"] == -32601
        deadline = time.time() + 5
        while time.time() < deadline and not state.agent_linked("codex"):
            time.sleep(0.05)
        assert state.agent_linked("codex")
        proc.stdin.close()
        proc.wait(timeout=5)
    finally:
        server.close()
    assert not (tmp_path / "connection.json").exists()


def test_bridge_without_app(tmp_path):
    proc = _bridge_session(tmp_path, "claude")
    _rpc(proc, 1, "initialize", {"protocolVersion": "2024-11-05"})
    call = _rpc(proc, 2, "tools/call", {"name": "buddy_files", "arguments": {}})
    assert call["result"]["isError"] is True
    assert "not running" in call["result"]["content"][0]["text"]
    proc.stdin.close()
    proc.wait(timeout=5)


# -------------------------------------------------------------- providers
class _FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = json.dumps({"models": [{"name": "llama3.2:latest"}, {"name": "qwen2.5:7b"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length))
        assert request["stream"] is True
        assert request["messages"][0]["role"] == "system"
        self.send_response(200)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for chunk, done in (("Hel", False), ("lo ", False), (request["model"], True)):
            line = json.dumps({"message": {"role": "assistant", "content": chunk}, "done": done}).encode() + b"\n"
            self.wfile.write(f"{len(line):x}\r\n".encode() + line + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")


def test_ollama_provider_streams():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        provider = providers.OllamaProvider(base)
        ok, detail = provider.available()
        assert ok and "2 model" in detail
        assert provider.models() == ["llama3.2:latest", "qwen2.5:7b"]
        events = []
        ctx = providers.ChatContext(system="You are Buddy", model="qwen2.5:7b", base_url=base)
        provider.run("hi", ctx, lambda k, v: events.append((k, v)))
        assert [e for e in events if e[0] == "text"] == [("text", "Hel"), ("text", "lo "), ("text", "qwen2.5:7b")]
        assert events[-1] == ("done", "Hello qwen2.5:7b")
    finally:
        server.shutdown()


def test_ollama_provider_offline():
    provider = providers.OllamaProvider("http://127.0.0.1:9")  # nothing listens here
    ok, detail = provider.available()
    assert not ok and "not running" in detail
    events = []
    provider.run("hi", providers.ChatContext(model="x", base_url="http://127.0.0.1:9"), lambda k, v: events.append((k, v)))
    assert events[-1][0] == "error" and "not reachable" in events[-1][1]


FAKE_CODEX = r'''
import json, sys
prompt = sys.stdin.read()
args = sys.argv[1:]
assert "--json" in args and "-s" in args and "read-only" in args and args[-1] == "-"
session = args[args.index("resume") + 1] if "resume" in args else "thread-123"
out = [
  {"type": "thread.started", "thread_id": session},
  {"type": "turn.started"},
  {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "ls -la", "status": "in_progress"}},
  {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "ls -la", "status": "completed"}},
  {"type": "item.completed", "item": {"id": "i2", "type": "agent_message", "text": "Echo: " + prompt.strip().splitlines()[-1]}},
  {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
]
for o in out: print(json.dumps(o))
'''

FAKE_CLAUDE = r'''
import json, sys
prompt = sys.stdin.read()
args = sys.argv[1:]
assert args[:2] == ["-p", "--output-format"] and "stream-json" in args and "--include-partial-messages" in args
assert "--allowedTools" in args
assert prompt.startswith("sys\n\n") or "--resume" in args   # persona rides along with the first message
prompt = prompt.strip().splitlines()[-1]
session = args[args.index("--resume") + 1] if "--resume" in args else "sess-abc"
out = [
  {"type": "system", "subtype": "init", "session_id": session},
  {"type": "stream_event", "event": {"type": "content_block_start", "content_block": {"type": "tool_use", "name": "Read"}}},
  {"type": "user", "message": {"content": [{"type": "tool_result"}]}},
  {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi "}}},
  {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": prompt.strip()}}},
  {"type": "assistant", "message": {"content": [{"type": "text", "text": "Hi " + prompt.strip()}]}},
  {"type": "result", "subtype": "success", "is_error": False, "result": "Hi " + prompt.strip(), "session_id": session},
]
for o in out: print(json.dumps(o))
'''


def _fake_cli(tmp_path: Path, name: str, code: str) -> str:
    script = tmp_path / f"{name}.py"
    script.write_text(code, "utf-8")
    return str(script)


def test_codex_provider(tmp_path, monkeypatch):
    script = _fake_cli(tmp_path, "codex", FAKE_CODEX)
    monkeypatch.setattr(providers.CodexProvider, "executable", staticmethod(lambda: sys.executable))
    provider = providers.CodexProvider()
    original = provider._spawn

    def spawn(args, prompt, cwd):
        return original([sys.executable, script] + args[1:], prompt, cwd)

    provider._spawn = spawn
    events = []
    provider.run("ping", providers.ChatContext(system="sys"), lambda k, v: events.append((k, v)))
    assert ("session", "thread-123") in events
    assert ("step", {"tool": "Bash", "detail": "ls -la", "status": "running"}) in events
    assert events[-1] == ("done", "Echo: ping")
    events.clear()
    provider.run("again", providers.ChatContext(session="thread-123"), lambda k, v: events.append((k, v)))
    assert events[-1] == ("done", "Echo: again")


def test_claude_provider(tmp_path):
    script = _fake_cli(tmp_path, "claude", FAKE_CLAUDE)
    provider = providers.ClaudeProvider()
    original = provider._spawn
    provider._spawn = lambda args, prompt, cwd: original([sys.executable, script] + args[1:], prompt, cwd)
    events = []
    provider.run("there", providers.ChatContext(system="sys"), lambda k, v: events.append((k, v)))
    assert ("session", "sess-abc") in events
    assert ("step", {"tool": "Read", "detail": "", "status": "running"}) in events
    assert [v for k, v in events if k == "text"] == ["Hi ", "there"]  # streamed, not duplicated
    assert events[-1] == ("done", "Hi there")


def test_cli_missing_reports_clearly(monkeypatch):
    monkeypatch.setattr(providers.CodexProvider, "executable", staticmethod(lambda: ""))
    monkeypatch.setattr(providers.ClaudeProvider, "executable", staticmethod(lambda: ""))
    for provider in (providers.CodexProvider(), providers.ClaudeProvider()):
        ok, detail = provider.available()
        assert not ok and "not found" in detail
        events = []
        provider.run("x", providers.ChatContext(), lambda k, v: events.append((k, v)))
        assert events == [("error", events[0][1])] and "not found" in events[0][1]


# --------------------------------------------------------------- connect
def test_connect_codex_preserves_config(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))
    monkeypatch.setenv("BUDDY_DATA_DIR", str(tmp_path / "data"))
    cfg = tmp_path / ".codex" / "config.toml"
    cfg.parent.mkdir()
    cfg.write_text('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["y"]\n\n'
                   '[mcp_servers.buddy]\ncommand = "old/BuddyBridge.exe"\nargs = []\n\n'
                   '[mcp_servers.buddy.env]\nBUDDY_DATA_DIR = "old"\n\n[tui]\ntheme = "dark"\n', "utf-8")
    message = connect.connect_codex()
    assert "Codex connected" in message
    import tomllib
    parsed = tomllib.loads(cfg.read_text("utf-8"))
    assert parsed["model"] == "o3" and parsed["tui"]["theme"] == "dark"
    assert parsed["mcp_servers"]["other"]["args"] == ["y"]
    buddy = parsed["mcp_servers"]["buddy"]
    assert buddy["env"]["BUDDY_AGENT"] == "codex"
    assert buddy["env"]["BUDDY_DATA_DIR"] == str((tmp_path / "data").resolve())
    assert "mcp_bridge.py" in " ".join(buddy["args"])
    assert list(cfg.parent.glob("config.toml.buddy-backup-*"))
    assert "already connected" in connect.connect_codex()
    cfg.write_text('[mcp_servers.buddy]\ncommand = "someone-else"\n', "utf-8")
    with pytest.raises(ValueError):
        connect.connect_codex()


def test_connect_claude_desktop(tmp_path, monkeypatch):
    monkeypatch.setenv("BUDDY_DATA_DIR", str(tmp_path / "data"))
    cfg = tmp_path / "Claude" / "claude_desktop_config.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"mcpServers": {"fs": {"command": "npx", "args": ["x"]}}, "theme": 1}), "utf-8")
    message = connect.connect_claude_desktop(cfg.parent)
    assert "connected" in message
    data = json.loads(cfg.read_text("utf-8"))
    assert data["theme"] == 1 and data["mcpServers"]["fs"]["args"] == ["x"]
    assert data["mcpServers"]["buddy"]["env"]["BUDDY_AGENT"] == "claude"
    assert "already connected" in connect.connect_claude_desktop()
    assert connect.status()["claude_desktop"] == "configured"


# ------------------------------------------------------------------ core
def test_core_commands_and_chat(tmp_path):
    from buddy.core import Core
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    core = Core(tmp_path)
    events = []
    core.subscribe(lambda k, p: events.append((k, p)))
    try:
        core.settings["ollama_url"] = f"http://127.0.0.1:{server.server_port}"
        core.set_provider("ollama")
        core.set_model("qwen2.5:7b")
        core.submit("/task Ship it")
        core.submit("/remind 5m Water")
        core.submit("/bogus")
        assert core.state.tasks[0]["text"] == "Ship it" and core.state.reminders[0]["message"] == "Water"
        assert any(k == "chat.system" and p["error"] for k, p in events)
        core.submit("hello")
        deadline = time.time() + 5
        while time.time() < deadline and not any(k == "chat.done" for k, _ in events):
            time.sleep(0.05)
        kinds = [k for k, _ in events]
        assert kinds.index("chat.user") < kinds.index("chat.begin") < kinds.index("chat.text") < kinds.index("chat.done")
        assert core.state.chat[-1]["role"] == "assistant" and core.state.chat[-1]["text"].startswith("Hello ")
        assert not core.chat_busy
        snap = core.snapshot()
        assert snap["provider"]["name"] == "ollama" and len(snap["chat"]) == 2 and snap["tasks"]
        problems = core.apply_settings({"assistant_name": "", "ollama_url": "ftp://x"})
        assert len(problems) == 2
        assert core.apply_settings({"assistant_name": "Mochi", "boss_name": "Bolt", "display_mode": "pet"}) == []
        assert core.assistant_name == "Mochi" and core.settings["display_mode"] == "pet"
    finally:
        core.close()
        server.shutdown()
