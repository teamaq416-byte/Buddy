"""Drive the real Tk app under a virtual display and take screenshots.

Run:  xvfb-run -s "-screen 0 1280x800x24" python tests/smoke_gui.py OUTDIR
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp())
OUT.mkdir(parents=True, exist_ok=True)
DATA = Path(tempfile.mkdtemp(prefix="buddy-smoke-"))
os.environ["BUDDY_DATA_DIR"] = str(DATA)


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = json.dumps({"models": [{"name": "llama3.2:latest"}]}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length))
        self.send_response(200); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
        reply = "Hey! I'm Buddy. I can see " + str(len(req["messages"])) + " messages of context, and I'm streaming this reply word by word so the UI can show it live."
        words = reply.split(" ")
        for i, word in enumerate(words):
            chunk = json.dumps({"message": {"role": "assistant", "content": word + (" " if i < len(words) - 1 else "")},
                                "done": i == len(words) - 1}).encode() + b"\n"
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n"); self.wfile.flush()
            time.sleep(0.03)
        self.wfile.write(b"0\r\n\r\n")


server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"

from buddy.app import Buddy  # noqa: E402
from buddy.core import Core  # noqa: E402
from buddy.state import State  # noqa: E402

seed = State(DATA)
seed.settings.update(ollama_url=base, provider="ollama", assistant_name="Buddy", boss_name="Bolt")
seed.save()

core = Core(DATA)
core.start()
app = Buddy(core)
root = app.root
results: list[str] = []


def shot(name: str):
    root.update()
    subprocess.run(["import", "-window", "root", str(OUT / f"{name}.png")], check=False)
    results.append(name)


def bridge_call(agent, name, args):
    env = dict(os.environ, BUDDY_DATA_DIR=str(DATA), BUDDY_AGENT=agent)
    proc = subprocess.Popen([sys.executable, "-I", str(ROOT / "buddy" / "mcp_bridge.py")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, env=env)
    for i, (method, params) in enumerate((("initialize", {"protocolVersion": "2025-03-26"}),
                                          ("tools/call", {"name": name, "arguments": args}))):
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i + 1, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        proc.stdout.readline()
    proc.stdin.close()
    proc.wait(timeout=5)


steps = []


def step(delay, fn):
    steps.append((delay, fn))


def run_steps():
    if not steps:
        root.after(200, finish)
        return
    delay, fn = steps.pop(0)
    try:
        fn()
    except Exception as exc:
        print("STEP FAILED", fn, exc)
        results.append(f"FAILED {fn}")
    root.after(delay, run_steps)


def finish():
    checks = {
        "chat_reply_saved": any(m["role"] == "assistant" and "streaming" in m["text"] for m in app.state.chat),
        "claude_working_seen": app.state.agents["claude"]["steps"] != [],
        "task_added": any(t["text"] == "Write release notes" for t in app.state.tasks),
        "reminder_added": len(app.state.reminders) == 1,
        "panel_visible": app.panel.win.winfo_viewable() == 1,
        "island_chat_reply": any(m["role"] == "assistant" for m in app.state.chat[-1:]) and "2+2" in app.state.chat[-2]["text"],
        "do_mode_toggled": app.state.settings["agent_mode"] is True,
    }
    print(json.dumps({"screens": results, "checks": checks}, indent=1))
    app.close()
    server.shutdown()


# Scenario ------------------------------------------------------------------
w, h = app.island.size
step(600, lambda: shot("01_collapsed"))
step(50, lambda: setattr(app, "pointer", (w // 2, 20)))
step(50, lambda: setattr(app, "hover_until", time.perf_counter() + 5))
step(900, lambda: shot("02_expanded_hover"))
step(50, lambda: app.show_chat())
step(50, lambda: core.submit("hello there"))
step(400, lambda: shot("03_chat_streaming"))
step(2500, lambda: shot("04_chat_done"))
step(50, lambda: core.submit("/task Write release notes"))
step(50, lambda: core.submit("/remind 1h Stretch"))
step(50, lambda: core.submit("/help"))
step(300, lambda: shot("05_chat_commands"))
step(50, lambda: bridge_call("claude", "buddy_status", {"state": "working", "message": "Refactoring invoice totals"}))
step(50, lambda: bridge_call("claude", "buddy_step", {"tool": "Read", "detail": "src/invoice.ts"}))
step(50, lambda: bridge_call("claude", "buddy_step", {"tool": "Edit", "detail": "src/invoice.ts"}))
step(50, lambda: bridge_call("claude", "buddy_step", {"tool": "Bash", "detail": "npm test -- invoice"}))
step(900, lambda: shot("06_agent_working"))
step(50, lambda: bridge_call("claude", "buddy_status", {"state": "done", "message": "48 tests passed"}))
step(700, lambda: shot("07_agent_done_toast"))
step(50, lambda: bridge_call("codex", "buddy_status", {"state": "error", "message": "Build failed"}))
step(700, lambda: shot("08_agent_error"))
step(50, lambda: app.state.add_files([str(ROOT / "README.md"), str(ROOT / "main.py")]))
step(700, lambda: shot("09_files_received"))
step(50, lambda: app.show_tasks())
step(50, lambda: app.show_settings())
step(50, lambda: app.show_connect())
step(600, lambda: shot("10_windows"))
# inline island chat: click input, type, Enter
def press(k, ch=""):
    class E: keysym=k; char=ch; state=0
    app._on_key(E())
step(50, lambda: setattr(app, "hover_until", time.perf_counter() + 5))
step(600, lambda: app._on_release(type("E", (), {"x": app.island.hits["input"][0] + 10, "y": app.island.hits["input"][1] + 10})()))
step(50, lambda: [press(c, c) for c in "what is 2+2"])
step(300, lambda: shot("13_island_typing"))
step(50, lambda: press("Return"))
step(900, lambda: shot("14_island_streaming"))
step(2500, lambda: shot("15_island_reply"))
step(50, lambda: app._on_release(type("E", (), {"x": app.island.hits["mode"][0] + 5, "y": app.island.hits["mode"][1] + 5})()))
step(400, lambda: shot("16_island_do_mode"))
step(50, lambda: app.set_display("pet"))
step(50, lambda: app.say("Pet mode: I float wherever you drop me.", reaction="speak", bounce=1.0))
step(800, lambda: shot("11_pet_mode"))
step(50, lambda: app.set_display("notch"))
step(50, lambda: core.set_provider("codex"))
step(600, lambda: shot("12_codex_missing"))
root.after(300, run_steps)
app.run()
