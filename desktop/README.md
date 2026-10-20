# Buddy 2.0 — Electron edition (Route B)

Same Buddy, native-web stack: transparent always-on-top island window, WebView-quality chat panel,
tray icon, global hotkey, native drag-and-drop — one process, no Python, no ctypes.

## Run / build

```
cd desktop
npm install          # electron + test tooling (dev only; the app has zero runtime deps)
npm start            # run from source
npm test             # end-to-end (launches the real app; on Linux: xvfb-run -a node tests/e2e.js out)
npm run package:win  # dist/Buddy-win-x64/ + dist/Buddy-2.0.0-win-x64-portable.zip  (works on Linux/macOS/Windows)
npm run setup        # dist/Buddy-Setup.cmd — ONE ~300 KB file: embeds the app, downloads Electron from GitHub on the PC
```

The portable build is just the prebuilt Electron runtime with the app in `resources/app`, the exe renamed and
stamped (icon + version info) with pure-JS `resedit`, so it can be produced on any OS without wine.
Double-click `Buddy.exe`; data lives in `Buddy-data` beside it (or `%APPDATA%\buddy-desktop\Buddy-data`
if that folder isn't writable).

## One-file installer

`Buddy-Setup.cmd` carries the app as an embedded zip. On the user's PC it downloads the matching Electron
release from GitHub (~105 MB, cached in %TEMP%), extracts into `%LOCALAPPDATA%\Buddy`, stamps `Buddy.exe`
(icon/version via resedit running under Electron-as-Node), creates Desktop + Start-menu shortcuts and launches.
Re-running it upgrades in place; `Buddy-data` is kept.

## Layout

```
src/main.js                 windows (island, panel), tray, Win+Shift+B, IPC API
src/preload.js              contextBridge: window.buddyBridge.{call,onEvent,pathFor}
src/core.js                 Core: state + loopback tool server + providers + MCP connectors
src/state.js                JSON state, tasks, reminders, files, agent feeds, tool surface
src/providers.js            Ollama (fetch streaming), Codex CLI, Claude Code CLI
src/bridge/buddy-mcp.js     stdio MCP server; clients run `Buddy.exe <script>` with ELECTRON_RUN_AS_NODE=1
src/renderer/island.html    island UI (DOM/CSS, inline chat, Ask/Do, feed, toast, pet mode)
src/renderer/panel.html     generated from ../buddy/web/panel.html by scripts/sync-panel.js
scripts/package-win.js      portable Windows build
tests/e2e.js                Playwright-driven end-to-end run of the real app
```

The MCP tools, event protocol, settings and Do/Ask semantics are identical to the Python edition, so
Claude/Codex connected to either one behave the same.
