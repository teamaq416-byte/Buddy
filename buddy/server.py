"""Loopback HTTP server the MCP bridge talks to.

The bridge (a separate process started by Claude/Codex) posts tool calls to
`http://127.0.0.1:<port>/tool` with a bearer token. Port and token live in
`connection.json` inside the data folder, which only this user can read.
"""
from __future__ import annotations

import hmac
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .state import State

MAX_BODY = 64 * 1024


class ToolServer:
    def __init__(self, state: State, folder: Path):
        self.state = state
        self.folder = Path(folder)
        self.token = secrets.token_urlsafe(32)
        self.connection_file = self.folder / "connection.json"
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):  # keep the console quiet
                pass

            def _reply(self, status: int, payload: dict):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/health":
                    self._reply(200, {"ok": True})
                else:
                    self._reply(404, {"error": "Not found"})

            def do_POST(self):
                if self.path != "/tool":
                    self._reply(404, {"error": "Not found"})
                    return
                auth = self.headers.get("Authorization", "")
                if not hmac.compare_digest(auth, "Bearer " + server_self.token):
                    self._reply(401, {"error": "Unauthorized"})
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = -1
                if not 0 <= length <= MAX_BODY:
                    self._reply(413, {"error": "Invalid request size"})
                    return
                try:
                    request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                    result = server_self.state.execute(str(request.get("name", "")), request.get("arguments") or {})
                except ValueError as exc:
                    self._reply(200, {"error": str(exc)})
                    return
                except Exception as exc:  # defensive: never crash the server thread
                    self._reply(200, {"error": f"Buddy internal error: {exc}"})
                    return
                self._reply(200, {"result": result})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True, name="buddy-tool-server")

    def start(self) -> None:
        self.connection_file.write_text(
            json.dumps({"port": self.port, "token": self.token}), "utf-8"
        )
        self.thread.start()

    def close(self) -> None:
        try:
            self.server.shutdown()
            self.server.server_close()
        except Exception:
            pass
        try:
            data = json.loads(self.connection_file.read_text("utf-8"))
            if data.get("token") == self.token:
                self.connection_file.unlink()
        except (OSError, ValueError):
            pass
