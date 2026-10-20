'use strict';
// GUI-agnostic brain: state + tool server + providers + chat orchestration + MCP connectors.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { State } = require('./state');
const providers = require('./providers');
const { Memory, listSkills, skillPrompt } = require('./memory');
const { Remote } = require('./remote');
const policy = require('./policy');
const { Login, needsLogin } = require('./login');
const { Assistant, pickProvider, PICK_WHY } = require('./assistant');
const { CliTools } = require('./clitools');

const IS_WIN = process.platform === 'win32';
const RISKY = new Set(['.exe', '.bat', '.cmd', '.ps1', '.msi', '.vbs', '.js', '.scr']);
const HELP = 'Commands\n/task Buy milk — add a task\n/remind 10m Stretch — reminder (s, m, h, d) · Planner tab: reminders with repeat + scheduled AI tasks\n/bg task — run it in the background (Planner → Activity) · /bg do task lets it edit\n/files — list attached files\n/skills — your skills; /<skill> task… runs one (Do mode)\n/remember <fact> — save to memory · /rule <rule> — standing rule · /memory — show it\n/gemini · /codex · /claude — switch AI\n/clear — forget the conversation\nDrop files on Buddy or the chat to attach them.';
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

// ------------------------------------------------------------ tool server
class ToolServer {
  constructor(state, folder) {
    this.state = state; this.folder = folder;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.file = path.join(folder, 'connection.json');
    this.server = http.createServer((req, res) => this.handle(req, res));
  }
  reply(res, status, payload) { const body = JSON.stringify(payload); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }
  handle(req, res) {
    if (req.method === 'GET' && req.url === '/health') return this.reply(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/tool') return this.reply(res, 404, { error: 'Not found' });
    const auth = req.headers.authorization || '';
    const expect = 'Bearer ' + this.token;
    if (auth.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expect))) return this.reply(res, 401, { error: 'Unauthorized' });
    let body = '';
    req.on('data', d => { body += d; if (body.length > 65536) { this.reply(res, 413, { error: 'Invalid request size' }); req.destroy(); } });
    req.on('end', async () => {
      try {
        const r = JSON.parse(body || '{}'); const name = String(r.name || ''); const args = r.arguments || {};
        const ext = this.ext ? await this.ext(name, args) : undefined;
        const result = ext !== undefined ? ext : this.handler && name === 'buddy_permission' ? await this.handler(args) : this.state.execute(name, args);
        this.reply(res, 200, { result });
      } catch (e) { this.reply(res, 200, { error: e.message }); }
    });
  }
  start() { return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; fs.writeFileSync(this.file, JSON.stringify({ port: this.port, token: this.token })); resolve(this.port); })); }
  close() { try { this.server.close(); } catch { /* */ } try { if (JSON.parse(fs.readFileSync(this.file, 'utf8')).token === this.token) fs.unlinkSync(this.file); } catch { /* */ } }
}

// --------------------------------------------------------------- connect
const BUDDY_INSTRUCTIONS = "## Buddy\nBuddy (local desktop companion) is connected via MCP. For every user task: call buddy_status(state='working', message=<what you are doing>) when you start, buddy_step(tool, detail) for each file you read/edit and command you run, buddy_status(state='waiting') when you need the user, and buddy_status(state='done'|'error', message=<one-line summary>) when finished. Use buddy_files/buddy_read_file for files the user attached in Buddy. Report only real activity.\nMemory: at the start of a task call buddy_memory once — it returns the user's profile, projects and notes; follow the rules in it. When you learn something durable (a decision, a preference, a project fact) call buddy_remember(text) with one short line.";
const INSTR_START = '<!-- buddy:start -->', INSTR_END = '<!-- buddy:end -->';
function plantInstructions(file) {
  // Idempotent: replaces an existing Buddy block, otherwise appends one.
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${INSTR_START}\n${BUDDY_INSTRUCTIONS}\n${INSTR_END}`;
  const re = new RegExp(INSTR_START.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '[\\s\\S]*?' + INSTR_END.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'));
  if (re.test(text)) { const next = text.replace(re, block); if (next === text) return false; text = next; }
  else text = (text.replace(/\s+$/, '') + (text.trim() ? '\n\n' : '') + block + '\n');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return true;
}
function plantCodex() { return plantInstructions(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'AGENTS.md')); }
function plantClaudeCode() { return plantInstructions(path.join(os.homedir(), '.claude', 'CLAUDE.md')); }
function geminiDir() { return process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini'); }
function plantGemini() { return plantInstructions(path.join(geminiDir(), 'GEMINI.md')); }
function connectGemini(dataDir) {
  // Gemini CLI reads MCP servers from ~/.gemini/settings.json and context from ~/.gemini/GEMINI.md.
  const p = path.join(geminiDir(), 'settings.json'); let cfg; try { cfg = readJson(p); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}).`); }
  cfg.mcpServers = cfg.mcpServers || {}; const e = entry(dataDir, 'gemini'); const cur = cfg.mcpServers.buddy;
  if (cur && !owned(cur)) throw new Error("Another MCP server already uses the name 'buddy' in Gemini CLI. Rename it first.");
  if (JSON.stringify(cur) === JSON.stringify(e)) { plantGemini(); return 'Gemini CLI is already connected.'; }
  cfg.mcpServers.buddy = e; const b = backup(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); plantGemini();
  return 'Gemini CLI connected (+ Buddy instructions in ~/.gemini/GEMINI.md). Start a new `gemini` session to load Buddy tools.' + (b ? '\nBackup: ' + b : '');
}
// Antigravity CLI reads MCP servers from ~/.gemini/config/mcp_config.json (same "mcpServers" shape)
function connectAgy(dataDir) {
  const p = path.join(geminiDir(), 'config', 'mcp_config.json'); let cfg = {}; try { cfg = readJson(p); } catch { return 'skipped (mcp_config.json is not valid JSON)'; }
  cfg.mcpServers = cfg.mcpServers || {}; const cur = cfg.mcpServers.buddy; if (cur && !owned(cur)) return 'skipped (name taken)';
  try { installAgyHooks(dataDir); } catch { /* optional */ }
  const e = entry(dataDir, 'gemini'); if (JSON.stringify(cur) === JSON.stringify(e)) { providers.agyAllow(); return 'already connected'; }
  cfg.mcpServers.buddy = e; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); providers.agyAllow(); return 'connected';
}
// ------------------------------------------------------------ approval hooks (Codex + Antigravity → Buddy toast)
// A tiny wrapper script runs Buddy's hook (bridge/buddy-hook.js) with Buddy's own runtime. On Windows it lives in a folder
// without spaces (C:\ProgramData\Buddy\hooks) so every shell the CLIs might use can start it without quoting tricks.
function hookWrapper(dataDir) {
  const script = path.join(__dirname, 'bridge', 'buddy-hook.js'); const tag = crypto.createHash('sha1').update(os.userInfo().username + dataDir).digest('hex').slice(0, 8);
  if (IS_WIN) {
    let dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Buddy', 'hooks'); try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = dataDir; }
    if (/\s/.test(dir)) dir = dataDir;
    const f = path.join(dir, `buddy-hook-${tag}.cmd`);
    fs.writeFileSync(f, ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `set "BUDDY_DATA_DIR=${dataDir}"`, `"${process.execPath}" "${script}" %*`, ''].join('\r\n'));
    return { codexPre: f + ' codex-pre', codexPerm: f + ' codex-perm', agyPre: f + ' agy-pre', file: f };
  }
  fs.mkdirSync(dataDir, { recursive: true }); const f = path.join(dataDir, `buddy-hook-${tag}.sh`);
  fs.writeFileSync(f, ['#!/bin/sh', 'export ELECTRON_RUN_AS_NODE=1', `export BUDDY_DATA_DIR='${dataDir.replace(/'/g, "'\\''")}'`, `exec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"`, ''].join('\n')); fs.chmodSync(f, 0o755);
  const q = `'${f.replace(/'/g, "'\\''")}'`;
  return { codexPre: q + ' codex-pre', codexPerm: q + ' codex-perm', agyPre: q + ' agy-pre', file: f };
}
const isBuddyHook = h => /buddy-hook/.test(String((h && (h.command || h.commandWindows)) || ''));
function installCodexHooks(dataDir) {
  const p = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'); let cfg = {};
  try { const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); if (raw.trim()) cfg = JSON.parse(raw); } catch (e) { if (e.code !== 'ENOENT') return 'skipped (hooks.json is not valid JSON)'; }
  const w = hookWrapper(dataDir); cfg.hooks = cfg.hooks || {};
  const add = (ev, cmd) => { const groups = (cfg.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isBuddyHook(h)) })).filter(g => g.hooks.length); groups.push({ matcher: '.*', hooks: [{ type: 'command', command: cmd, commandWindows: cmd, timeout: 660, statusMessage: 'Waiting for your OK in Buddy…' }] }); cfg.hooks[ev] = groups; };
  add('PreToolUse', w.codexPre); add('PermissionRequest', w.codexPerm);
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); return 'hooks installed';
}
function installAgyHooks(dataDir) {
  const p = path.join(geminiDir(), 'config', 'hooks.json'); let cfg = {};
  try { const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); if (raw.trim()) cfg = JSON.parse(raw); } catch (e) { if (e.code !== 'ENOENT') return 'skipped (hooks.json is not valid JSON)'; }
  const w = hookWrapper(dataDir);
  cfg['buddy-approvals'] = { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: w.agyPre, timeout: 660 }] }] };
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); return 'hooks installed';
}
function bridgeCommand(dataDir) {
  // The MCP bridge is Buddy itself started as plain Node: no Node.js install needed on the machine.
  // ELECTRON_RUN_AS_NODE makes Buddy.exe behave like plain `node`, so the bridge script runs with zero deps.
  return { command: process.execPath, args: [path.join(__dirname, 'bridge', 'buddy-mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1', BUDDY_DATA_DIR: dataDir, BUDDY_AGENT: '' } };
}
function entry(dataDir, agent) { const c = bridgeCommand(dataDir); return { command: c.command, args: c.args, env: { ...c.env, BUDDY_AGENT: agent } }; }
function owned(e) { if (!e || typeof e !== 'object') return false; const j = [e.command, ...(e.args || [])].join(' ').toLowerCase(); return /buddy|mcp_bridge\.py/.test(j) || !!(e.env && e.env.BUDDY_DATA_DIR); }
function backup(p) { if (!fs.existsSync(p)) return null; const b = p + '.buddy-backup-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); fs.copyFileSync(p, b); return path.basename(b); }
function claudeDesktopCandidates() {
  const home = os.homedir(); const out = [];
  if (IS_WIN) {
    out.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'));
    try { const pk = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages'); for (const d of fs.readdirSync(pk)) if (d.startsWith('Claude')) out.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')); } catch { /* */ }
  } else if (process.platform === 'darwin') out.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  else out.push(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  return out;
}
function claudeDesktopConfig(dataDir, explicit) {
  const override = path.join(dataDir, 'claude-location.txt');
  if (explicit) { let p = explicit; try { if (fs.statSync(p).isDirectory()) p = path.join(p, 'claude_desktop_config.json'); } catch { /* */ } fs.writeFileSync(override, p); return p; }
  try { const saved = fs.readFileSync(override, 'utf8').trim(); if (saved && fs.existsSync(path.dirname(saved))) return saved; } catch { /* */ }
  const c = claudeDesktopCandidates();
  return c.find(p => fs.existsSync(p)) || c.find(p => fs.existsSync(path.dirname(p))) || (() => { throw new Error('Claude Desktop config folder not found. In Claude: Settings → Developer → Edit Config, then use Browse… in Buddy to pick that folder.'); })();
}
function readJson(p) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '') || '{}') : {}; }
function connectClaudeDesktop(dataDir, explicit) {
  const p = claudeDesktopConfig(dataDir, explicit); let cfg; try { cfg = readJson(p); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix it in Claude first.`); }
  cfg.mcpServers = cfg.mcpServers || {};
  const e = entry(dataDir, 'claude'); const cur = cfg.mcpServers.buddy;
  if (cur && !owned(cur)) throw new Error("Another MCP server already uses the name 'buddy'. Rename it in Claude first.");
  if (JSON.stringify(cur) === JSON.stringify(e)) return 'Claude Desktop is already connected. Fully quit and reopen Claude if tools are missing.';
  cfg.mcpServers.buddy = e; const b = backup(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return 'Claude Desktop connected. Fully quit and reopen Claude Desktop.' + (b ? '\nBackup: ' + b : '');
}
function connectClaudeCode(dataDir) {
  const e = entry(dataDir, 'claude'); const exe = providers.Claude.executable(); let note = '';
  if (exe) {
    const opts = { windowsHide: true, timeout: 60000, encoding: 'utf8' };
    providers.spawnSyncCompat(exe, ['mcp', 'remove', '-s', 'user', 'buddy'], opts);
    const args = ['mcp', 'add', '-s', 'user']; for (const [k, v] of Object.entries(e.env)) args.push('-e', `${k}=${v}`); args.push('buddy', '--', e.command, ...e.args);
    const r = providers.spawnSyncCompat(exe, args, opts);
    if (r.status === 0) { plantClaudeCode(); return 'Claude Code connected (+ Buddy instructions in ~/.claude/CLAUDE.md). Start a new `claude` session to load Buddy tools.'; }
    note = ` (CLI said: ${String(r.stderr || r.stdout || '').trim().slice(-300)})`;
  }
  const p = path.join(os.homedir(), '.claude.json'); let cfg; try { cfg = readJson(p); } catch (err) { throw new Error(`${p} is not valid JSON (${err.message}).${note}`); }
  cfg.mcpServers = cfg.mcpServers || {}; const cur = cfg.mcpServers.buddy;
  if (cur && !owned(cur)) throw new Error("Another MCP server already uses the name 'buddy' in Claude Code. Rename it first.");
  if (JSON.stringify(cur) === JSON.stringify(e)) { plantClaudeCode(); return 'Claude Code is already connected. Start a new `claude` session if tools are missing.'; }
  cfg.mcpServers.buddy = e; const b = backup(p); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); plantClaudeCode();
  return 'Claude Code connected via ~/.claude.json. Start a new `claude` session.' + (b ? '\nBackup: ' + b : '') + note;
}
function codexConfig() { return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'); }
function tomlStr(v) { return JSON.stringify(v); }
function stripBuddy(text, name = 'buddy') { let skip = false; const re = new RegExp('^\\[mcp_servers\\.' + name + '(\\.[^\\]]+)?\\]\\s*$'); return text.split(/\r?\n/).filter(l => { if (/^\[[^\]]+\]\s*$/.test(l)) skip = re.test(l); return !skip; }).join('\n'); }
function parseBuddyToml(text, name = 'buddy') {
  // Minimal: find [mcp_servers.<name>] command/args/env values (enough to detect ownership/equality).
  const m = text.match(new RegExp('^\\[mcp_servers\\.' + name + '\\]\\s*$([\\s\\S]*?)(?=^\\[|\\s*$(?![\\s\\S]))', 'm'));
  if (!m) return null;
  const block = m[1]; const cmd = (block.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m) || [])[1];
  const argsRaw = (block.match(/^args\s*=\s*\[([^\]]*)\]/m) || [])[1] || '';
  const args = [...argsRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => JSON.parse('"' + x[1] + '"'));
  const envm = text.match(new RegExp('^\\[mcp_servers\\.' + name + '\\.env\\]\\s*$([\\s\\S]*?)(?=^\\[|\\s*$(?![\\s\\S]))', 'm')); const env = {};
  if (envm) for (const [, k, v] of envm[1].matchAll(/^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) env[k] = JSON.parse('"' + v + '"');
  return { command: cmd ? JSON.parse('"' + cmd + '"') : '', args, env };
}
function connectCodex(dataDir) {
  try { installCodexHooks(dataDir); } catch { /* optional */ }
  const p = codexConfig(); const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const e = entry(dataDir, 'codex'); const cur = parseBuddyToml(text);
  if (cur && !owned(cur)) throw new Error("Another MCP server already uses the name 'buddy' in Codex. Rename it first.");
  // codex exec cannot ask for approvals: without this every Buddy tool call (status, memory…) is auto-rejected
  const blk = text.match(/^\[mcp_servers\.buddy\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m); const approved = !!(blk && /^default_tools_approval_mode\s*=\s*"approve"/m.test(blk[1]));
  if (cur && approved && JSON.stringify(cur) === JSON.stringify(e)) { plantCodex(); return 'Codex is already connected. Restart Codex or start a new chat if tools are missing.'; }
  const block = [`[mcp_servers.buddy]`, `command = ${tomlStr(e.command)}`, `args = [${e.args.map(tomlStr).join(', ')}]`, 'default_tools_approval_mode = "approve"', '', `[mcp_servers.buddy.env]`, ...Object.entries(e.env).map(([k, v]) => `${k} = ${tomlStr(v)}`)].join('\n') + '\n';
  const cleaned = stripBuddy(text).replace(/\s+$/, '');
  const b = backup(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, (cleaned ? cleaned + '\n\n' : '') + block);
  plantCodex();
  return 'Codex connected (+ Buddy instructions in ~/.codex/AGENTS.md). Restart Codex (app or CLI) to load Buddy tools.' + (b ? '\nBackup: ' + b : '');
}
// ------------------------------------------------------------ google chat
const GCHAT_NAME = 'google-chat';
function gchatEntry(dataDir) { return { command: process.execPath, args: [path.join(__dirname, 'bridge', 'google-chat-mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1', BUDDY_DATA_DIR: dataDir } }; }
function gchatTokenFile(dataDir) { return path.join(dataDir, 'google-chat.json'); }
function gchatSignedIn(dataDir) { try { const t = JSON.parse(fs.readFileSync(gchatTokenFile(dataDir), 'utf8')); return t.refresh_token ? (t.email || 'signed in') : ''; } catch { return ''; } }
function registerGoogleChat(dataDir, remove = false) {
  // Registers (or removes) Buddy's Google Chat MCP server in Claude Code, Claude Desktop and Codex. Returns per-app notes.
  const e = gchatEntry(dataDir); const notes = [];
  // Claude Code
  try {
    const exe = providers.Claude.executable(); let ok = false;
    if (exe) {
      const opts = { windowsHide: true, timeout: 60000, encoding: 'utf8' };
      providers.spawnSyncCompat(exe, ['mcp', 'remove', '-s', 'user', GCHAT_NAME], opts);
      if (!remove) { const args = ['mcp', 'add', '-s', 'user']; for (const [k, v] of Object.entries(e.env)) args.push('-e', `${k}=${v}`); args.push(GCHAT_NAME, '--', e.command, ...e.args); ok = providers.spawnSyncCompat(exe, args, opts).status === 0; }
      else ok = true;
    }
    if (!ok) { const p = path.join(os.homedir(), '.claude.json'); const cfg = readJson(p); cfg.mcpServers = cfg.mcpServers || {}; if (remove) delete cfg.mcpServers[GCHAT_NAME]; else cfg.mcpServers[GCHAT_NAME] = e; fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); }
    notes.push('Claude Code');
  } catch (err) { notes.push('Claude Code failed: ' + err.message); }
  // Claude Desktop
  try { const p = claudeDesktopConfig(dataDir); const cfg = readJson(p); cfg.mcpServers = cfg.mcpServers || {}; if (remove) delete cfg.mcpServers[GCHAT_NAME]; else cfg.mcpServers[GCHAT_NAME] = e; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); notes.push('Claude Desktop'); } catch { /* not installed */ }
  // Gemini CLI
  try { const p = path.join(geminiDir(), 'settings.json'); if (fs.existsSync(path.dirname(p))) { const cfg = readJson(p); cfg.mcpServers = cfg.mcpServers || {}; if (remove) delete cfg.mcpServers[GCHAT_NAME]; else cfg.mcpServers[GCHAT_NAME] = e; fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); notes.push('Gemini CLI'); } } catch { /* */ }
  // Codex
  try {
    const p = codexConfig(); if (fs.existsSync(path.dirname(p))) {
      const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; const cleaned = stripBuddy(text, GCHAT_NAME).replace(/\s+$/, '');
      const block = remove ? '' : [`[mcp_servers.${GCHAT_NAME}]`, `command = ${tomlStr(e.command)}`, `args = [${e.args.map(tomlStr).join(', ')}]`, '', `[mcp_servers.${GCHAT_NAME}.env]`, ...Object.entries(e.env).map(([k, v]) => `${k} = ${tomlStr(v)}`)].join('\n') + '\n';
      fs.writeFileSync(p, (cleaned ? cleaned + (block ? '\n\n' : '\n') : '') + block); notes.push('Codex');
    }
  } catch (err) { notes.push('Codex failed: ' + err.message); }
  return notes;
}
function gchatStatus(dataDir) {
  const e = gchatEntry(dataDir); const same = cur => !!cur && JSON.stringify(cur) === JSON.stringify(e);
  const apps = {};
  try { apps.claude_code = same((readJson(path.join(os.homedir(), '.claude.json')).mcpServers || {})[GCHAT_NAME]); } catch { apps.claude_code = false; }
  try { apps.claude_desktop = same((readJson(claudeDesktopConfig(dataDir)).mcpServers || {})[GCHAT_NAME]); } catch { apps.claude_desktop = false; }
  try { const p = codexConfig(); apps.codex = same(parseBuddyToml(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '', GCHAT_NAME)); } catch { apps.codex = false; }
  const hasClient = fs.existsSync(path.join(dataDir, 'google-client.json'));
  let rescope = false; try { const t = readJson(path.join(dataDir, 'google-chat.json')); rescope = Array.isArray(t.scopes) ? !t.scopes.some(s => /calendar/.test(s)) : true; } catch { /* not signed in */ }
  return { account: gchatSignedIn(dataDir), client: hasClient, apps, rescope };
}

function connectStatus(dataDir) {
  const check = (cur, e) => !cur ? 'not_configured' : !owned(cur) ? 'other' : (cur.env && cur.env.BUDDY_DATA_DIR === e.env.BUDDY_DATA_DIR ? 'configured' : 'other_install');
  const out = {}; const ec = entry(dataDir, 'claude'), ex = entry(dataDir, 'codex');
  try { const p = claudeDesktopConfig(dataDir); out.claude_desktop = check((readJson(p).mcpServers || {}).buddy, ec); } catch { out.claude_desktop = 'missing'; }
  try { const p = path.join(os.homedir(), '.claude.json'); out.claude_code = (providers.Claude.executable() || fs.existsSync(p)) ? check((readJson(p).mcpServers || {}).buddy, ec) : 'missing'; } catch { out.claude_code = 'missing'; }
  try { const p = codexConfig(); out.codex = fs.existsSync(path.dirname(p)) ? check(parseBuddyToml(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''), ex) : 'missing'; } catch { out.codex = 'missing'; }
  try { const p = path.join(geminiDir(), 'settings.json'); out.gemini = (providers.Gemini.executable() || fs.existsSync(path.dirname(p))) ? check((readJson(p).mcpServers || {}).buddy, entry(dataDir, 'gemini')) : 'missing'; } catch { out.gemini = 'missing'; }
  return out;
}

// ------------------------------------------------------------------ core
class Core extends EventEmitter {
  constructor(folder) {
    super();
    this.folder = folder;
    this.state = new State(folder);
    this.memory = new Memory(folder); this.state.memory = this.memory;
    this.server = new ToolServer(this.state, folder);
    this.server.handler = args => this.askPermission(args);
    this.pendingPerms = new Map(); this.permSeq = 0;
    this.provider = providers.make(this.state.settings.provider);
    this.chatBusy = false; this.models = []; this.providerOk = null; this.providerDetail = ''; this.closing = false;
    this.state.on('files', p => this.emit('event', 'files', p));
    this.state.on('tasks', p => this.emit('event', 'tasks', p));
    this.state.on('reminders', p => this.emit('event', 'reminders', p));
    this.state.on('schedules', p => this.emit('event', 'schedules', p));
    this.state.on('agent', p => this.emit('event', 'agent', p));
    this.state.on('step', p => this.emit('event', 'step', p));
    this.state.on('say', p => this.emit('event', 'say', p));
    this.state.on('memory', () => this.emit('event', 'memory', {}));
    this.remote = new Remote(this);
    this.assistant = new Assistant(this); this.server.ext = (n, a) => this.assistant.tool(n, a);
    this.login = new Login(this);
  }
  async start() {
    await this.server.start();
    this.scheduleQueue = [];
    try { this.assistant.start(); } catch (e) { console.error('assistant start', e); }
    this.timer = setInterval(() => this.tick(), 1000);
    this.checkProvider();
    setTimeout(() => this.autoConnect(), 1500);
    setTimeout(() => this.remote.start(), 2500);
    this.cliPaths();
    this.cli = this.cli || new CliTools(this);
    setTimeout(() => this.cliSetup().catch(() => {}), Number(process.env.BUDDY_CLI_FIRST_MS) || 20000);
    this.cli.start();
  }
  tick() {
    for (const r of this.state.dueReminders()) {
      this.ev('reminder', { message: r.message, id: r.id, repeat: r.repeat || '' });
      try { if (this.remote && this.remote.cfg.notify !== false) this.remote.notifyOwner('⏰ Reminder: ' + r.message); } catch { /* */ }
    }
    for (const s of this.state.dueSchedules()) this.scheduleQueue.push(s);
    // one scheduled task at a time, and never on top of something the user is doing right now
    for (let i = this.scheduleQueue.length - 1; i >= 0; i--) { const s = this.scheduleQueue[i]; if (s.workflow || s.background) { this.scheduleQueue.splice(i, 1); this.runSchedule(s); } }
    if (this.scheduleQueue.length && !this.chatBusy && !this.runningSchedule) this.runSchedule(this.scheduleQueue.shift());
  }
  runSchedule(s) {
    if (!s) return false;
    if (this.chatBusy && !s.workflow && !s.background) { this.scheduleQueue.push(s); return false; }
    if (s.workflow) { try { this.assistant.runWorkflow(s.workflow, {}, 'schedule'); this.state.markScheduleRun(s.id, true, 'Workflow started — see Planner → Activity'); } catch (e) { this.state.markScheduleRun(s.id, false, e.message); } return true; }
    if (s.background) { try { this.assistant.startJob({ title: s.title, prompt: s.prompt, mode: s.mode, provider: s.provider, source: 'schedule' }); this.state.markScheduleRun(s.id, true, 'Started in the background — see Planner → Activity'); } catch (e) { this.state.markScheduleRun(s.id, false, e.message); } return true; }
    if (s.provider && s.provider !== this.provider.name && providers.PROVIDERS[s.provider]) this.setProvider(s.provider);
    this.runningSchedule = s;
    this.ev('say', { agent: '', text: 'Running scheduled task: ' + s.title, reaction: 'waiting' });
    this.submit(s.prompt, s.mode === 'do', { raw: true, display: '⏰ Scheduled · ' + s.title + (s.prompt !== s.title ? '\n' + s.prompt : '') });
    if (!this.chatBusy) { this.runningSchedule = null; this.state.markScheduleRun(s.id, false, 'Could not start'); return false; }
    return true;
  }
  runScheduleNow(sid) { const s = this.state.schedules.find(x => x.id === sid); if (!s) throw new Error('Unknown schedule.'); if (this.chatBusy) { this.scheduleQueue.push({ ...s }); return { queued: true }; } return { started: this.runSchedule({ ...s }) }; }
  scheduleFinished(ok, text) {
    const s = this.runningSchedule; if (!s) return; this.runningSchedule = null;
    const first = String(text || '').trim().split('\n').find(l => l.trim()) || (ok ? 'Done' : 'Failed');
    this.state.markScheduleRun(s.id, ok, first);
    try { if (this.remote && this.remote.cfg.notify !== false) this.remote.notifyOwner((ok ? '✅ Scheduled task done: ' : '⚠️ Scheduled task failed: ') + s.title + '\n' + String(text || '').trim().slice(0, 1500)); } catch { /* */ }
  }
  autoConnect() {
    // Connect every AI app that is installed but not yet wired to this Buddy. Idempotent and silent on no-ops.
    const st = this.connectStatus(); const done = [], failed = [];
    const want = k => st[k] === 'not_configured' || st[k] === 'other_install';
    try { if (want('claude_desktop')) { connectClaudeDesktop(this.folder); done.push('Claude Desktop'); } } catch (e) { failed.push('Claude Desktop: ' + e.message); }
    try { if (want('claude_code')) { connectClaudeCode(this.folder); done.push('Claude Code'); } else if (st.claude_code === 'configured') plantClaudeCode(); } catch (e) { failed.push('Claude Code: ' + e.message); }
    try { if (want('codex')) { connectCodex(this.folder); done.push('Codex'); } else if (st.codex === 'configured') connectCodex(this.folder); /* idempotent; adds tool auto-approval to older setups */ } catch (e) { failed.push('Codex: ' + e.message); }
    try { if (want('gemini')) { connectGemini(this.folder); done.push('Gemini CLI'); } else if (st.gemini === 'configured') plantGemini(); } catch (e) { failed.push('Gemini: ' + e.message); }
    try { if (providers.Gemini.agyPath()) connectAgy(this.folder); } catch { /* optional */ }
    if (done.length) this.system(`Connected automatically: ${done.join(', ')}. Restart that app (or start a new chat) once so it loads the Buddy tools.`);
    for (const f of failed) this.system(f, true);
  }
  close() { if (this.closing) return; this.closing = true; clearInterval(this.timer); try { this.cli && this.cli.stop(); } catch { /* */ } try { this.assistant.stop(); } catch { /* */ } try { this.remote.stopAll(); } catch { /* */ } try { this.provider.cancel(); } catch { /* */ } this.state.save(); this.server.close(); }
  ev(kind, payload = {}) { this.emit('event', kind, payload); }

  // permission prompts (Claude Code --permission-prompt-tool) --------------
  get alwaysAllowed() { const a = this.state.settings.always_allow; return Array.isArray(a) ? a : []; }
  askPermission(args) {
    const tool = String(args.tool_name || '').trim() || 'tool'; const input = args.input && typeof args.input === 'object' ? args.input : {};
    const verdict = input.__approval ? { kind: 'approve', category: 'action', title: String(input.title || 'Allow this action?'), target: String(input.detail || '').slice(0, 300), reason: String(input.reason || '') } : policy.classify(tool, input, { workdir: this.state.settings.workdir || os.homedir(), dataDir: this.folder });
    if (verdict.kind === 'auto') return { behavior: 'allow', updatedInput: input };
    // the same action accepted a moment ago (Codex asks again when its sandbox needs the escalation) → don't show a 2nd toast
    const key = tool + '|' + JSON.stringify(input); this.recentAccepts = this.recentAccepts || new Map();
    // (only that hand-off: Codex fires PreToolUse first, then PermissionRequest for the same call. Everything else stays one-time.)
    if (args.source === 'codex-perm' && Date.now() - (this.recentAccepts.get(key) || 0) < 120000) { this.recentAccepts.delete(key); return { behavior: 'allow', updatedInput: input }; }
    const id = 'p' + (++this.permSeq); const nice = input.__approval ? String(input.nice || 'Buddy') : tool.replace(/^mcp__/, '').replace(/__/g, ' · ');
    return new Promise(resolve => {
      const finish = behavior => {
        const p = this.pendingPerms.get(id); if (!p) return; clearTimeout(p.timer); this.pendingPerms.delete(id);
        this.ev('permission.done', { id, behavior });
        if (this.chatBusy) this.state.setAgentState(this.provider.name, 'working', behavior === 'allow' ? 'Accepted — continuing' : 'Rejected — continuing', '', 'chat');
        if (behavior === 'allow' && args.source === 'codex-pre') this.recentAccepts.set(key, Date.now());
        resolve(behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `The user rejected this action in Buddy (${verdict.title}). Do not retry it; continue without it or ask what to do instead.` });
      };
      const timer = setTimeout(() => finish('deny'), 10 * 60 * 1000); // timeout = reject, never an approval
      const payload = { id, tool, nice, category: verdict.category, title: verdict.title, detail: verdict.target, target: verdict.target, reason: verdict.reason };
      this.pendingPerms.set(id, { finish, timer, payload });
      this.ev('permission', payload);
      this.state.setAgentState(this.provider.name, 'waiting', verdict.title + ' — accept?', '', 'chat');
    });
  }
  // Re-show every pending approval card (used when the user types "ok/haan/kar do" instead of clicking)
  reshowPending() { for (const [, p] of this.pendingPerms) this.ev('permission', { ...p.payload, reshow: true }); return this.pendingPerms.size; }
  permissionReply(id, answer) {
    // Only an explicit Accept/Reject from a UI control resolves an action, and only that one action, once.
    const p = this.pendingPerms.get(String(id)); if (!p) return false;
    p.finish(answer === 'allow' || answer === 'accept' ? 'allow' : 'deny');
    return true;
  }
  forgetAlways() { this.state.settings.always_allow = []; this.state.save(); }
  setCustomSkinImage(src) {
    const ext = (path.extname(src) || '.png').toLowerCase(); if (!['.png', '.svg', '.webp', '.gif', '.jpg', '.jpeg'].includes(ext)) throw new Error('Use a PNG, SVG, WebP or JPG image (PNG with transparent background works best).');
    const dir = path.join(this.folder, 'skins'); fs.mkdirSync(dir, { recursive: true }); const dest = path.join(dir, 'custom' + ext);
    for (const f of fs.readdirSync(dir)) if (/^custom\./.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* */ } }
    fs.copyFileSync(src, dest); const cur = this.state.settings.custom_skin || {};
    this.state.settings.custom_skin = { path: dest, box: cur.box || [25, 38, 50, 34], ink: cur.ink || 'dark', v: (cur.v || 0) + 1 }; this.state.settings.skin = 'custom'; this.state.save();
    this.ev('settings', { settings: { ...this.state.settings } }); return this.state.settings.custom_skin;
  }
  mcpConfigFile() {
    // Buddy's own bridge for chat sessions, so Claude Code can route permission prompts back to Buddy (+ Google Chat when signed in).
    try { const servers = { buddy: entry(this.folder, 'claude') }; if (gchatSignedIn(this.folder)) servers[GCHAT_NAME] = gchatEntry(this.folder); const f = path.join(this.folder, 'mcp-chat.json'); fs.writeFileSync(f, JSON.stringify({ mcpServers: servers })); return f; } catch { return ''; }
  }

  // google chat ------------------------------------------------------------
  gchatStatus() { return gchatStatus(this.folder); }
  gchatSetClient(file) {
    const oauth = require('./bridge/google-oauth'); const c = oauth.readClient(file);
    fs.writeFileSync(path.join(this.folder, 'google-client.json'), JSON.stringify(c, null, 2)); return true;
  }
  async gchatSignIn(open) {
    const oauth = require('./bridge/google-oauth'); const cf = path.join(this.folder, 'google-client.json');
    if (!fs.existsSync(cf)) throw new Error('Pick your credentials.json first (step 1).');
    const client = JSON.parse(fs.readFileSync(cf, 'utf8'));
    const tok = await oauth.signIn(client, open);
    fs.writeFileSync(gchatTokenFile(this.folder), JSON.stringify(tok, null, 2));
    const notes = registerGoogleChat(this.folder);
    this.system(`Google Chat connected as ${tok.email || 'your account'} → ${notes.join(', ')}. Restart Claude Desktop / Codex once; Buddy's own chat has it right away.`);
    return this.gchatStatus();
  }
  gchatDisconnect() {
    for (const f of [gchatTokenFile(this.folder), path.join(this.folder, 'google-client.json')]) { try { fs.unlinkSync(f); } catch { /* */ } }
    registerGoogleChat(this.folder, true); this.system('Google Chat disconnected.'); return this.gchatStatus();
  }
  denyPending() { for (const [, p] of [...this.pendingPerms]) p.finish('deny', false); }
  system(text, error = false) { this.ev('chat.system', { text, error }); }
  // browser-only sign-in for Claude/Codex/Gemini (no terminal windows)
  signIn(which, auto = false) { return this.login.start(which, auto); }
  openUrl(url) { if (/^https?:\/\//.test(String(url))) this.ev('open_url', { url: String(url) }); }

  get settings() { return this.state.settings; }
  get assistantName() { return this.state.settings.assistant_name; }
  get bossName() { return this.state.settings.boss_name; }
  get agentMode() { return !!this.state.settings.agent_mode; }
  providerInfo(checking = false) {
    return { name: this.provider.name, label: this.provider.label, accent: this.provider.accent, detail: this.providerDetail, ok: this.providerOk, checking, all: providers.ALL };
  }
  snapshot(version) {
    return { version, settings: { ...this.state.settings }, provider: this.providerInfo(), chat: this.state.chat.filter(m => m.provider === this.provider.name).slice(-120), files: [...this.state.files], tasks: [...this.state.tasks], reminders: this.state.listReminders(), schedules: this.state.listSchedules(), jobs: this.assistant.listJobs(), workflows: this.assistant.listWorkflows(), busy: this.chatBusy,
      agents: Object.fromEntries(['claude', 'codex', 'gemini'].map(a => [a, this.state.agentActivity(a)])), linked: Object.fromEntries(['claude', 'codex', 'gemini'].map(a => [a, this.state.agentLinked(a)])), windows: IS_WIN, agent_mode: this.agentMode, skills: this.skills().map(k => ({ name: k.name, description: k.description, source: k.source })) };
  }
  skills() { try { return listSkills(this.folder); } catch { return []; } }
  island() {
    return { headline: this.state.headline(), feeds: Object.fromEntries(['claude', 'codex', 'gemini'].map(a => [a, this.state.agentActivity(a)])), linked: Object.fromEntries(['claude', 'codex', 'gemini'].map(a => [a, this.state.agentLinked(a)])),
      provider: this.providerInfo(), files: this.state.files.length, file_list: this.state.files.slice(-4), tasks_open: this.state.tasks.filter(t => !t.done).length, busy: this.chatBusy, agent_mode: this.agentMode, assistant_name: this.assistantName, boss_name: this.bossName, display_mode: this.state.settings.display_mode, reduce_motion: !!this.state.settings.reduce_motion, notch_lock: !!this.state.settings.notch_lock, pet_lock: !!this.state.settings.pet_lock, login: this.login ? this.login.status() : null, skin: this.state.settings.skin || 'classic', voice_replies: !!this.state.settings.voice_replies, voice_name: this.state.settings.voice_name || '', jobs_running: this.assistant.listJobs().filter(j => j.status === 'running').length, custom_skin: this.state.settings.custom_skin || null, gchat: !!gchatSignedIn(this.folder),
      recent: this.state.chat.filter(m => m.provider === this.provider.name && (m.role === 'user' || m.role === 'assistant')).slice(-40).map(m => ({ role: m.role, text: String(m.text || '').slice(0, 1500), ...(m.images ? { images: m.images } : {}) })) };
  }

  // provider ----------------------------------------------------------
  setProvider(name) {
    if (!providers.PROVIDERS[name]) return;
    if (this.chatBusy) this.stop();
    this.state.settings.provider = name; this.state.save();
    this.provider = providers.make(name);
    this.providerOk = null; this.providerDetail = '';
    this.ev('chat.history', { provider: name, chat: this.state.chat.filter(m => m.provider === name).slice(-120) });
    this.checkProvider();
  }
  async checkProvider() {
    const p = this.provider; this.ev('provider', this.providerInfo(true));
    const [ok, detail] = await p.available();
    if (p !== this.provider) return;
    this.providerOk = ok; this.providerDetail = ok ? 'ready' : 'not installed';
    this.ev('provider', this.providerInfo());
    if (!ok) { if (/not found/i.test(detail) && !this.installing && !(this.installTried || {})[p.name] && !process.env.BUDDY_NO_AUTOINSTALL) this.installCli(p.name); else this.system(detail, true); }
  }

  // ---------------------------------------------------------------- AI CLI setup (download + install + update, no terminal)
  // Claude Code: official native installer (self-updating), npm as fallback. Codex: npm (Node.js installed first if missing).
  // Gemini: Google's Antigravity CLI via winget / official installer. The user only signs in, in the browser.
  cliRun(cmd, args, opts = {}) {
    return new Promise(resolve => { let out = ''; let child; try { child = providers.spawnCompat(cmd, args, { windowsHide: true, ...opts }); } catch (e) { return resolve({ code: -1, out: e.message }); } const t = setTimeout(() => { try { child.kill(); } catch { /* */ } }, 15 * 60 * 1000); child.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-20000); }); child.stderr.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-20000); }); child.on('error', e => { clearTimeout(t); resolve({ code: -1, out: out + e.message }); }); child.on('close', code => { clearTimeout(t); resolve({ code, out }); }); });
  }
  addPath(...dirs) { const cur = (process.env.PATH || '').split(path.delimiter); const add = dirs.filter(d => d && !cur.some(c => c.toLowerCase() === d.toLowerCase())); if (add.length) process.env.PATH = [...add, ...cur].join(path.delimiter); }
  cliPaths() {
    const home = os.homedir(); const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    this.addPath(path.join(home, '.local', 'bin'), path.join(la, 'agy', 'bin'), path.join(la, 'Microsoft', 'WinGet', 'Links'), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'), path.join(la, 'Buddy-node'), IS_WIN ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs') : '');
  }
  // Node.js for npm-based CLIs: winget, else a portable Node (no admin rights) in %LOCALAPPDATA%\Buddy-node
  async ensureNpm(quiet) {
    const P = providers; this.cliPaths();
    let npm = P.which([IS_WIN ? 'npm.cmd' : 'npm']) || P.which(['npm']); if (npm) return npm;
    if (!IS_WIN) return '';
    if (!quiet) this.system('Node.js is missing — installing it first…');
    await this.cliRun('winget', ['install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements', '--silent']);
    this.cliPaths(); npm = P.which(['npm.cmd', 'npm']); if (npm) return npm;
    const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); const dest = path.join(la, 'Buddy-node'); const ver = 'v22.11.0'; const zip = path.join(os.tmpdir(), `node-${ver}-win-x64.zip`);
    const ps = `$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/${ver}/node-${ver}-win-x64.zip' -OutFile $env:BZIP; $t = Join-Path $env:TEMP 'buddy-node-x'; if (Test-Path $t) { Remove-Item -Recurse -Force $t }; Expand-Archive -LiteralPath $env:BZIP -DestinationPath $t -Force; if (Test-Path $env:BDEST) { Remove-Item -Recurse -Force $env:BDEST }; Move-Item (Join-Path $t 'node-${ver}-win-x64') $env:BDEST`;
    await this.cliRun('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { env: { ...process.env, BZIP: zip, BDEST: dest } });
    try { fs.unlinkSync(zip); } catch { /* */ }
    this.cliPaths(); return P.which(['npm.cmd', 'npm']) || (fs.existsSync(path.join(dest, 'npm.cmd')) ? path.join(dest, 'npm.cmd') : '');
  }
  async installCli(name, opts = {}) {
    const spec = { gemini: 'Gemini (Antigravity CLI)', claude: 'Claude Code', codex: 'Codex' }[name]; if (!spec || this.installing) return false;
    const quiet = !!opts.quiet; const P = providers;
    this.installTried = this.installTried || {}; this.installTried[name] = true; // one automatic attempt per CLI per run (the Install button can retry)
    await new Promise(r => setImmediate(r));
    if (this.installing) return false;
    this.installing = name; if (this.provider.name === name) { this.providerDetail = 'installing…'; this.ev('provider', this.providerInfo(true)); }
    this.state.setAgentState(name, 'working', 'Installing ' + spec, '', 'chat');
    const sh = (cmd) => IS_WIN ? this.cliRun('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]) : this.cliRun('bash', ['-c', cmd]);
    let ok = false, out = '';
    try {
      this.cliPaths();
      if (!quiet) this.system(`Installing ${spec}… this takes a minute. You'll only need to sign in.`);
      if (name === 'gemini') {
        if (IS_WIN) { out = (await this.cliRun('winget', ['install', '-e', '--id', 'Google.AntigravityCLI', '--accept-source-agreements', '--accept-package-agreements', '--silent'])).out; this.cliPaths(); if (!P.Gemini.agyPath()) out = (await sh('irm https://antigravity.google/cli/install.ps1 | iex')).out; }
        else out = (await sh('curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-aliases')).out;
        this.cliPaths(); ok = !!P.Gemini.agyPath();
        if (ok) { try { connectAgy(this.folder); } catch { /* optional */ } }
      } else if (name === 'claude') {
        out = (await sh(IS_WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash')).out; // native: updates itself
        this.cliPaths(); P.resetNpmCache(); ok = !!P.Claude.executable();
        if (!ok) { const npm = await this.ensureNpm(quiet); if (npm) { out = (await this.cliRun(npm, ['install', '-g', '@anthropic-ai/claude-code'])).out; P.resetNpmCache(); ok = !!P.Claude.executable(); } }
        if (ok) { try { connectClaudeCode(this.folder); } catch { /* optional */ } }
      } else {
        const npm = await this.ensureNpm(quiet);
        if (!npm) out = 'Node.js/npm could not be installed automatically (install it from https://nodejs.org).';
        else { out = (await this.cliRun(npm, ['install', '-g', '@openai/codex'])).out; P.resetNpmCache(); ok = !!P.Codex.executable(); }
        if (ok) { try { connectCodex(this.folder); } catch { /* optional */ } }
      }
      if (!ok) { this.system(`${spec} install failed: ${String(out).trim().split('\n').slice(-3).join(' ')}`, true); this.state.setAgentState(name, 'error', spec + ' install failed', '', 'chat'); return false; }
      this.state.settings.cli_updated = { ...(this.state.settings.cli_updated || {}), [name]: Date.now() }; this.state.save();
      this.system(`${spec} installed${quiet ? ' in the background' : ''}.`);
      if (this.cli) this.cli.check().catch(() => {});
      this.state.setAgentState(name, 'done', spec + ' installed', '', 'chat');
      if (!quiet) setTimeout(() => this.signIn(name), 0);
      return true;
    } finally { this.installing = null; if (this.provider.name === name) this.checkProvider(); }
  }
  // Background: install every missing AI CLI once (no sign-in popups) and update the installed ones whenever a newer
  // version is out (checked at start and every 6 hours; never during a reply). See clitools.js.
  async cliSetup() { this.cli = this.cli || new CliTools(this); return this.cli.run(); }
  setAgentMode(on) { this.state.settings.agent_mode = !!on; this.state.save(); this.ev('settings', { settings: { ...this.state.settings } }); }

  // chat --------------------------------------------------------------
  systemPrompt(agent, text) {
    const parts = [`You are ${this.assistantName}, a friendly and concise desktop assistant for ${this.bossName}. You live inside Buddy, a small companion app on their PC. Answer in the user's language, keep replies short and practical. Markdown is fine (code blocks, short lists).`];
    if (agent) parts.push('Do mode: the user asked you to act, not only advise. Make the change in the working folder yourself (edit files, run commands), verify it, then report briefly what you did.');
    else parts.push('Chat mode: talk like a close friend texting, not an assistant writing a report — short messages (1–3 sentences unless they ask for detail), same language and script as the user (Roman Urdu if they write Roman Urdu, English if English, mixed if mixed), their tone and slang, no headings or bullet lists unless asked, no "As an AI". Ask a short follow-up only when it helps.');
    const style = this.memory.styleText();
    if (style) parts.push('How the user actually writes (mirror this tone, language and length):\n' + style);
    parts.push(`The user's name is ${this.bossName} (set in Buddy settings — this overrides any other name in memory). Your name is ${this.assistantName}.`);
    const mem = this.memory.promptText();
    if (mem) parts.push('What you know about the user (Buddy memory — follow the rules in it, use the context, never recite it back):\n' + mem + '\n\nIf you learn something durable about the user or a project, call buddy_remember(text) once with a short line.');
    const proj = this.memory.projectText(this.state.settings.workdir || '');
    if (proj) parts.push('Project context for the current working folder (follow it):\n' + proj);
    const pnotes = this.memory.projectNotes(this.state.settings.workdir || '');
    if (pnotes) parts.push('Your notes for this project (Buddy memory → This project):\n' + pnotes);
    try { const k = text && this.assistant ? this.assistant.knowledgeContext(text) : ''; if (k) parts.push(k); } catch { /* */ }
    const recent = this.memory.recentText(8);
    if (recent) parts.push('Recent tasks Buddy did for the user (for references like "that file from before"):\n' + recent);
    if (this.state.files.length) {
      parts.push('The user attached these files; read them with your file tools when relevant:\n' + this.state.files.map(f => '- ' + f).join('\n'));
    }
    return parts.join('\n\n');
  }
  submit(text, agent, opts = {}) {
    text = String(text || '').trim();
    // WhatsApp-style: pictures attached right now travel with this message (shown in the bubble), then leave the tray
    const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i; const images = opts.raw || text.startsWith('/') ? [] : this.state.files.filter(f => IMG.test(f));
    if (!text && images.length) text = images.length > 1 ? 'Please look at these images.' : 'Please look at this image.';
    if (!text) return;
    if (!opts.raw && this.pendingPerms.size && /^(agree|agreed|done|approve|approved|accept|accepted|allow|ok|okay|yes|haan|han|ha|ji|kar do|krdo|kr do|karo|chalo|go|reject|deny|no|nahi|nhi|cancel|mat karo)\b[.!]*$/i.test(text)) {
      this.reshowPending(); this.system('An action is waiting for your approval — use the Accept / Reject buttons on the card (typing it here does not approve it).'); return;
    }
    if (text.startsWith('/') && !opts.raw) return this.command(text);
    const shown = opts.display || (images.length && /^Please look at th(is|ese) image/.test(text) ? '' : text);
    agent = agent == null ? this.agentMode : !!agent;
    if (this.chatBusy) return this.system('Still replying — press Stop first.', true);
    if (!opts.raw && this.state.settings.auto_pick !== false && (shown || '').length > 12) { try { const best = pickProvider(shown); this.pickTips = this.pickTips || new Set(); const k = this.provider.name + '>' + best; if (best !== this.provider.name && !this.pickTips.has(k)) { this.pickTips.add(k); this.ev('pick.tip', { name: best, label: (providers.ALL.find(p => p.name === best) || {}).label || best, why: PICK_WHY[best] }); } } catch { /* */ } }
    this.chatBusy = true; const provider = this.provider;
    this.lastTask = { text: shown || text, agent, at: Date.now() };
    if (!opts.raw && /^(no[,.!]|nope|nahi|nhi|galat|wrong|don't|dont|never|always|hamesha|kabhi)\b/i.test(shown) && shown.length < 240) { try { this.memory.remember('Correction from the user: ' + shown, 'buddy'); } catch { /* */ } }
    try { if (!opts.raw) this.memory.recordStyle(shown); } catch { /* */ }
    this.state.addChat('user', shown, provider.name, { images });
    this.ev('chat.user', { text: shown, images });
    if (images.length) { for (const f of images) this.removeFile(f); text += '\n\n[Attached image' + (images.length > 1 ? 's' : '') + ' — open and look at ' + (images.length > 1 ? 'them' : 'it') + ':\n' + images.map(f => '- ' + f).join('\n') + ']'; } this.ev('chat.begin', { provider: provider.name, label: provider.label, agent });
    this.state.setAgentState(provider.name, 'working', (agent ? 'Doing: ' : '') + (shown || '📷 Image').slice(0, 70), '', 'chat');
    const history = this.state.chat.slice(0, -1).filter(m => m.provider === provider.name && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: m.text }));
    const ctx = { system: this.systemPrompt(agent, shown || text), history, session: this.state.settings.sessions[this.sessionKey(provider.name)] || '', workdir: this.state.settings.workdir || os.homedir(), files: [...this.state.files, ...images], agent, mcpConfig: this.mcpConfigFile() };
    // no resumable session (new folder, expired session…): give the AI the last few turns so the conversation continues
    if (!ctx.session && history.length) { const h = history.slice(-8).map(m => (m.role === 'user' ? 'User: ' : 'You: ') + String(m.content).slice(0, 600)).join('\n'); ctx.system += '\n\nEarlier in this conversation:\n' + h; }
    this.hookMarker(provider.name);
    if (provider.name === 'gemini' && providers.Gemini.agyPath()) { try { connectAgy(this.folder); } catch { /* */ } }
    provider.run(text, ctx, (kind, data) => this.chatEvent(provider, kind, data)).catch(e => this.chatEvent(provider, 'error', 'Unexpected error: ' + e.message));
  }
  chatEvent(provider, kind, data) {
    const name = provider.name;
    if (provider !== this.provider && kind !== 'done' && kind !== 'error') return;
    if (kind === 'text') this.ev('chat.text', { chunk: data });
    else if (kind === 'step') {
      if (data.tool) { this.ev('chat.step', { tool: data.tool, detail: data.detail || '', status: data.status || 'running' }); try { this.state.addAgentStep(name, data.tool, data.detail, data.status || 'running'); } catch { /* */ } }
      else { this.ev('chat.step', { tool: '', detail: '', status: data.status || 'done' }); this.state.closeRunningStep(name, data.status || 'done'); }
    } else if (kind === 'session') { this.state.settings.sessions[this.sessionKey(name)] = data; this.state.save(); }
    else if (kind === 'done') {
      // Verify pass: after a Do-mode task, ask the same session to check its own work before we call it done.
      if (this.lastTask && this.lastTask.agent && !this.lastTask.verified && !this.verifying && this.state.settings.verify_do !== false && !process.env.BUDDY_NO_VERIFY) {
        {
          this.verifying = true; this.lastTask.verified = true; this.firstReply = data; this.ev('chat.text', { chunk: '\n\n' }); this.ev('chat.step', { tool: 'Verify', detail: 'checking the result', status: 'running' });
          const vp = 'Verify what you just did before we finish: check that the files/changes you reported actually exist and work (read them back, run the relevant test or command). Reply in one or two lines starting with VERIFIED: (what you confirmed) or ISSUE: (what is wrong and that you fixed it or could not).';
          const ctx = { system: '', history: [], session: this.state.settings.sessions[this.sessionKey(name)] || '', workdir: this.state.settings.workdir || os.homedir(), files: [], agent: true, mcpConfig: this.mcpConfigFile() };
          provider.run(vp, ctx, (k, d) => { if (k === 'done' || k === 'error') { this.verifying = false; this.ev('chat.step', { tool: '', detail: '', status: k === 'done' && /^\s*VERIFIED/i.test(d) ? 'done' : 'error' }); const note = k === 'done' ? String(d).trim() : ''; this.chatEvent(provider, 'done', this.firstReply + (note ? '\n\n' + (/^\s*VERIFIED/i.test(note) ? '✅ ' : '⚠️ ') + note.slice(0, 500) : '')); } else if (k === 'step') this.chatEvent(provider, 'step', d); }).catch(() => { this.verifying = false; this.chatEvent(provider, 'done', this.firstReply); });
          return;
        }
      }
      this.chatBusy = false; this.denyPending(); this.hookMarker(null); this.state.addChat('assistant', data, name); if (this.cli) this.cli.idle();
      try { if (this.lastTask) this.memory.logWork(name, this.lastTask.text, data.trim().split('\n')[0]); } catch { /* */ }
      const first = (data.trim().split('\n')[0] || 'Done').slice(0, 70);
      this.state.setAgentState(name, 'done', first, '', 'chat'); this.ev('chat.done', { text: data, provider: name });
      this.scheduleFinished(true, data);
    } else if (kind === 'error') {
      this.chatBusy = false; this.denyPending(); this.hookMarker(null); if (this.cli) this.cli.idle(); const stopped = data === 'Stopped.';
      if (!stopped && name === 'gemini' && /Antigravity CLI \(Gemini\) not found/.test(data) && !this.installing && !process.env.BUDDY_NO_AUTOINSTALL) setTimeout(() => this.installCli('gemini'), 0);
      if (!stopped && needsLogin(name, data)) {
        if (this.login.recentlyOk(name)) data = `${provider.label} still refuses right after sign-in. CLI said: ${String(data).replace(/^[^(]*\(?/, '').replace(/\)$/, '') || data}`;
        else { data = `${provider.label} is not signed in yet — opening your browser to sign in.`; setTimeout(() => this.signIn(name, true), 0); }
      }
      if (!stopped && /no conversation found|session .{0,40}not found|invalid session|could not (find|resume)|failed to resume|unknown session/i.test(data)) { delete this.state.settings.sessions[this.sessionKey(name)]; this.state.save(); data += ' — Buddy started a fresh conversation; send it again.'; }
      this.state.setAgentState(name, stopped ? 'idle' : 'error', stopped ? '' : data.slice(0, 70), '', 'chat');
      this.ev('chat.error', { message: data, stopped });
      this.scheduleFinished(false, data);
    }
  }
  // marks a Buddy-run Codex/Gemini session so the approval hook routes to Buddy (and stays neutral for the user's own sessions)
  hookMarker(name) { const f = path.join(this.folder, 'hook-active.json'); try { if (name) fs.writeFileSync(f, JSON.stringify({ provider: name, at: Date.now() })); else fs.unlinkSync(f); } catch { /* */ } }
  // AI sessions belong to one provider in one working folder (resuming a Claude session from another folder fails)
  sessionKey(name) { return name + '|' + String(this.state.settings.workdir || os.homedir()).toLowerCase(); }
  stop() { if (this.chatBusy) this.provider.cancel(); }
  clearChat() { this.state.clearChat(this.provider.name); this.ev('chat.cleared'); this.system(`${this.provider.label} conversation cleared.`); }
  command(text) {
    const [cmdRaw, ...rest] = text.slice(1).split(' '); const cmd = cmdRaw.toLowerCase(); const arg = rest.join(' ').trim();
    if (cmd === 'help') return this.system(HELP);
    if (cmd === 'task' && arg) { this.state.addTask(arg); this.system('Added task: ' + arg); return this.ev('say', { agent: '', text: 'Task added.', reaction: 'done' }); }
    if (cmd === 'remind') {
      const m = arg.match(/^(\d+)\s*([smhd])\s+(.+)$/i); if (!m) return this.system('Use: /remind 10m Stretch  (s, m, h, d)', true);
      try { this.state.addReminder(parseInt(m[1], 10) * UNITS[m[2].toLowerCase()], m[3]); } catch (e) { return this.system(e.message, true); }
      this.system(`Reminder set for ${m[1]}${m[2]}: ${m[3]}`); return this.ev('say', { agent: '', text: "I'll remind you.", reaction: 'done' });
    }
    if (cmd === 'bg' || cmd === 'background') {
      if (!arg) return this.system('Use: /bg <task>  (or /bg do <task> to let it edit and run). It runs in the background — see Planner → Activity.', true);
      const m = arg.match(/^(do|ask)\s+([\s\S]+)$/i); const j = this.assistant.startJob({ prompt: m ? m[2] : arg, mode: m && m[1].toLowerCase() === 'do' ? 'do' : 'ask', source: 'chat' });
      this.system(`Started in the background with ${providers.ALL.find(p => p.name === j.provider)?.label || 'the best AI'}: ${j.title}\nYou'll get a ping when it's done (Planner → Activity).`); return this.ev('say', { agent: '', text: 'On it in the background.', reaction: 'done' });
    }
    if (cmd === 'files') return this.system(this.state.files.length ? this.state.files.join('\n') : 'No files attached.');
    if (cmd === 'clear') return this.clearChat();
    if (providers.PROVIDERS[cmd]) return this.setProvider(cmd);
    if (cmd === 'skills') { const ks = this.skills(); return this.system(ks.length ? 'Skills (type /name task…):\n' + ks.map(k => `/${k.name} — ${k.description || k.source}`).join('\n') : 'No skills found. Put a SKILL.md in Buddy-data\\skills\\<name>\\ (or ~/.codex/skills, ~/.claude/skills).'); }
    if (cmd === 'remember' && arg) { const r = this.memory.remember(arg, 'you'); this.ev('memory', {}); return this.system(r.remembered ? 'Noted in memory.' : 'Already in memory.'); }
    if (cmd === 'memory') return this.system(this.memory.promptText() || 'Memory is empty.');
    if (cmd === 'rule' && arg) { const r = this.memory.addRule(arg); this.ev('memory', {}); return this.system(r.added ? 'Rule saved — applies to every task from now on.' : 'That rule is already saved.'); }
    const skill = this.skills().find(k => k.name === cmd);
    if (skill) {
      let prompt; try { prompt = skillPrompt(skill, arg, this.state.files); } catch (e) { return this.system('Could not read skill: ' + e.message, true); }
      return this.submit(prompt, true, { raw: true, display: text });
    }
    this.system('Unknown command. Type /help.', true);
  }

  // files / tasks / settings ------------------------------------------
  attach(paths) { return this.state.addFiles(paths); }
  removeFile(p) { this.state.removeFile(p); }
  isRisky(p) { return RISKY.has(path.extname(p).toLowerCase()); }
  applySettings(changes) {
    const problems = [], clean = {};
    for (const k of ['assistant_name', 'boss_name']) if (k in changes) { const v = String(changes[k]).trim(); if (v.length < 1 || v.length > 24) problems.push('Names must be 1–24 characters.'); clean[k] = v; }
    if ('workdir' in changes) { const w = String(changes.workdir).trim(); if (w && !(fs.existsSync(w) && fs.statSync(w).isDirectory())) { if (w !== this.state.settings.workdir) problems.push('Working folder does not exist.'); } else clean.workdir = w; }
    if (['notch', 'pet'].includes(changes.display_mode)) clean.display_mode = changes.display_mode;
    if ('reduce_motion' in changes) clean.reduce_motion = !!changes.reduce_motion;
    if ('notch_lock' in changes) clean.notch_lock = !!changes.notch_lock;
    if ('pet_lock' in changes) clean.pet_lock = !!changes.pet_lock;
    if ('auto_update' in changes) clean.auto_update = !!changes.auto_update;
    if ('verify_do' in changes) clean.verify_do = !!changes.verify_do;
    for (const k of ['auto_pick', 'voice_replies', 'wake_word', 'quick_hotkey', 'meeting_reminders']) if (k in changes) clean[k] = !!changes[k];
    if ('voice_name' in changes) clean.voice_name = String(changes.voice_name || '').slice(0, 120);
    if (['windows', 'offline'].includes(changes.dictation)) clean.dictation = changes.dictation;
    if (['direct', 'all', 'off'].includes(changes.gchat_notify)) clean.gchat_notify = changes.gchat_notify;
    if ('quick_hotkey_accel' in changes) { const a = String(changes.quick_hotkey_accel || '').trim(); if (!a || /^((CommandOrControl|Ctrl|Alt|Shift|Super)\+){1,3}[A-Za-z0-9]$|^((CommandOrControl|Ctrl|Alt|Shift|Super)\+){1,3}(Space|F\d{1,2})$/.test(a)) clean.quick_hotkey_accel = a; else problems.push('Hotkey looks like Ctrl+Shift+Space or Alt+Q.'); }
    if ('meeting_lead_min' in changes) { const n = parseInt(changes.meeting_lead_min, 10); if (n >= 1 && n <= 60) clean.meeting_lead_min = n; else problems.push('Meeting reminder lead must be 1–60 minutes.'); }
    if (['classic', 'antenna', 'boxy', 'cat', 'ghost', 'blob', 'custom'].includes(changes.skin)) clean.skin = changes.skin;
    if (changes.custom_skin && typeof changes.custom_skin === 'object') { const c = changes.custom_skin; const cur = this.state.settings.custom_skin || {}; const box = Array.isArray(c.box) && c.box.length === 4 ? c.box.map(n => Math.max(0, Math.min(100, Number(n) || 0))) : (cur.box || [25, 38, 50, 34]); clean.custom_skin = { ...cur, box, ink: c.ink === 'light' ? 'light' : 'dark' }; }
    if (problems.length) return problems;
    const nameChanged = clean.boss_name && clean.boss_name !== this.state.settings.boss_name;
    Object.assign(this.state.settings, clean); this.state.save();
    if (nameChanged) { try { const prof = this.memory.read('profile'); const next = /^- Name:.*$/m.test(prof) ? prof.replace(/^- Name:.*$/m, '- Name: ' + clean.boss_name) : prof.replace(/\s+$/, '') + '\n- Name: ' + clean.boss_name + '\n'; this.memory.write('profile', next); } catch { /* */ } }
    this.ev('settings', { settings: { ...this.state.settings } });
    if ('wake_word' in clean || 'assistant_name' in clean) { try { this.assistant.stopWake(); this.assistant.applyWake(); } catch { /* */ } }
    if (('quick_hotkey' in clean || 'quick_hotkey_accel' in clean) && this.onHotkeyChange) this.onHotkeyChange();
    if ('assistant_name' in clean || 'boss_name' in clean) this.ev('say', { agent: '', text: `Saved. I'm ${this.assistantName}, here for ${this.bossName}.`, reaction: 'done' });
    else if ('pet_lock' in clean && Object.keys(clean).length === 1) this.ev('say', { agent: '', text: clean.pet_lock ? 'Pet locked 🔒' : 'Pet unlocked', reaction: 'done' });
    return [];
  }
  instructionsText() { return BUDDY_INSTRUCTIONS.replace(/^## Buddy\n/, ''); }
  connectStatus() { try { return connectStatus(this.folder); } catch { return { claude_desktop: 'missing', claude_code: 'missing', codex: 'missing', gemini: 'missing' }; } }
  connect(key, explicit) {
    try {
      if (key === 'claude') {
        const out = [], errs = [];
        for (const [name, fn] of [['Claude Desktop', () => connectClaudeDesktop(this.folder, explicit)], ['Claude Code', () => connectClaudeCode(this.folder)]]) {
          try { out.push(fn()); } catch (e) { errs.push(`${name}: ${e.message}`); }
        }
        return { ok: out.length > 0, message: [...out, ...errs].join('\n\n') };
      }
      if (key === 'claude_desktop') return { ok: true, message: connectClaudeDesktop(this.folder, explicit) };
      if (key === 'claude_code') return { ok: true, message: connectClaudeCode(this.folder) };
      if (key === 'codex') return { ok: true, message: connectCodex(this.folder) };
      if (key === 'gemini') { let m = ''; try { m = connectGemini(this.folder); } catch (e) { m = e.message; } if (providers.Gemini.agyPath()) m += '\nAntigravity CLI: ' + connectAgy(this.folder); return { ok: true, message: m }; }
      return { ok: false, message: 'Unknown target.' };
    } catch (e) { return { ok: false, message: e.message }; }
  }
}

module.exports = { installAgyHooks, installCodexHooks, hookWrapper, BUDDY_INSTRUCTIONS, registerGoogleChat, gchatStatus, connectGemini, Core, ToolServer, bridgeCommand, connectCodex, connectClaudeDesktop, connectClaudeCode, connectStatus, parseBuddyToml };
