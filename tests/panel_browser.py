"""Render buddy/web/panel.html in headless Chromium with a mocked pywebview API.

Run:  python tests/panel_browser.py OUTDIR
Exits non-zero if any console error occurs or a check fails.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/panel-shots")
OUT.mkdir(parents=True, exist_ok=True)

SNAP = {
    "version": "1.0.0",
    "settings": {"assistant_name": "Buddy", "boss_name": "Bolt", "display_mode": "notch", "provider": "ollama",
                 "ollama_url": "http://127.0.0.1:11434", "ollama_model": "llama3.2:latest", "workdir": "", "sessions": {}},
    "provider": {"name": "ollama", "label": "Ollama", "accent": "#7dd3fc", "detail": "llama3.2:latest", "ok": True,
                 "models": ["llama3.2:latest", "qwen2.5:7b"], "model": "llama3.2:latest", "checking": False,
                 "all": [{"name": "ollama", "label": "Ollama", "accent": "#7dd3fc"},
                         {"name": "codex", "label": "Codex", "accent": "#5eead4"},
                         {"name": "claude", "label": "Claude", "accent": "#fbbf77"}]},
    "chat": [], "files": [], "tasks": [], "busy": False, "agents": {}, "linked": {}, "windows": True,
}

MOCK = """
window.__calls = [];
window.pywebview = { api: new Proxy({}, { get: (_, name) => (...args) => {
  window.__calls.push([name, args]);
  if (name === 'boot') return Promise.resolve(window.__snap);
  if (name === 'connect_status') return Promise.resolve({claude_desktop:'configured', claude_code:'not_configured', codex:'missing'});
  if (name === 'get_settings') return Promise.resolve({settings: window.__snap.settings, autostart: true, windows: true});
  if (name === 'save_settings') return Promise.resolve(args[0].assistant_name ? [] : ['Names must be 1–24 characters.']);
  if (name === 'connect') return Promise.resolve({ok:true, message:'Codex connected. Restart Codex.'});
  if (name === 'open_path') return Promise.resolve(true);
  return Promise.resolve(null);
}})};
"""

REPLY = ("Here's what I found in **invoice.ts**:\n\n- `TVA` was hard-coded to `0.196`\n- the total ignored rounding\n\n"
         "```ts\nexport function total(items: Item[]) {\n  const sum = items.reduce((s, i) => s + i.price, 0)\n  return Math.round(sum * (1 + TVA) * 100) / 100\n}\n```\n\n"
         "Want me to run the tests? See [the docs](https://example.com/docs).")


def main() -> int:
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 480, "height": 660}, device_scale_factor=2)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script(f"window.__snap = {json.dumps(SNAP)};" + MOCK)
        page.goto((ROOT / "buddy" / "web" / "panel.html").as_uri())
        page.wait_for_selector(".empty")
        page.screenshot(path=str(OUT / "p01_empty.png"))

        def on(kind, payload):
            page.evaluate("([k,p]) => window.buddy.on(k,p)", [kind, payload])

        on("chat.user", {"text": "What's wrong with the invoice code?"})
        on("chat.begin", {"provider": "claude", "label": "Claude"})
        on("chat.step", {"tool": "Read", "detail": "src/invoice.ts", "status": "running"})
        on("chat.step", {"tool": "Grep", "detail": "TVA", "status": "running"})
        on("chat.step", {"tool": "", "detail": "", "status": "done"})
        for i in range(0, len(REPLY), 7):
            on("chat.text", {"chunk": REPLY[i:i + 7]})
        page.screenshot(path=str(OUT / "p02_streaming.png"))
        on("chat.done", {"text": REPLY, "provider": "claude"})
        on("chat.system", {"text": "Added task: Write release notes", "error": False})
        on("chat.error", {"message": "Ollama is not running. Start the Ollama app or run `ollama serve`.", "stopped": False})
        on("files", {"files": ["C:/Users/bolt/src/invoice.ts", "C:/Users/bolt/notes.md"], "added": ["C:/Users/bolt/notes.md"], "removed": []})
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "p03_reply.png"))

        # streamed text must not be duplicated and code block must render
        body = page.inner_text(".msg.ai .body")
        assert body.count("Here's what I found") == 1, "reply duplicated"
        assert page.locator(".msg.ai pre code").count() == 1, "code block missing"
        assert page.locator(".msg.ai .step").count() == 2
        assert page.locator(".msg.ai .step.done").count() == 2
        assert page.locator(".file").count() == 2
        assert "<b>" in page.inner_html(".msg.ai .body") and "<script" not in page.inner_html(".msg.ai .body")

        # slash menu + sending
        page.fill("#input", "/re")
        page.wait_for_selector(".slash.show")
        page.screenshot(path=str(OUT / "p04_slash.png"))
        page.keyboard.press("Enter")
        assert page.input_value("#input") == "/remind 10m "
        page.fill("#input", "hello there")
        page.keyboard.press("Enter")
        calls = page.evaluate("window.__calls")
        assert ["send", ["hello there"]] in calls, calls
        on("chat.begin", {"provider": "ollama", "label": "Ollama"})
        assert page.locator("#send.stop").count() == 1  # busy → stop button
        page.click("#send")
        assert ["stop", []] in page.evaluate("window.__calls")
        on("chat.error", {"message": "Stopped.", "stopped": True})

        # provider switch
        page.click(".seg button[data-p=claude]")
        assert ["set_provider", ["claude"]] in page.evaluate("window.__calls")
        on("provider", dict(SNAP["provider"], name="claude", label="Claude", accent="#fbbf77", detail="claude.exe"))
        page.wait_for_timeout(100)
        assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()") == "#fbbf77"
        assert page.locator("#modelwrap").is_hidden()

        # tasks view
        on("tasks", {"tasks": [{"id": "a1", "text": "Write release notes", "done": False, "created": time.time()},
                               {"id": "a2", "text": "Ship 1.0", "done": True, "created": time.time()}]})
        page.click(".nav button[data-view=tasks]")
        page.wait_for_selector(".task")
        page.fill("#newtask", "Call Sara")
        page.keyboard.press("Enter")
        assert ["add_task", ["Call Sara"]] in page.evaluate("window.__calls")
        page.screenshot(path=str(OUT / "p05_tasks.png"))

        # connect view
        page.click(".nav button[data-view=connect]")
        page.wait_for_selector(".cardc .stt:text('Connected')")
        page.click(".cardc[data-k=codex] [data-c]")
        page.wait_for_selector(".msgbox.ok")
        page.screenshot(path=str(OUT / "p06_connect.png"))

        # settings view
        page.click(".nav button[data-view=settings]")
        page.wait_for_selector("#s_save")
        page.click("#s_mode button[data-m=pet]")
        page.fill("#s_assistant", "")
        page.click("#s_save")
        page.wait_for_selector(".problem")
        page.fill("#s_assistant", "Mochi")
        page.click("#s_save")
        page.wait_for_selector(".saved")
        saved = [c for c in page.evaluate("window.__calls") if c[0] == "save_settings"][-1][1][0]
        assert saved["display_mode"] == "pet" and saved["assistant_name"] == "Mochi", saved
        page.screenshot(path=str(OUT / "p07_settings.png"))

        # escape returns to chat, then hides
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
        assert page.locator("#view-chat.active").count() == 1
        page.keyboard.press("Escape")
        assert ["hide", []] in page.evaluate("window.__calls")
        browser.close()
    if errors:
        print("CONSOLE ERRORS:", *errors, sep="\n")
        return 1
    print("panel ok →", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
