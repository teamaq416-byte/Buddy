'use strict';
// Chat providers: Gemini CLI, Codex CLI, Claude Code CLI (all headless, JSON-streamed).
// Each run(prompt, ctx, emit) resolves when finished; emit(kind, payload) gets
// 'session' | 'text' | 'step' | 'done' | 'error' exactly like the Python edition.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';

function which(names, extra = []) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) for (const dir of dirs) for (const ext of exts) {
    const p = path.join(dir, name + (name.toLowerCase().endsWith(ext.toLowerCase()) ? '' : ext));
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  for (const p of extra) { try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return '';
}


// Windows .cmd/.bat shims (npm-installed CLIs) must run through cmd.exe, and Node joins shell args with bare spaces —
// so any arg with a space ("Respond to the request above.", C:\Users\Jane Doe\…) splits into several args.
// Quote everything ourselves and hand cmd.exe one finished command line.
function needsShell(cmd) { return IS_WIN && /\.(cmd|bat)$/i.test(String(cmd || '')); }
function cmdQuote(a) {
  a = String(a ?? '');
  if (a === '') return '""';
  if (!/[\s"&|<>^(),;=%!]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function shellLine(cmd, args) { return [cmdQuote(cmd), ...(args || []).map(cmdQuote)].join(' '); }
// npm installs CLIs as .cmd shims that just run `node <script> %*`. Running that script with node directly avoids cmd.exe
// completely: no quoting rules, stdin/stdout are the real CLI's, and Stop actually kills the CLI (killing cmd.exe orphans it).
function resolveNodeShim(cmdPath) {
  try {
    if (!needsShell(cmdPath)) return null;
    const txt = fs.readFileSync(cmdPath, 'utf8'); const dir = path.dirname(cmdPath);
    // npm.cmd/npx.cmd (Node's own) mention npm-prefix.js first — the real entry is npm-cli.js / npx-cli.js
    const base = path.basename(cmdPath).toLowerCase(); let script = null;
    if (base === 'npm.cmd' || base === 'npx.cmd') { const f = path.join(dir, 'node_modules', 'npm', 'bin', base === 'npm.cmd' ? 'npm-cli.js' : 'npx-cli.js'); if (fs.existsSync(f)) script = f; }
    if (!script) {
      // the script that receives the arguments is on the line that passes %* (last such match wins)
      const re = /%(?:~?dp0%?|dp0%)\\?([^\s"%]+?\.(?:js|cjs|mjs))/ig; const lines = txt.split(/\r?\n/); const runLines = lines.filter(l => /%\*/.test(l)); let pick = null;
      for (const l of (runLines.length ? runLines : lines)) { let m; re.lastIndex = 0; while ((m = re.exec(l))) pick = m[1]; }
      if (!pick) return null;
      script = path.join(dir, ...pick.split(/[\\/]+/).filter(Boolean));
    }
    if (!fs.existsSync(script)) return null;
    const local = path.join(dir, 'node.exe');
    const node = fs.existsSync(local) ? local : (which(['node']) || [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'), path.join(process.env.LOCALAPPDATA || '', 'Buddy-node', 'node.exe')].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }));
    return node ? { node, script } : null;
  } catch { return null; }
}
function spawnCompat(cmd, args, opts = {}) {
  const shim = resolveNodeShim(cmd);
  if (shim) { const { spawn: sp } = require('child_process'); return sp(shim.node, [shim.script, ...(args || [])], { ...opts, shell: false }); }
  const { spawn: sp } = require('child_process');
  if (needsShell(cmd) || (IS_WIN && opts.shell)) { const o = { ...opts, shell: true, windowsVerbatimArguments: true }; return sp(shellLine(cmd, args), [], o); }
  return sp(cmd, args, { ...opts, shell: false });
}
function spawnSyncCompat(cmd, args, opts = {}) {
  const { spawnSync: ss } = require('child_process');
  const shim = resolveNodeShim(cmd); if (shim) return ss(shim.node, [shim.script, ...(args || [])], { ...opts, shell: false });
  if (needsShell(cmd) || (IS_WIN && opts.shell)) return ss(shellLine(cmd, args), [], { ...opts, shell: true, windowsVerbatimArguments: true });
  return ss(cmd, args, { ...opts, shell: false });
}

// Where npm puts global CLIs (gemini/claude/codex). Not always on PATH, so ask npm once and remember.
let npmBinCache = null;
function npmGlobalBin() {
  if (npmBinCache !== null) return npmBinCache;
  npmBinCache = '';
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSyncCompat(IS_WIN ? 'npm.cmd' : 'npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const prefix = String(r.stdout || '').trim().split(/\r?\n/).pop();
    if (prefix) npmBinCache = IS_WIN ? prefix : path.join(prefix, 'bin');
  } catch { /* npm missing */ }
  return npmBinCache;
}
function cliCandidates(name) {
  const home = os.homedir(); const nb = npmGlobalBin(); const out = [];
  if (nb) out.push(path.join(nb, name + (IS_WIN ? '.cmd' : '')));
  out.push(path.join(home, 'AppData', 'Roaming', 'npm', name + '.cmd'), path.join(home, 'AppData', 'Local', 'npm', name + '.cmd'), path.join(home, '.local', 'bin', name), path.join(home, '.local', 'bin', name + '.exe'), '/usr/local/bin/' + name, '/opt/homebrew/bin/' + name);
  return out;
}

class Provider {
  constructor() { this.proc = null; this.cancelled = false; }
  cancel() { this.cancelled = true; if (this.proc && this.proc.exitCode === null) { try { this.proc.kill(); } catch { /* gone */ } } }
  waitExit(proc) { return proc.exited || Promise.resolve(proc.exitCode || 0); }
  spawnCli(args, prompt, cwd, extraEnv) {
    this.cancelled = false;
    if (cwd && !fs.existsSync(cwd)) throw new Error(`the working folder "${cwd}" does not exist any more — change it in Settings`);
    const proc = spawnCompat(args[0], args.slice(1), {
      cwd: cwd || undefined, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(extraEnv || {}) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc; this.spawnErr = null;
    // a failed spawn (missing folder, blocked exe…) fires 'error' and maybe never 'close' — never leave the chat stuck
    proc.exited = new Promise(r => { proc.once('close', (c, sig) => r(c == null ? (sig ? 1 : 0) : c)); proc.once('error', e => { this.spawnErr = e; r(-1); }); });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    return { proc, getStderr: () => stderr };
  }
  async readJsonLines(proc, onEvent) {
    this.plain = ''; let stoppedEarly = false;
    const rl = readline.createInterface({ input: proc.stdout });
    for await (const line of rl) {
      if (this.cancelled) break;
      const t = line.trim();
      if (!t.startsWith('{')) { this.plain = ((this.plain || '') + t + '\n').slice(-4000); continue; }
      let obj; try { obj = JSON.parse(t); } catch { continue; }
      if (onEvent(obj) === false) { stoppedEarly = true; break; }
    }
    // stopped reading early (final result already in): keep draining so the CLI can't block on a full pipe, and don't wait forever for it
    if (stoppedEarly || this.cancelled) { try { proc.stdout.resume(); } catch { /* */ } const t = setTimeout(() => { try { if (proc.exitCode === null) proc.kill(); } catch { /* */ } }, 20000); proc.once('close', () => clearTimeout(t)); }
  }
  finish(proc, getStderr, emit, text, hadError, exitCode) {
    this.proc = null;
    if (this.cancelled) return emit('error', 'Stopped.');
    if (hadError) return;
    if (this.spawnErr && !text) return emit('error', `Could not start ${this.label}: ${this.spawnErr.message}`);
    if (exitCode && !text) { const e = getStderr().trim(); return emit('error', `${this.label} failed: ${e ? (e.length > 700 ? e.slice(0, 350) + ' … ' + e.slice(-300) : e) : 'exit code ' + exitCode}`); }
    if (!text) return emit('error', `${this.label} returned no reply. Check its login and limits.`);
    emit('done', text);
  }
}

// Since June 2026 Google's Gemini CLI no longer serves personal Google accounts ("IneligibleTierError … migrate to
// Antigravity"). Buddy's Gemini option therefore runs Google's Antigravity CLI (`agy`, a native binary, free Google
// account works). The old Gemini CLI is only used when a paid GEMINI_API_KEY is set and agy is not installed.
function agyCandidates() {
  const home = os.homedir(); const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [path.join(la, 'agy', 'bin', 'agy.exe'), path.join(la, 'Programs', 'agy', 'agy.exe'), path.join(la, 'Microsoft', 'WinGet', 'Links', 'agy.exe'), path.join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'];
}
// Antigravity headless (-p) cannot ask for approvals: any tool without an allow-rule is auto-denied and the run ends with
// "a tool required the "mcp" permission…". Buddy pre-grants its own MCP tools (exact mcp(<server>/<tool>) form — a bare
// server name never matches) and file reads, in ~/.gemini/antigravity-cli/settings.json.
const BUDDY_TOOLS = ['buddy_status', 'buddy_step', 'buddy_say', 'buddy_files', 'buddy_read_file', 'buddy_remind', 'buddy_schedule', 'buddy_open', 'buddy_system', 'buddy_clipboard', 'buddy_knowledge', 'buddy_background', 'buddy_task', 'buddy_tasks', 'buddy_complete_task', 'buddy_memory', 'buddy_remember', 'buddy_permission'];
function agyAllow() {
  try {
    const base = process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini');
    const f = path.join(base, 'antigravity-cli', 'settings.json'); let cfg = {};
    try { const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); if (raw.trim()) cfg = JSON.parse(raw); } catch (e) { if (e.code !== 'ENOENT') return; } // unreadable → leave the user's file alone
    cfg.permissions = cfg.permissions || {}; const allow = new Set(cfg.permissions.allow || []); const before = allow.size;
    for (const t of BUDDY_TOOLS) allow.add(`mcp(buddy/${t})`); allow.add('mcp(buddy/*)'); allow.add('read_file(*)');
    if (allow.size === before) return;
    cfg.permissions.allow = [...allow]; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  } catch { /* best effort */ }
}
const AGY_MAX_ARG = 24000; // Windows command lines max out at 32k chars and agy takes the prompt only as an argument
const HELP_CACHE = {};
function cliHelp(exe, args) { const k = exe + ' ' + args.join(' '); if (HELP_CACHE[k] == null) { try { const r = spawnSyncCompat(exe, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }); HELP_CACHE[k] = String((r.stdout || '') + (r.stderr || '')); } catch { HELP_CACHE[k] = ''; } } return HELP_CACHE[k]; }
class Gemini extends Provider {
  constructor() { super(); this.name = 'gemini'; this.label = 'Gemini'; this.accent = '#8ab4f8'; }
  static agyPath() { return which(['agy'], agyCandidates()); }
  static legacyPath() { return which(['gemini'], cliCandidates('gemini')); }
  static useLegacy() { return !Gemini.agyPath() && !!Gemini.legacyPath() && !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY); }
  static executable() { return Gemini.agyPath() || (Gemini.useLegacy() ? Gemini.legacyPath() : ''); }
  async available() { const exe = Gemini.executable(); return exe ? [true, path.basename(exe)] : [false, 'Antigravity CLI (Gemini) not found.']; }
  async run(prompt, ctx, emit) {
    if (Gemini.agyPath()) return this.runAgy(prompt, ctx, emit);
    const exe = Gemini.executable();
    if (!exe) return emit('error', 'Antigravity CLI (Gemini) not found.');
    const full = ctx.system && !ctx.session ? ctx.system + '\n\n' + prompt : prompt;
    // The whole prompt goes through stdin (never on the command line: cmd.exe would mangle quotes/newlines); the CLI appends -p after it.
    const args = [exe, '--output-format', 'stream-json', '--approval-mode', ctx.agent ? 'yolo' : 'default', '-p', 'Respond to the request above.'];
    if (ctx.session) args.push('--resume', ctx.session);
    let proc, getStderr;
    // Signed in through Buddy (Google login saved in ~/.gemini/oauth_creds.json)? Tell the CLI to use it even if
    // settings.json has no/unknown auth type — otherwise headless gemini stops with "Please set an Auth method".
    const env = {};
    try { const gd = process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini'); if (fs.existsSync(path.join(gd, 'oauth_creds.json')) && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.GOOGLE_GENAI_USE_VERTEXAI) env.GOOGLE_GENAI_USE_GCA = 'true'; } catch { /* */ }
    try { ({ proc, getStderr } = this.spawnCli(args, full + '\n', ctx.workdir, env)); } catch (e) { return emit('error', 'Could not start Gemini CLI: ' + e.message); }
    let text = '', hadError = false; const tools = new Map();
    await this.readJsonLines(proc, ev => {
      const kind = ev.type || '';
      if (kind === 'init' && ev.session_id) emit('session', ev.session_id);
      else if (kind === 'message' && ev.role === 'assistant' && ev.content) { text += ev.content; emit('text', ev.content); }
      else if (kind === 'tool_use') { if (/^(buddy_|mcp__buddy__|buddy\b)/i.test(String(ev.tool_name || ''))) return; const a = ev.parameters || {}; const detail = String(a.file_path || a.path || a.pattern || a.query || a.command || a.url || '').slice(0, 120); tools.set(ev.tool_id, ev.tool_name); emit('step', { tool: ev.tool_name || 'Tool', detail, status: 'running' }); }
      else if (kind === 'tool_result') emit('step', { tool: '', detail: '', status: ev.status === 'error' ? 'error' : 'done' });
      else if (kind === 'error') { const msg = ev.message || (ev.error && ev.error.message) || 'Gemini error'; if (/auth|login|sign in|credential|401|403/i.test(msg) || ev.fatal) { emit('error', 'Gemini: ' + msg); hadError = true; return false; } }
      else if (kind === 'result') { if (ev.status && ev.status !== 'success' && !text) { emit('error', 'Gemini: ' + (ev.error && ev.error.message || ev.status)); hadError = true; } return false; }
    });
    const code = await this.waitExit(proc);
    if (!hadError && !text && code) {
      const err = (getStderr() + '\n' + (this.plain || '')).replace(/\x1b\[[0-9;]*m/g, '');
      const why = (err.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^at\s|^\{|^\}|exitCode/.test(l)).pop() || '').slice(0, 300);
      if (/manual authorization|consent could not|not (logged|authenticated)|set an auth method|sign in|login required|invalid_grant|unauthenticated|\b401\b/i.test(err)) return emit('error', 'Gemini is not signed in yet.' + (why ? ' (' + why + ')' : ''));
      if (/IneligibleTier|no longer supported for Gemini Code Assist/i.test(err)) return emit('error', 'Google stopped the Gemini CLI for personal accounts — Antigravity CLI (Gemini) not found.');
      if (why) return emit('error', 'Gemini failed: ' + why);
    }
    this.finish(proc, getStderr, emit, text, hadError, code);
  }
  // Antigravity CLI: `agy -p "<prompt>"` prints the answer as plain text (stdin is not read, so the prompt is an argument).
  async runAgy(prompt, ctx, emit) {
    const exe = Gemini.agyPath();
    let sys = ctx.system || ''; const room = AGY_MAX_ARG - prompt.length - 200;
    if (sys.length > room) sys = room > 2000 ? sys.slice(0, Math.floor(room * 0.6)) + '\n…\n' + sys.slice(-Math.floor(room * 0.4)) : '';
    const full = (sys ? sys + '\n\n---\n' : '') + prompt;
    const args = [exe, '-p', full.slice(0, AGY_MAX_ARG + 2000), '--print-timeout', '15m'];
    if (ctx.workdir) args.push('--add-dir', ctx.workdir);
    // Do: everything auto-approved inside the working folder. Ask: plan mode (no edits/commands) + auto-approve, so reads and
    // Buddy's own tools are not soft-denied (headless mode has no way to ask).
    // Approvals: Buddy's PreToolUse hook (~/.gemini/config/hooks.json) answers every tool call — auto_approve for normal work,
    // the Accept/Reject toast for risky ones. --dangerously-skip-permissions would switch hooks off, so it is only a fallback.
    if (!ctx.agent) args.push('--mode', 'plan');
    if (ctx.skipPerms) args.push('--dangerously-skip-permissions');
    agyAllow();
    let proc, getStderr;
    try { ({ proc, getStderr } = this.spawnCli(args, '', ctx.workdir)); } catch (e) { return emit('error', 'Could not start Antigravity CLI: ' + e.message); }
    let text = '';
    proc.stdout.on('data', d => { const t = String(d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, ''); if (!t) return; text += t; if (!this.cancelled) emit('text', t); });
    const code = await this.waitExit(proc);
    if (this.cancelled) { this.proc = null; return emit('error', 'Stopped.'); }
    if (this.spawnErr && !text) { this.proc = null; return emit('error', 'Could not start Antigravity CLI: ' + this.spawnErr.message); }
    const err = getStderr().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (!text.trim()) {
      this.proc = null; const why = (err.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() || (code ? 'exit code ' + code : 'no reply')).slice(0, 300);
      if (/sign[ -]?in|log ?in|not authenticated|unauthenticated|authenticat(e|ion) (required|failed)|keyring|oauth|credential/i.test(err)) return emit('error', 'Gemini is not signed in yet. (' + why + ')');
      if (!ctx.skipPerms && /headless mode cannot prompt|auto-denied|soft-denied/i.test(err)) { // this agy build ignored the hook's answer
        emit('step', { tool: 'Approvals', detail: 'Antigravity ignored Buddy\'s approval hook — running with auto-approve', status: 'done' });
        return this.runAgy(prompt, { ...ctx, skipPerms: true }, emit);
      }
      if (/denied|permission|approval/i.test(err)) return emit('error', 'Gemini (Antigravity) blocked a tool: ' + why.replace(/^jetski:\s*/i, '') + (ctx.agent ? '' : ' Switch to Do mode if it needs to change files.'));
      return emit('error', 'Gemini failed: ' + why);
    }
    this.proc = null; emit('done', text.trim());
  }
}

function cleanCommand(cmd) {
  if (Array.isArray(cmd)) cmd = cmd.map(String);
  else if (typeof cmd === 'string' && /^\s*\[/.test(cmd)) { try { cmd = JSON.parse(cmd).map(String); } catch { /* keep */ } }
  if (Array.isArray(cmd)) {
    // Drop the shell launcher (powershell.exe -Command / cmd /c / bash -lc) and show the real command.
    const i = cmd.findIndex((a, k) => k > 0 && /^(-Command|-c|-lc|\/c)$/i.test(cmd[k - 1]));
    cmd = i > 0 ? cmd.slice(i).join(' ') : cmd.join(' ');
  }
  return String(cmd || '').replace(/^"|"$/g, '').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim();
}
const STEP_NAMES = { command_execution: 'Bash', file_change: 'Edit', mcp_tool_call: 'Tool', web_search: 'Search', plan_update: 'Plan', todo_list: 'Plan' };

class Codex extends Provider {
  constructor() { super(); this.name = 'codex'; this.label = 'Codex'; this.accent = '#5eead4'; }
  static executable() {
    const home = os.homedir(); const extra = cliCandidates('codex');
    try { const bin = path.join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'); for (const d of fs.readdirSync(bin)) extra.push(path.join(bin, d, 'codex.exe')); } catch { /* none */ }
    return which(['codex'], extra);
  }
  static supports(flag) { const exe = Codex.executable(); return !!exe && cliHelp(exe, ['exec', '--help']).includes(flag); }
  async available() { const exe = Codex.executable(); return exe ? [true, path.basename(exe)] : [false, 'Codex CLI not found. Install it (`npm i -g @openai/codex`) or open the Codex app and sign in.']; }
  async run(prompt, ctx, emit) {
    const exe = Codex.executable();
    if (!exe) return emit('error', 'Codex CLI not found. Install it with `npm i -g @openai/codex` and run `codex login`.');
    // Do = workspace-write sandbox, Ask = read-only. Approvals go to Buddy's toast through Codex hooks (PreToolUse +
    // PermissionRequest → bridge/buddy-hook.js), so on-request lets Codex ask for escalations instead of failing them.
    const args = [exe, 'exec', '--json', '--skip-git-repo-check', '-s', ctx.agent ? 'workspace-write' : 'read-only', '-c', 'approval_policy="on-request"'];
    if (Codex.supports('--dangerously-bypass-hook-trust')) args.push('--dangerously-bypass-hook-trust'); // Buddy's own hook, written by Buddy
    if (ctx.workdir) args.push('-C', ctx.workdir);
    // attached pictures go to Codex as real images (it can look at them), not just as paths
    for (const f of (ctx.files || []).filter(f => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f) && fs.existsSync(f)).slice(-4)) args.push('--image=' + f);
    if (ctx.session) args.push('resume', ctx.session);
    args.push('-');
    const full = ctx.system && !ctx.session ? ctx.system + '\n\n' + prompt : prompt;
    let proc, getStderr;
    try { ({ proc, getStderr } = this.spawnCli(args, full, ctx.workdir)); } catch (e) { return emit('error', 'Could not start Codex: ' + e.message); }
    let text = '', hadError = false;
    await this.readJsonLines(proc, ev => {
      const kind = ev.type || '';
      if (kind === 'thread.started' && ev.thread_id) emit('session', ev.thread_id);
      else if (/^item\.(started|updated|completed)$/.test(kind)) {
        const item = ev.item || {}; const itype = item.type || item.item_type || '';
        if (itype === 'agent_message' || itype === 'assistant_message') {
          if (kind === 'item.completed' && item.text) { const sep = text ? '\n\n' : ''; text += sep + item.text; emit('text', sep + item.text); }
        } else if (STEP_NAMES[itype]) {
          if (itype === 'mcp_tool_call' && /^buddy$/i.test(String(item.server || ''))) return; // Buddy's own progress calls are not a user-visible step
          const detail = (item.command && cleanCommand(item.command)) || (item.changes || []).map(c => c.path || '').join(', ') || (item.server ? item.server + (item.tool ? ' · ' + item.tool : '') : '') || item.query || '';
          const status = kind === 'item.started' ? 'running' : (item.status === 'failed' ? 'error' : 'done');
          emit('step', { tool: STEP_NAMES[itype], detail: String(detail).slice(0, 120), status });
        }
      } else if (kind === 'turn.failed' || kind === 'error') {
        emit('error', 'Codex: ' + (ev.message || (ev.error && ev.error.message) || 'Codex turn failed.')); hadError = true; return false;
      }
    });
    const code = await this.waitExit(proc);
    this.finish(proc, getStderr, emit, text, hadError, code);
  }
}

function niceTool(name) { name = name || 'Tool'; return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name; }
class Claude extends Provider {
  constructor() { super(); this.name = 'claude'; this.label = 'Claude'; this.accent = '#fbbf77'; }
  static executable() {
    const home = os.homedir();
    return which(['claude'], [...cliCandidates('claude'), path.join(home, '.claude', 'local', 'claude')]);
  }
  async available() { const exe = Claude.executable(); return exe ? [true, path.basename(exe)] : [false, 'Claude Code CLI not found. Install it (https://claude.com/claude-code) and sign in once.']; }
  async run(prompt, ctx, emit) {
    const exe = Claude.executable();
    if (!exe) return emit('error', 'Claude Code CLI not found. Install it from https://claude.com/claude-code and run `claude` once to sign in.');
    const args = [exe, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    // Permissions are decided by Buddy's policy (src/policy.js) via --permission-prompt-tool: reads/searches, in-project edits
    // and local tests are auto-allowed there; secrets, outside-project changes, deletes, installs, git push, deploys and
    // external messages wait for Accept on Buddy. Nothing is pre-allowed here so every decision passes through the policy.
    args.push('--permission-mode', 'default');
    if (!ctx.agent) args.push('--allowedTools', 'Read,Glob,Grep,LS,WebSearch,WebFetch', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit');
    // Anything else (MCP tools such as Photoshop, Bash in Ask mode…) is asked on Buddy itself via the permission prompt tool.
    if (ctx.mcpConfig) args.push('--mcp-config', ctx.mcpConfig, '--permission-prompt-tool', 'mcp__buddy__buddy_permission');
    if (ctx.session) args.push('--resume', ctx.session);
    const full = ctx.system && !ctx.session ? ctx.system + '\n\n' + prompt : prompt;
    let proc, getStderr;
    try { ({ proc, getStderr } = this.spawnCli(args, full, ctx.workdir)); } catch (e) { return emit('error', 'Could not start Claude Code: ' + e.message); }
    let text = '', streamed = false, hadError = false;
    await this.readJsonLines(proc, ev => {
      const kind = ev.type || '';
      if (kind === 'system' && ev.session_id) emit('session', ev.session_id);
      else if (kind === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta' && inner.delta.text) { streamed = true; text += inner.delta.text; emit('text', inner.delta.text); }
        else if (inner.type === 'content_block_start' && inner.content_block && inner.content_block.type === 'tool_use' && !/^mcp__buddy__/.test(inner.content_block.name || '')) emit('step', { tool: niceTool(inner.content_block.name), detail: '', status: 'running' });
      } else if (kind === 'assistant' && !streamed) {
        for (const b of ((ev.message || {}).content || [])) {
          if (b.type === 'text' && b.text) { text += b.text; emit('text', b.text); }
          else if (b.type === 'tool_use' && !/^mcp__buddy__/.test(b.name || '')) { const i = b.input || {}; emit('step', { tool: niceTool(b.name), detail: String(i.file_path || i.pattern || i.query || i.command || '').slice(0, 120), status: 'running' }); }
        }
      } else if (kind === 'user') emit('step', { tool: '', detail: '', status: 'done' });
      else if (kind === 'result') {
        if (ev.session_id) emit('session', ev.session_id);
        if (ev.is_error) { emit('error', 'Claude: ' + (ev.result || ev.subtype || 'request failed')); hadError = true; }
        else if (!text && ev.result) { text = String(ev.result); emit('text', text); }
        return false;
      }
    });
    const code = await this.waitExit(proc);
    this.finish(proc, getStderr, emit, text, hadError, code);
  }
}

const PROVIDERS = { gemini: Gemini, codex: Codex, claude: Claude };
function make(name) { const C = PROVIDERS[name] || Gemini; return new C(); }
const ALL = [{ name: 'gemini', label: 'Gemini', accent: '#8ab4f8' }, { name: 'codex', label: 'Codex', accent: '#5eead4' }, { name: 'claude', label: 'Claude', accent: '#fbbf77' }];

function resetNpmCache() { npmBinCache = null; }
module.exports = { agyAllow, agyCandidates, Gemini, Codex, Claude, PROVIDERS, ALL, make, which, npmGlobalBin, resetNpmCache, spawnCompat, spawnSyncCompat, cmdQuote, shellLine, resolveNodeShim };
