'use strict';
// Electron main process: island + panel windows, tray, global hotkey, IPC.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Core } = require('./core');

const VERSION = app.getVersion();
const ISLAND = { w: 560, h: 340 };
const PET = { w: 360, get h() { try { return Math.max(560, Math.min(1000, screen.getPrimaryDisplay().workArea.height - 24)); } catch { return 560; } } }; // tall: the pet's chat thread uses most of the screen height
const PANEL = { w: 480, h: 660 };
const isWin = process.platform === 'win32';

let core, island, panel, tray, quickWin, panelVisible = false, quitting = false;

function dataDir() {
  const custom = process.env.BUDDY_DATA_DIR;
  if (custom) return custom;
  // Portable: beside the exe when writable, else per-user app data.
  const beside = path.join(path.dirname(process.execPath), 'Buddy-data');
  try { fs.mkdirSync(beside, { recursive: true }); fs.accessSync(beside, fs.constants.W_OK); return beside; } catch { return path.join(app.getPath('userData'), 'Buddy-data'); }
}

// Keep island animations at full rate even when it is not the focused window.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => showPanel('chat'));

function islandBounds(mode) {
  const { bounds } = screen.getPrimaryDisplay(); let { workArea } = screen.getPrimaryDisplay();
  if (mode === 'pet') {
    const saved = core.settings.pet_pos;
    if (saved) { try { workArea = screen.getDisplayNearestPoint({ x: saved[0] + 60, y: saved[1] + 60 }).workArea; } catch { /* primary */ } } // the pet may live on a second monitor
    const x = saved ? Math.max(workArea.x, Math.min(workArea.x + workArea.width - PET.w, saved[0])) : workArea.x + workArea.width - PET.w - 16;
    const y = saved ? Math.max(workArea.y, Math.min(workArea.y + workArea.height - PET.h, saved[1])) : workArea.y + workArea.height - PET.h - 16;
    return { x, y, width: PET.w, height: PET.h };
  }
  return { x: bounds.x + Math.round((bounds.width - ISLAND.w) / 2), y: bounds.y, width: ISLAND.w, height: ISLAND.h };
}

function createIsland() {
  const mode = core.settings.display_mode;
  island = new BrowserWindow({
    ...islandBounds(mode), frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, focusable: true, show: false, backgroundColor: '#00000000', title: 'Buddy',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, spellcheck: true },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.loadFile(path.join(__dirname, 'renderer', 'island.html'), { query: { mode } });
  island.once('ready-to-show', () => island.showInactive());
  island.on('closed', () => { island = null; });
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL.w, height: PANEL.h, frame: false, transparent: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false,
    backgroundColor: '#0c0e14', title: 'Buddy', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true },
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panel.on('close', e => { if (!quitting) { e.preventDefault(); hidePanel(); } });
  panel.on('blur', () => { /* stays open: user may be copying from another app */ });
  panel.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function panelPosition() {
  const b = island ? island.getBounds() : islandBounds('notch');
  const { workArea } = screen.getPrimaryDisplay();
  let x, y;
  if (core.settings.display_mode === 'pet') { x = b.x + b.width / 2 - PANEL.w / 2; y = b.y - PANEL.h - 8; }
  else { x = b.x + b.width / 2 - PANEL.w / 2; y = b.y + (lastPlateHeight || 196) + 10; }
  return { x: Math.round(Math.max(workArea.x + 8, Math.min(workArea.x + workArea.width - PANEL.w - 8, x))), y: Math.round(Math.max(workArea.y + 8, Math.min(workArea.y + workArea.height - PANEL.h - 8, y))) };
}
let lastPlateHeight = 196;
function showPanel(view = 'chat') {
  if (!panel) { createPanel(); attachSpellMenu(panel); }
  const { x, y } = panelPosition();
  panel.setPosition(x, y);
  panel.show(); panel.focus(); panelVisible = true;
  panel.webContents.send('buddy:event', 'show', { view });
  if (island) island.webContents.send('buddy:event', 'panel', { visible: true });
}
function hidePanel() { if (panel) panel.hide(); panelVisible = false; if (island) island.webContents.send('buddy:event', 'panel', { visible: false }); }
function togglePanel(view) { panelVisible && view === 'chat' ? hidePanel() : showPanel(view); }

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', isWin ? 'buddy.ico' : 'buddy-32.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Buddy');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open chat' + (isWin ? '\tWin+Shift+B' : ''), click: () => showPanel('chat') },
    { label: 'Screenshot to Buddy' + (isWin ? '\tWin+Shift+X' : ''), click: () => snipToBuddy() },
    { label: 'Planner', click: () => showPanel('tasks') }, { label: 'Quick action on selection' + (isWin ? '\tCtrl+Shift+Space' : ''), click: () => openQuick() },
    { label: 'Attach files…', click: pickFiles },
    { type: 'separator' },
    { label: 'Top of screen (notch)', type: 'radio', checked: core.settings.display_mode === 'notch', click: () => setDisplay('notch') },
    { label: 'Floating pet', type: 'radio', checked: core.settings.display_mode === 'pet', click: () => setDisplay('pet') },
    { type: 'separator' },
    { label: 'Settings…', click: () => showPanel('settings') },
    { label: 'Connect AI apps…', click: () => showPanel('connect') },
    { type: 'separator' },
    { label: 'Quit Buddy', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', () => togglePanel('chat'));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

async function pickFiles() {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: 'Attach files to Buddy' });
  if (!r.canceled && r.filePaths.length) core.attach(r.filePaths);
  return r.filePaths || [];
}

function uninstall(keepData) {
  if (!isWin) return { error: 'Uninstall is automated on Windows only. Delete the Buddy folder to remove it.' };
  const dir = path.dirname(process.execPath);
  const data = dataDir();
  try { app.setLoginItemSettings({ openAtLogin: false, path: process.execPath }); } catch { /* */ }
  const lines = ['@echo off', 'timeout /t 2 /nobreak >nul', 'taskkill /f /im Buddy.exe >nul 2>nul', 'timeout /t 1 /nobreak >nul',
    `powershell -NoProfile -Command "foreach($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))){ Remove-Item -LiteralPath (Join-Path $d 'Buddy.lnk') -ErrorAction SilentlyContinue }"`,
    'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v Buddy /f >nul 2>nul'];
  if (keepData && data.startsWith(dir)) {
    lines.push(`move /y "${data}" "%TEMP%\\Buddy-data-keep" >nul 2>nul`, `rd /s /q "${dir}"`, `mkdir "${dir}"`, `move /y "%TEMP%\\Buddy-data-keep" "${data}" >nul 2>nul`,
      `echo Buddy removed. Your data is still in "${data}" & pause`);
  } else {
    lines.push(`rd /s /q "${dir}"`);
    if (!keepData && !data.startsWith(dir)) lines.push(`rd /s /q "${data}"`);
    lines.push(keepData ? `echo Buddy removed. Your data is still in "${data}" & pause` : 'echo Buddy removed. & timeout /t 3 >nul');
  }
  lines.push('del "%~f0"');
  const script = path.join(app.getPath('temp'), 'buddy-uninstall.cmd');
  fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
  require('child_process').spawn('cmd.exe', ['/c', `start "Buddy uninstall" "${script}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  quitting = true; setTimeout(() => app.quit(), 300);
  return { ok: true };
}

let loginShownAt = 0;
// Spell check: red underline while typing (Chromium spellchecker) + right-click → suggestions, "Add to dictionary"
// (so Roman Urdu words stop being flagged), and the usual cut/copy/paste.
function attachSpellMenu(win) {
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable) return;
    const items = [];
    if (p.misspelledWord) {
      for (const sug of (p.dictionarySuggestions || []).slice(0, 6)) items.push({ label: sug, click: () => win.webContents.replaceMisspelling(sug) });
      if (!items.length) items.push({ label: 'No suggestions', enabled: false });
      items.push({ type: 'separator' }, { label: `Add "${p.misspelledWord}" to dictionary`, click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
function setupSpellcheck() {
  try { const s = require('electron').session.defaultSession; if (process.platform !== 'darwin') s.setSpellCheckerLanguages(['en-US']); s.setSpellCheckerEnabled(true); } catch { /* */ }
}
function openLogin(which) { return core.signIn(which === 'codex' || which === 'gemini' ? which : 'claude'); }
// Screenshot → Buddy: capture the display under the cursor, let the user drag a region, attach it and open the chat.
// Frosted backdrop for the pet chat: a small, low-res capture of the screen *behind* Buddy (Buddy hides itself from the
// capture with content protection for a moment), which the page blurs and tints. Windows and macOS only.
let backdropBusy = false;
async function captureBackdrop() {
  if (!island || island.isDestroyed() || backdropBusy || !(isWin || process.platform === 'darwin')) return null;
  backdropBusy = true;
  try {
    const { desktopCapturer } = require('electron');
    const disp = screen.getDisplayMatching(island.getBounds());
    const scale = 0.25; // it gets blurred anyway, so a quarter-size capture is plenty and cheap
    island.setContentProtection(true);
    await new Promise(r => setTimeout(r, 70));
    let srcs;
    try { srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(disp.bounds.width * scale), height: Math.round(disp.bounds.height * scale) } }); }
    finally { if (island && !island.isDestroyed()) island.setContentProtection(false); }
    const src = srcs.find(sr => String(sr.display_id) === String(disp.id)) || (srcs.length === 1 ? srcs[0] : null);
    if (!src || src.thumbnail.isEmpty()) return null;
    return { url: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(72).toString('base64'), display: disp.bounds };
  } catch { return null; } finally { backdropBusy = false; }
}

let snipWin = null, snipping = false;
async function snipToBuddy() {
  if (snipping || snipWin) return; snipping = true;
  try { await snipRun(); } finally { snipping = false; }
}
async function snipRun() {
  const { desktopCapturer, nativeImage } = require('electron');
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); const { x, y, width, height } = disp.bounds; const sf = disp.scaleFactor || 1;
  try { if (island) island.hide(); } catch { /* */ }
  await new Promise(r => setTimeout(r, 120));
  let shot = null;
  try { const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) } }); const src = srcs.find(sr => String(sr.display_id) === String(disp.id)) || srcs[0]; shot = src && src.thumbnail; } catch (e) { core.system('Screenshot failed: ' + e.message, true); }
  try { if (island) island.showInactive(); } catch { /* */ }
  if (!shot || shot.isEmpty()) return;
  const win = snipWin = new BrowserWindow({ x, y, width, height, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.setAlwaysOnTop(true, 'screen-saver'); win.loadFile(path.join(__dirname, 'renderer', 'snip.html')); win.focus();
  const done = (e, r) => {
    if (e && e.sender && !win.isDestroyed() && e.sender !== win.webContents) return; // another window's answer
    ipcMain.removeListener('snip:done', done); try { if (!win.isDestroyed()) win.close(); } catch { /* */ } if (snipWin === win) snipWin = null;
    if (!r) return;
    const img = shot.crop({ x: Math.round(r.x * sf), y: Math.round(r.y * sf), width: Math.round(r.w * sf), height: Math.round(r.h * sf) });
    const dir = path.join(core.folder, 'shots'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'shot-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
    fs.writeFileSync(file, img.toPNG()); core.attach([file]); showPanel('chat'); core.ev('say', { agent: '', text: 'Got the screenshot — what should I do with it?', reaction: 'receive' });
  };
  ipcMain.on('snip:done', done); win.on('closed', () => { ipcMain.removeListener('snip:done', done); if (snipWin === win) snipWin = null; });
}
// ------------------------------------------------------------------ quick actions (global hotkey on selected text)
let quickBusy = false;
function quickPosition() {
  const c = screen.getCursorScreenPoint(); const wa = screen.getDisplayNearestPoint(c).workArea; const W = 440, H = 360;
  return { x: Math.max(wa.x + 8, Math.min(wa.x + wa.width - W - 8, c.x - 40)), y: Math.max(wa.y + 8, Math.min(wa.y + wa.height - H - 8, c.y + 18)), width: W, height: H };
}
async function openQuick(preset) {
  if (quickBusy) return; quickBusy = true;
  try {
    const sel = preset || await core.assistant.captureSelection(); core.quickSel = sel;
    if (!quickWin || quickWin.isDestroyed()) {
      quickWin = new BrowserWindow({ ...quickPosition(), frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, hasShadow: false, backgroundColor: '#00000000', title: 'Buddy quick',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: true } });
      quickWin.setAlwaysOnTop(true, 'pop-up-menu'); quickWin.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
      quickWin.on('blur', () => { if (quickWin && !quickWin.isDestroyed() && !quickWin.webContents.isDevToolsOpened() && !core.quickPinned) quickWin.hide(); });
      quickWin.on('closed', () => { quickWin = null; });
      await new Promise(r => quickWin.webContents.once('did-finish-load', r));
    } else quickWin.setBounds(quickPosition());
    quickWin.webContents.send('buddy:event', 'quick.open', { ...sel, provider: core.provider.label });
    quickWin.setAlwaysOnTop(true, 'screen-saver'); quickWin.show(); quickWin.focus(); quickWin.webContents.focus();
  } finally { quickBusy = false; }
}
function registerQuickHotkey() {
  for (const a of ['CommandOrControl+Shift+Space', 'Alt+Space']) { try { globalShortcut.unregister(a); } catch { /* */ } }
  if (registerQuickHotkey.acc) { try { globalShortcut.unregister(registerQuickHotkey.acc); } catch { /* */ } registerQuickHotkey.acc = ''; }
  if (core.settings.quick_hotkey === false) return;
  const acc = core.settings.quick_hotkey_accel || 'CommandOrControl+Shift+Space'; let ok = false;
  try { ok = globalShortcut.register(acc, () => openQuick()); } catch { ok = false; }
  if (ok) registerQuickHotkey.acc = acc; else setTimeout(() => core.ev('say', { agent: '', text: `The quick-action hotkey ${acc.replace('CommandOrControl', 'Ctrl')} is taken by another app — pick another one in Settings → Assistant.`, reaction: 'error' }), 4000);
}
async function screenshotToFile() {
  const { desktopCapturer } = require('electron'); const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); const sf = disp.scaleFactor || 1;
  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(disp.bounds.width * sf), height: Math.round(disp.bounds.height * sf) } });
  const src = srcs.find(s => String(s.display_id) === String(disp.id)) || srcs[0]; if (!src || src.thumbnail.isEmpty()) return '';
  const dir = path.join(core.folder, 'shots'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'screen-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
  fs.writeFileSync(file, src.thumbnail.toPNG()); return file;
}
function onWake() {
  // "Hey Buddy": open the chat where Buddy lives, focus the box and start voice typing
  if (core.settings.display_mode === 'pet' && island) { island.webContents.send('buddy:event', 'wake.open', {}); }
  else showPanel('chat');
  setTimeout(() => core.assistant.dictate().catch(() => {}), 650);
}

function setDisplay(mode) {
  if (!['notch', 'pet'].includes(mode) || mode === core.settings.display_mode) return;
  core.settings.display_mode = mode; core.state.save();
  if (island) { island.setBounds(islandBounds(mode)); island.webContents.send('buddy:event', 'display', { mode }); }
  core.ev('settings', { settings: { ...core.settings } });
}

// ------------------------------------------------------------------ IPC
function broadcast(kind, payload) {
  for (const w of [island, panel, quickWin]) if (w && !w.isDestroyed()) w.webContents.send('buddy:event', kind, payload);
}
ipcMain.handle('api', async (e, method, args) => {
  const sender = BrowserWindow.fromWebContents(e.sender);
  switch (method) {
    case 'boot': return core.snapshot(VERSION);
    case 'island': return core.island();
    case 'send': return core.submit(args[0], args[1]);
    case 'permission_reply': return core.permissionReply(args[0], args[1]);
    case 'forget_always_allow': core.forgetAlways(); return true;
    case 'always_allowed': return [];
    case 'backend_limits': return require('./policy').BACKENDS;
    case 'stop': return core.stop();
    case 'set_provider': return core.setProvider(args[0]);
    case 'set_model': return core.setModel(args[0]);
    case 'clear_chat': return core.clearChat();
    case 'set_agent_mode': return core.setAgentMode(!!args[0]);
    case 'attach': return pickFiles();
    case 'snip': snipToBuddy(); return true;
    case 'backdrop': return captureBackdrop();
    case 'preview_file': {
      // A few lines of a file the agent is touching (only inside the working folder or attached), for the live step card.
      try {
        let f = String(args[0] || '').trim(); const wd = core.settings.workdir || require('os').homedir(); if (!path.isAbsolute(f)) f = path.join(wd, f);
        const pol = require('./policy'); if (!(pol.inside(f, wd) || core.state.files.includes(f))) return null;
        if (!/\.(js|ts|tsx|jsx|mjs|cjs|py|json|md|txt|html|css|scss|c|cpp|h|cs|java|go|rs|rb|php|sh|ps1|cmd|yml|yaml|toml|xml|sql)$/i.test(f)) return null;
        const st = fs.statSync(f); if (!st.isFile() || st.size > 2e6) return null;
        const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); const first = lines.findIndex(l => l.trim()); const start = Math.max(0, first);
        return { start: start + 1, lines: lines.slice(start, start + 3).map(l => l.slice(0, 70)) };
      } catch { return null; }
    }
    case 'attach_paths': return core.attach(args[0] || []);
    case 'remove_file': return core.removeFile(args[0]);
    case 'open_path': { if (core.isRisky(args[0]) && !args[1]) return false; const err = await shell.openPath(args[0]); if (err) core.system('Could not open: ' + err, true); return true; }
    case 'add_task': return core.state.addTask(args[0]);
    case 'set_task_done': return core.state.setTaskDone(args[0], !!args[1]);
    case 'clear_done_tasks': return core.state.clearDoneTasks();
    // assistant: jobs, workflows, watchers, knowledge, search, voice, quick actions
    case 'jobs_list': return core.assistant.listJobs();
    case 'job_start': return core.assistant.startJob({ ...(args[0] || {}), source: 'manual' });
    case 'job_stop': return core.assistant.stopJob(args[0]);
    case 'jobs_clear': return core.assistant.clearJobs();
    case 'workflows_list': return core.assistant.listWorkflows();
    case 'workflow_templates': return core.assistant.templates();
    case 'workflow_add_template': return core.assistant.addTemplate(args[0]);
    case 'workflow_save': return core.assistant.saveWorkflow(args[0]);
    case 'workflow_remove': return core.assistant.removeWorkflow(args[0]);
    case 'workflow_run': { let vars = args[1] || {}; if (args[2] === 'pick') { const r = await dialog.showOpenDialog(sender, { properties: ['openFile'] }); if (r.canceled) return null; vars = { file: r.filePaths[0] }; } return core.assistant.runWorkflow(args[0], vars); }
    case 'watchers_list': return core.assistant.listWatchers();
    case 'watcher_save': return core.assistant.saveWatcher(args[0]);
    case 'watcher_remove': return core.assistant.removeWatcher(args[0]);
    case 'github_status': return core.assistant.githubStatus();
    case 'github_set': return core.assistant.setGithub(args[0]);
    case 'github_poll': await core.assistant.pollGithub(false); return core.assistant.githubStatus();
    case 'knowledge_status': return core.assistant.knowledgeStatus();
    case 'knowledge_set': return core.assistant.setKnowledge(args[0]);
    case 'knowledge_reindex': core.assistant.rebuildKnowledge(); return core.assistant.knowledgeStatus();
    case 'knowledge_search': return core.assistant.knowledge.search(String(args[0] || ''), 8);
    case 'gchat_unread': return core.assistant.gchatUnread();
    case 'gchat_clear': return core.assistant.gchatClear(args[0]);
    case 'gchat_reply': return core.assistant.gchatReply(String(args[0] || ''), String(args[1] || ''), args[2] || '', args[3]);
    case 'gchat_poll': await core.assistant.pollGchat(); return core.assistant.gchatUnread();
    case 'chat_search': return core.assistant.searchChats(args[0]);
    case 'actions_list': return core.assistant.listActions();
    case 'project_notes_get': return { workdir: core.settings.workdir || '', text: core.settings.workdir ? core.memory.readProjectNotes(core.settings.workdir) : '' };
    case 'project_notes_set': return core.memory.writeProjectNotes(core.settings.workdir || '', args[0]);
    case 'calendar_events': try { return { events: await core.assistant.calendarEvents(args[0] || 24) }; } catch (e) { return { error: e.message }; }
    case 'voice_dictate': return core.assistant.dictate();
    case 'voice_stop': return core.assistant.stopDictation();
    case 'quick_open': return openQuick();
    case 'quick_state': return core.quickSel || { text: '', from: 'none' };
    case 'quick_run': return core.assistant.quick(args[0], (core.quickSel || {}).text || '', args[1]);
    case 'quick_set_text': core.quickSel = { text: String(args[0] || ''), from: 'typed' }; return true;
    case 'quick_stop': return core.assistant.quickStop();
    case 'quick_pin': core.quickPinned = !!args[0]; return core.quickPinned;
    case 'quick_close': if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); return true;
    case 'quick_copy': clipboard.writeText(String(args[0] || '')); return true;
    case 'quick_replace': { const t = String(args[0] || ''); if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); clipboard.writeText(t); await new Promise(r => setTimeout(r, 220)); const { ps, pasteScript } = require('./assistant'); const r = await ps(pasteScript((core.quickSel || {}).hwnd), { timeout: 10000 }); core.assistant.log('quick', 'replace selection', r.ok ? 'pasted' : 'copied only', true); return { pasted: r.ok }; }
    case 'quick_to_chat': { if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); showPanel('chat'); const sel = (core.quickSel || {}).text || ''; core.ev('quick.to_chat', { text: String(args[0] || ''), source: sel }); return true; }
    case 'reminders_list': return core.state.listReminders();
    case 'reminder_add': return core.state.addReminderAt(args[0], args[1], args[2]);
    case 'reminder_remove': return core.state.removeReminder(args[0]);
    case 'schedules_list': return core.state.listSchedules();
    case 'schedule_add': return core.state.addSchedule(args[0]);
    case 'schedule_update': return core.state.updateSchedule(args[0], args[1]);
    case 'schedule_remove': return core.state.removeSchedule(args[0]);
    case 'schedule_run_now': return core.runScheduleNow(args[0]);
    case 'get_settings': return { settings: { ...core.settings }, autostart: app.getLoginItemSettings().openAtLogin, windows: isWin };
    case 'save_settings': {
      const ch = args[0] || {}; const problems = core.applySettings(ch);
      if (!problems.length) { if ('autostart' in ch) app.setLoginItemSettings({ openAtLogin: !!ch.autostart, path: process.execPath }); if (ch.display_mode) setDisplay(ch.display_mode); if (ch.notch_lock && island && core.settings.display_mode === 'notch') island.setBounds(islandBounds('notch')); }
      return problems;
    }
    case 'save_file': { const src = String(args[0] || ''); if (!fs.existsSync(src)) return null; const r = await dialog.showSaveDialog(sender, { defaultPath: path.join(app.getPath('downloads'), path.basename(src)) }); if (r.canceled || !r.filePath) return null; fs.copyFileSync(src, r.filePath); return r.filePath; }
    case 'browse_folder': { const r = await dialog.showOpenDialog(sender, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; }
    case 'connect_status': return core.connectStatus();
    case 'gchat_status': return core.gchatStatus();
    case 'remote_status': return core.remote.status();
    case 'remote_connect': { try { const who = await core.remote.connect(args[0], args[1]); core.system(`${args[0] === 'slack' ? 'Slack' : 'Telegram'} bot connected (${who}). Now send the bot a message from your phone to link your account.`); return { ...core.remote.status(), ok: true, who }; } catch (e) { return { ...core.remote.status(), error: e.message }; } }
    case 'remote_unlink': core.remote.unlink(args[0]); return core.remote.status();
    case 'remote_notify': core.remote.setNotify(!!args[0]); return core.remote.status();
    case 'skin_pick_image': { const r = await dialog.showOpenDialog(sender, { title: 'Pick a skin image (PNG with transparent background works best)', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'svg', 'webp', 'gif', 'jpg', 'jpeg'] }] }); if (r.canceled) return null; try { return core.setCustomSkinImage(r.filePaths[0]); } catch (e) { return { error: e.message }; } }
    case 'memory_get': return core.memory.all();
    case 'memory_set': core.memory.write(args[0], args[1]); return true;
    case 'open_memory_folder': shell.openPath(core.memory.dir); return true;
    case 'skills': return core.skills();
    case 'open_skills_folder': { const d = require('path').join(core.folder, 'skills'); require('fs').mkdirSync(d, { recursive: true }); shell.openPath(d); return true; }
    case 'login_code': return core.login.submitCode(args[0]);
    case 'login_cancel': core.login.cancel(); return true;
    case 'login_status': return core.login.status();
    case 'login_open': { const st = core.login.status(); if (st && st.url) shell.openExternal(st.url); return !!(st && st.url); }
    case 'update_status': return core.updater ? core.updater.status() : null;
    case 'update_check': return core.updater ? core.updater.check(true) : null;
    case 'update_apply': return core.updater ? core.updater.apply(() => { quitting = true; setTimeout(() => app.quit(), 200); }) : false;
    case 'open_url': { const u = String(args[0] || ''); if (/^https:\/\//.test(u)) shell.openExternal(u); return true; }
    case 'gchat_pick_client': {
      const r = await dialog.showOpenDialog(sender, { title: 'Pick the OAuth client file (credentials.json / client_secret_….json)', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled) return core.gchatStatus();
      try { core.gchatSetClient(r.filePaths[0]); return core.gchatStatus(); } catch (e) { return { ...core.gchatStatus(), error: e.message }; }
    }
    case 'gchat_sign_in': { try { return await core.gchatSignIn(url => shell.openExternal(url)); } catch (e) { return { ...core.gchatStatus(), error: e.message }; } }
    case 'gchat_disconnect': return core.gchatDisconnect();
    case 'instructions_text': return core.instructionsText();
    case 'connect': return core.connect(args[0]);
    case 'browse_claude': { const r = await dialog.showOpenDialog(sender, { properties: ['openDirectory'], title: 'Claude: Settings → Developer → Edit Config folder' }); return r.canceled ? null : core.connect('claude_desktop', r.filePaths[0]); }
    case 'hide': return hidePanel();
    case 'show_panel': return showPanel(args[0] || 'chat');
    case 'toggle_panel': return togglePanel(args[0] || 'chat');
    case 'set_display': return setDisplay(args[0]);
    case 'quit': quitting = true; return app.quit();
    case 'uninstall': return uninstall(!!args[0]);
    case 'install_cli': { core.installCli(String(args[0] || '')); return true; }
    case 'cli_status': return core.cli ? core.cli.status() : { tools: [] };
    case 'cli_check': return core.cli ? (core.cli.check().then(() => core.cli.status())) : { tools: [] };
    case 'cli_update': { const n = String(args[0] || ''); if (core.cli && ['claude', 'codex', 'gemini'].includes(n)) core.cli.update(n); return true; }
    case 'cli_auto': { core.state.settings.auto_cli = !!args[0]; core.state.save(); if (args[0] && core.cli) core.cli.run().catch(() => {}); return core.cli ? core.cli.status() : {}; }
    case 'install_cli_window': return core.installCli(args[0]);
    case 'open_session': return require('./handoff').run(core, 'terminal', { shell, clipboard });
    case 'continue_options': return require('./handoff').options(core);
    case 'continue_with': { const r = await require('./handoff').run(core, String(args[0] || ''), { shell, clipboard }); core.assistant.log('continue', args[0] + ' · ' + core.provider.label, r.message, true); return r; }
    case 'open_login': return openLogin(args[0]);
    case 'island_plate_height': lastPlateHeight = args[0]; return;
    case 'island_ignore_mouse': if (island) island.setIgnoreMouseEvents(!!args[0], { forward: true }); return;
    case 'island_move': { if (!island) return; const [dx, dy] = args; const b = island.getBounds(); const { workArea } = core.settings.display_mode === 'pet' ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : screen.getPrimaryDisplay();
      if (core.settings.display_mode === 'pet') { if (core.settings.pet_lock) return; const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - b.width, b.x + dx)); const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - b.height, b.y + dy)); island.setPosition(x, y); }
      else if (!core.settings.notch_lock) island.setPosition(Math.max(0, Math.min(screen.getPrimaryDisplay().bounds.width - b.width, b.x + dx)), b.y); return; }
    case 'island_save_pos': { if (island && core.settings.display_mode === 'pet') { const b = island.getBounds(); core.settings.pet_pos = [b.x, b.y]; core.state.save(); } return; }
    case 'island_focus': if (island) island.focus(); return;
    case 'clipboard_text': return clipboard.readText();
    // Ctrl+V of a screenshot / copied image (or files copied in Explorer) → saved and attached for the AI to look at
    case 'paste_clipboard': {
      const files = [];
      try { if (isWin) { const raw = clipboard.readBuffer('FileNameW'); const p = raw && raw.length ? raw.toString('ucs2').replace(/\0+$/, '').split('\0')[0] : ''; if (p && fs.existsSync(p)) files.push(p); } } catch { /* */ }
      if (!files.length) { const img = clipboard.readImage(); if (img && !img.isEmpty()) { const dir = path.join(core.folder, 'shots'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'paste-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png'); fs.writeFileSync(f, img.toPNG()); files.push(f); } }
      if (files.length) core.attach(files);
      return files;
    }
    case 'context_menu': { const m = Menu.buildFromTemplate([
        { label: 'Open chat' + (isWin ? '\tWin+Shift+B' : ''), click: () => showPanel('chat') }, { label: 'Attach files…', click: pickFiles }, { label: 'Planner', click: () => showPanel('tasks') }, { label: 'Quick action on selection' + (isWin ? '\tCtrl+Shift+Space' : ''), click: () => openQuick() }, { type: 'separator' },
        { label: 'Top of screen (notch)', type: 'radio', checked: core.settings.display_mode === 'notch', click: () => setDisplay('notch') }, { label: 'Floating pet', type: 'radio', checked: core.settings.display_mode === 'pet', click: () => setDisplay('pet') }, { type: 'separator' },
        { label: 'Settings…', click: () => showPanel('settings') }, { label: 'Connect AI apps…', click: () => showPanel('connect') }, { type: 'separator' }, ...(core.settings.display_mode === 'pet' ? [{ label: 'Lock pet', type: 'checkbox', checked: !!core.settings.pet_lock, click: () => core.applySettings({ pet_lock: !core.settings.pet_lock }) }] : [{ label: 'Lock notch', type: 'checkbox', checked: !!core.settings.notch_lock, click: () => core.applySettings({ notch_lock: !core.settings.notch_lock }) }]), { type: 'separator' }, { label: 'Quit Buddy', click: () => { quitting = true; app.quit(); } }]);
      m.popup({ window: sender }); return; }
    default: throw new Error('Unknown API method: ' + method);
  }
});

// ----------------------------------------------------------------- start
app.whenReady().then(async () => {
  app.setAppUserModelId('com.bolt.buddy');
  core = new Core(dataDir());
  core.shell = shell; core.clipboard = clipboard; core.screenshotToFile = () => screenshotToFile().catch(() => ''); core.onHotkeyChange = () => registerQuickHotkey();
  core.on('event', (kind, payload) => { broadcast(kind, payload); if (kind === 'wake') onWake(); if (kind === 'reminder') shell.beep(); if (kind === 'open_url' && payload && /^https?:\/\//.test(payload.url)) shell.openExternal(payload.url); if (kind === 'login' && payload && payload.needsCode && panel && !panel.isDestroyed() && !panel.isVisible() && Date.now() - loginShownAt > 120000) { loginShownAt = Date.now(); showPanel('chat'); } });
  await core.start();
  // auto-update from GitHub Releases (repo set in package.json → buddy.updateRepo)
  { const { Updater } = require('./updater'); const pkg = require('../package.json');
    core.updater = new Updater(core, { repo: (pkg.buddy && pkg.buddy.updateRepo) || '', version: app.getVersion(), appDir: path.join(__dirname, '..'), packaged: app.isPackaged || /resources[\\/]app$/i.test(path.join(__dirname, '..')), exe: process.execPath });
    core.updater.start(); }
  setupSpellcheck();
  createIsland(); createPanel(); createTray(); attachSpellMenu(island); attachSpellMenu(panel);
  // resolution / DPI / monitor changes: put the notch back on top-center and keep the pet on a visible screen
  const refit = () => { try { if (island && !island.isDestroyed()) island.setBounds(islandBounds(core.settings.display_mode)); } catch { /* */ } };
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => setTimeout(refit, 300));
  // Eyes follow the cursor anywhere on screen (cheap: one small IPC at 30 fps, only while the island exists).
  let lastCursor = '';
  setInterval(() => { if (!island || island.isDestroyed()) return; const c = screen.getCursorScreenPoint(); const key = c.x + ',' + c.y; if (key !== lastCursor) { lastCursor = key; island.webContents.send('buddy:event', 'cursor', c); } }, 16);
  // Win+Shift+B (falls back to Ctrl+Shift+B if the OS reserves it)
  for (const acc of ['Super+Shift+X', 'CommandOrControl+Shift+X']) { try { if (globalShortcut.register(acc, () => snipToBuddy())) break; } catch { /* */ } }
  registerQuickHotkey();
  for (const acc of ['Super+Shift+B', 'CommandOrControl+Shift+B']) { try { if (globalShortcut.register(acc, () => togglePanel('chat'))) break; } catch { /* next */ } }
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (core) core.close(); });
app.on('window-all-closed', () => { /* tray app: keep running */ });
