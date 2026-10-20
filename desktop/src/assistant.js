'use strict';
// Assistant layer on top of Core: one-shot AI runs (background jobs, quick actions, workflows), picking the best AI,
// watchers (GitHub Actions, folders), Google Calendar meeting reminders, PC control tools with approval + an action log,
// knowledge folders + chat search, and Windows voice (dictation, "Hey Buddy").
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const providers = require('./providers');
const policy = require('./policy');

const IS_WIN = process.platform === 'win32';
const now = () => Date.now() / 1000;
const rid = () => Math.random().toString(16).slice(2, 10);
const MAX_JOBS = 40, MAX_PARALLEL = 2, MAX_LOG = 150;

// ------------------------------------------------------------------ picking an AI
// Codex for code, Claude for writing / analysis / long asks, Gemini for quick everyday questions — among installed ones.
const CODE_RE = /```|\b(code|coding|bug|debug|fix(es|ed)?|error|exception|stack ?trace|function|class|method|refactor|unit ?test|tests?|build|compile|script|repo|git|npm|node|unity|c#|csharp|javascript|typescript|python|html|css|shader|api|endpoint|regex|sql|json|lint|crash)\b|\.(js|ts|tsx|cs|py|html|css|json|java|cpp|go|rs)\b/i;
const WRITE_RE = /\b(write|draft|email|mail|letter|post|caption|copy|explain|summar(y|ise|ize)|analy[sz]e|analysis|plan|strategy|review|compare|research|report|essay|doc(ument)?|translate|proposal|brainstorm|ideas?|why|story|script for)\b/i;
function installed(name) { if (process.env.BUDDY_ONLY_PROVIDERS) return process.env.BUDDY_ONLY_PROVIDERS.split(',').includes(name); try { const C = providers.PROVIDERS[name]; return !!(C && C.executable && C.executable()); } catch { return false; } }
function pickProvider(text, opts = {}) {
  const avail = (opts.available || ['codex', 'claude', 'gemini'].filter(installed));
  const t = String(text || ''); let want;
  if (CODE_RE.test(t)) want = 'codex';
  else if (WRITE_RE.test(t) || t.length > 400) want = 'claude';
  else want = 'gemini';
  const order = { codex: ['codex', 'claude', 'gemini'], claude: ['claude', 'codex', 'gemini'], gemini: ['gemini', 'claude', 'codex'] }[want];
  return order.find(n => avail.includes(n)) || opts.fallback || avail[0] || 'claude';
}
const PICK_WHY = { codex: 'Codex is strongest at code', claude: 'Claude is strongest at writing and analysis', gemini: 'Gemini is quick for everyday questions' };

// ------------------------------------------------------------------ knowledge folders (tiny TF-IDF)
const TEXT_EXT = /\.(md|markdown|txt|json|js|ts|tsx|jsx|cs|py|html|css|yml|yaml|toml|ini|cfg|csv|xml|sql|sh|ps1|bat|cmd|java|kt|go|rs|cpp|c|h|hpp|lua|gd|shader|hlsl)$/i;
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|Library|Temp|obj|bin|\.vs|\.idea|__pycache__|venv|\.venv|Packages|Logs)$/i;
const tokens = s => (String(s).toLowerCase().match(/[a-z0-9؀-ۿ_]{2,}/g) || []).filter(w => w.length < 30);
class Knowledge {
  constructor() { this.chunks = []; this.df = new Map(); this.at = 0; this.roots = []; }
  build(roots, { maxFiles = 2500, maxBytes = 200 * 1024 } = {}) {
    this.chunks = []; this.df = new Map(); this.roots = roots.slice(); let files = 0;
    const walk = (dir, depth) => {
      if (depth > 8 || files >= maxFiles) return; let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files >= maxFiles) return; const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIR.test(e.name) && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
        if (!TEXT_EXT.test(e.name)) continue; let st; try { st = fs.statSync(p); } catch { continue; } if (st.size > maxBytes || st.size < 20) continue;
        let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; } files++;
        const lines = text.split(/\r?\n/); let buf = [], start = 1, len = 0;
        const flush = (end) => { if (!buf.length) return; const body = buf.join('\n'); const tf = new Map(); for (const w of tokens(body + ' ' + path.basename(p))) tf.set(w, (tf.get(w) || 0) + 1); for (const w of tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1); this.chunks.push({ file: p, line: start, end, text: body.slice(0, 1600), tf, n: [...tf.values()].reduce((a, b) => a + b, 0) || 1 }); buf = []; len = 0; };
        lines.forEach((l, i) => { if (!buf.length) start = i + 1; buf.push(l); len += l.length + 1; if (len > 900) flush(i + 1); });
        flush(lines.length);
      }
    };
    for (const r of roots) walk(r, 0);
    this.at = Date.now(); this.files = files; return { files, chunks: this.chunks.length };
  }
  search(query, k = 5) {
    const q = [...new Set(tokens(query))]; if (!q.length || !this.chunks.length) return [];
    const N = this.chunks.length; const idf = w => Math.log(1 + N / (1 + (this.df.get(w) || 0)));
    const scored = []; for (const c of this.chunks) { let s = 0, hit = 0; for (const w of q) { const f = c.tf.get(w); if (f) { s += (f / c.n) * idf(w) * 100; hit++; } } if (hit) scored.push({ c, s: s * (hit / q.length) }); }
    scored.sort((a, b) => b.s - a.s); return scored.slice(0, k).map(({ c, s }) => ({ file: c.file, line: c.line, end: c.end, score: +s.toFixed(2), text: c.text }));
  }
}

// ------------------------------------------------------------------ http helper (GitHub / Google)
function request(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'http:' ? http : https; const data = body == null ? null : JSON.stringify(body);
    const req = mod.request(u, { method, headers: { 'User-Agent': 'Buddy', Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }, timeout }, res => {
      let out = ''; res.on('data', d => out += d); res.on('end', () => { let j = null; try { j = out ? JSON.parse(out) : {}; } catch { j = { raw: out }; } if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else { const e = new Error((j && (j.message || (j.error && j.error.message))) || 'HTTP ' + res.statusCode); e.status = res.statusCode; reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timed out'))); if (data) req.write(data); req.end();
  });
}

// ------------------------------------------------------------------ PowerShell helpers (Windows)
function ps(script, { timeout = 15000, input = null } = {}) {
  return new Promise(resolve => {
    if (!IS_WIN && !process.env.BUDDY_FAKE_PS) return resolve({ ok: false, out: '', err: 'Only available on Windows.' });
    const exe = process.env.BUDDY_FAKE_PS || 'powershell.exe';
    const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '', err = ''; const t = setTimeout(() => { try { p.kill(); } catch { /* */ } }, timeout);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); resolve({ ok: false, out, err: e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
    if (input != null) { p.stdin.write(input); } p.stdin.end();
  });
}
const KEYS_PS = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class BK {
 [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
function Tap([byte[]]$ks){ foreach($k in $ks){ [BK]::keybd_event($k,0,0,[UIntPtr]::Zero) }; [Array]::Reverse($ks); foreach($k in $ks){ [BK]::keybd_event($k,0,2,[UIntPtr]::Zero) } }
`;
const VK = { ctrl: 0x11, shift: 0x10, win: 0x5B, c: 0x43, v: 0x56, h: 0x48, l: 0x4C, volup: 0xAF, voldown: 0xAE, mute: 0xAD, play: 0xB3, next: 0xB0, prev: 0xB1 };
const tapScript = (...ks) => KEYS_PS + `Tap @(${ks.map(k => '0x' + VK[k].toString(16)).join(',')})`;
// release modifiers the user may still be holding from the hotkey, then copy
// (only keys that are actually down: a lone Alt/Win key-up opens menus or Start). Prints the source window handle for Replace.
const COPY_SCRIPT = KEYS_PS + `Start-Sleep -Milliseconds 80; foreach($m in 0x10,0x11,0x12,0x5B,0xA0,0xA1,0xA2,0xA3){ if([BK]::GetAsyncKeyState($m) -band 0x8000){ [BK]::keybd_event([byte]$m,0,2,[UIntPtr]::Zero) } }; Start-Sleep -Milliseconds 40; Tap @(0x11,0x43); [Console]::Out.Write([int64][BK]::GetForegroundWindow())`;
const pasteScript = hwnd => KEYS_PS + (hwnd ? `[void][BK]::SetForegroundWindow([IntPtr]${Math.floor(Number(hwnd))}); Start-Sleep -Milliseconds 140; ` : '') + 'Tap @(0x11,0x56)';
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";
const ENGINE = `Add-Type -AssemblyName System.Speech
try { $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine } catch { [Console]::Error.Write('No speech recognizer installed.'); exit 4 }
if (-not $r) { [Console]::Error.Write('No speech recognizer installed.'); exit 4 }
try { $r.SetInputToDefaultAudioDevice() } catch { [Console]::Error.Write('No microphone found.'); exit 3 }`;

const DICTATE_SCRIPT = ENGINE + `
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(7); $r.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.3); $r.BabbleTimeout = [TimeSpan]::FromSeconds(4)
$res = $r.Recognize([TimeSpan]::FromSeconds(25)); if ($res) { [Console]::Out.Write($res.Text) }`;
const WAKE_SCRIPT = (phrase) => ENGINE + `
$c = New-Object System.Speech.Recognition.Choices; $c.Add(@(${psq(phrase)}, ${psq(phrase.replace(/^hey /i, 'ok '))}))
$gb = New-Object System.Speech.Recognition.GrammarBuilder; $gb.Culture = $r.RecognizerInfo.Culture; $gb.Append($c)
$r.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb)))
while ($true) { try { $res = $r.Recognize([TimeSpan]::FromSeconds(30)) } catch { [Console]::Error.Write('Recognition stopped: ' + $_); exit 5 }; if ($res -and $res.Confidence -ge 0.62) { [Console]::Out.WriteLine('WAKE ' + $res.Confidence); [Console]::Out.Flush() } }`;

// ------------------------------------------------------------------ workflow templates
const TEMPLATES = [
  { key: 'briefing', name: 'Morning briefing', description: "Today's meetings, unread mail, new chat messages and open tasks in one short summary.",
    steps: [{ type: 'ai', mode: 'ask', provider: 'claude', prompt: "Morning briefing for me. Use the tools you have: gcal_events (today), gmail_unread, gchat_unread and buddy_tasks. Skip any tool that isn't connected and say so in one line. Then give: 1) today's meetings with times, 2) emails/messages that need a reply (who + one line), 3) my open tasks, 4) the one thing to do first. Short bullets." }, { type: 'notify', text: 'Morning briefing ready — see Planner → Activity.' }] },
  { key: 'playable_qa', name: 'Playable ad QA', description: 'Check a single-file HTML playable: size limits, network calls, CTA and MRAID hooks.',
    steps: [{ type: 'ai', mode: 'ask', provider: 'codex', prompt: 'QA this playable ad build: {file}\nCheck and report pass/fail for: total size (AppLovin ≤ 5 MB, Mintegral ≤ 5 MB, Google Ads ≤ 5 MB / 512 files), external network requests (must be none except allowed CDNs), mraid.js / dapi hooks and mraid.open/install CTA wiring, console errors visible in the code, orientation handling, and missing assets. End with a short fix list.' }] },
  { key: 'build_watch', name: 'New build → summary', description: 'When a new build lands in a watched folder, summarise what changed.',
    steps: [{ type: 'ai', mode: 'ask', provider: '', prompt: 'A new file just appeared: {file}. Tell me in 3 bullets what it is, its size, and anything that looks wrong.' }] },
  { key: 'weekly', name: 'Weekly report', description: 'Summarise what Buddy and the AIs did this week, ready to paste.',
    steps: [{ type: 'ai', mode: 'ask', provider: 'claude', prompt: "Write my weekly report from Buddy's recent work log and my tasks (buddy_tasks). Group by project, 5–8 bullets, plain English, ready to paste in Slack." }] },
];

// ================================================================== Assistant
class Assistant {
  constructor(core) {
    this.core = core; this.state = core.state; this.knowledge = new Knowledge(); this.active = new Map(); this.queue = [];
    this.cancels = new Map(); this.fsWatchers = new Map(); this.gh = { seen: {}, timer: null, last: null, error: '' }; this.cal = { warned: new Set(), timer: null, error: '' };
    const s = this.state; if (!Array.isArray(s.jobs)) s.jobs = []; if (!Array.isArray(s.workflows)) s.workflows = []; if (!Array.isArray(s.actions)) s.actions = [];
  }
  get settings() { return this.state.settings; }
  ev(kind, p) { this.core.ev(kind, p); }
  save() { this.state.save(); }
  notifyPhone(text) { try { if (this.core.remote && this.core.remote.cfg.notify !== false) this.core.remote.notifyOwner(text); } catch { /* */ } }

  start() {
    this.rebuildKnowledge(); this.applyWatchers(); this.startGithub(); this.startCalendar(); this.startGchat(); this.applyWake();
    this.kTimer = setInterval(() => this.rebuildKnowledge(), 30 * 60 * 1000);
  }
  stop() {
    clearInterval(this.kTimer); clearInterval(this.gh.timer); clearInterval(this.cal.timer); clearInterval(this.gc && this.gc.timer);
    for (const w of this.fsWatchers.values()) { try { w.close(); } catch { /* */ } } this.fsWatchers.clear();
    for (const c of this.cancels.values()) { try { c(); } catch { /* */ } }
    this.stopWake(); if (this.dictation) { try { this.dictation.kill(); } catch { /* */ } }
  }

  // ---------------------------------------------------------------- one-shot AI runs
  resolveProvider(name, text) { if (name && providers.PROVIDERS[name]) return name; if (name === 'auto' || this.settings.auto_pick !== false) return pickProvider(text, { fallback: this.core.provider.name }); return this.core.provider.name; }
  oneShot(prompt, { provider, agent = false, system, onText, onStep, workdir } = {}) {
    const name = this.resolveProvider(provider, prompt); const p = providers.make(name);
    const ctx = { system: system != null ? system : this.core.systemPrompt(agent), history: [], session: '', workdir: workdir || this.settings.workdir || os.homedir(), files: [], agent, mcpConfig: this.core.mcpConfigFile() };
    let cancel; const done = new Promise(resolve => {
      let text = ''; let finished = false; const end = r => { if (!finished) { finished = true; resolve({ provider: name, ...r }); } };
      cancel = () => { try { p.cancel(); } catch { /* */ } end({ ok: false, text: text || 'Stopped.', stopped: true }); };
      p.run(prompt, ctx, (k, d) => { if (k === 'text') { text += d; onText && onText(d); } else if (k === 'step') onStep && onStep(d); else if (k === 'done') end({ ok: true, text: String(d || text) }); else if (k === 'error') end({ ok: false, text: String(d) }); })
        .catch(e => end({ ok: false, text: 'Unexpected error: ' + e.message }));
    });
    return { provider: name, done, cancel: () => cancel() };
  }

  // ---------------------------------------------------------------- background jobs (Planner → Activity)
  listJobs() { return this.state.jobs.map(({ cancel, ...j }) => j).sort((a, b) => b.started - a.started); }
  emitJobs() { this.ev('jobs', { jobs: this.listJobs() }); }
  addJob(j) { this.state.jobs.push(j); while (this.state.jobs.length > MAX_JOBS) { const i = this.state.jobs.findIndex(x => x.status !== 'running' && x.status !== 'queued'); if (i < 0) break; this.state.jobs.splice(i, 1); } this.save(); this.emitJobs(); }
  startJob({ title, prompt, provider = '', mode = 'ask', source = 'manual', steps = null, vars = {} }) {
    prompt = String(prompt || '').trim(); if (!prompt && !steps) throw new Error('Write what the AI should do.');
    const j = { id: rid(), title: String(title || prompt.split('\n')[0] || 'Job').slice(0, 90), prompt: prompt.slice(0, 4000), provider, mode: mode === 'do' ? 'do' : 'ask', source, status: 'queued', output: '', started: now(), ended: 0, steps: steps ? steps.map(s => ({ ...s, status: 'pending', output: '' })) : null, vars };
    this.addJob(j); this.pump(); return { ...j };
  }
  pump() {
    while (this.active.size < MAX_PARALLEL) { const j = this.state.jobs.find(x => x.status === 'queued'); if (!j) return; this.runJob(j); }
  }
  async runJob(j) {
    j.status = 'running'; j.started = now(); this.active.set(j.id, j); this.emitJobs();
    let ok = true;
    try {
      if (j.steps) ok = await this.runSteps(j);
      else { const r = await this.runAiInto(j, j.prompt, j.provider, j.mode); ok = r.ok; j.provider = r.provider; }
    } catch (e) { ok = false; j.output += (j.output ? '\n' : '') + 'Error: ' + e.message; }
    if (j.status === 'stopped') ok = false; else j.status = ok ? 'done' : 'error';
    j.ended = now(); this.active.delete(j.id); this.cancels.delete(j.id); this.save(); this.emitJobs();
    if (j.status !== 'stopped') {
      const first = (String(j.output).trim().split('\n').find(l => l.trim()) || '').slice(0, 120);
      this.ev('say', { agent: '', text: (ok ? 'Done: ' : 'Failed: ') + j.title, reaction: ok ? 'done' : 'error' });
      this.notifyPhone((ok ? '✅ ' : '⚠️ ') + j.title + (first ? '\n' + String(j.output).trim().slice(0, 1500) : ''));
    }
    this.pump();
    return j;
  }
  async runAiInto(j, prompt, provider, mode, stepRef) {
    let buf = ''; let tick = 0;
    const run = this.oneShot(prompt, { provider, agent: mode === 'do', onText: d => { buf += d; if (buf.length > 40000) buf = buf.slice(-30000); if (stepRef) stepRef.output = buf; else j.output = buf; if (Date.now() - tick > 400) { tick = Date.now(); this.ev('job.text', { id: j.id, output: j.output, steps: j.steps }); } } });
    this.cancels.set(j.id, run.cancel); if (!j.provider) j.provider = run.provider;
    const r = await run.done; const text = r.text;
    const keep = String(text).slice(-30000); if (stepRef) stepRef.output = keep; else j.output = keep;
    return r;
  }
  stopJob(id) {
    const j = this.state.jobs.find(x => x.id === id); if (!j) return false;
    if (j.status === 'queued') { j.status = 'stopped'; j.ended = now(); this.save(); this.emitJobs(); return true; }
    if (j.status === 'running') { j.status = 'stopped'; try { const c = this.cancels.get(j.id); c && c(); } catch { /* */ } return true; }
    return false;
  }
  clearJobs() { this.state.jobs = this.state.jobs.filter(j => j.status === 'running' || j.status === 'queued'); this.save(); this.emitJobs(); }

  // ---------------------------------------------------------------- workflows
  listWorkflows() { return this.state.workflows.slice(); }
  templates() { return TEMPLATES.map(t => ({ key: t.key, name: t.name, description: t.description, steps: t.steps })); }
  cleanSteps(steps) {
    const out = [];
    for (const s of Array.isArray(steps) ? steps : []) {
      const type = ['ai', 'cmd', 'notify', 'wait'].includes(s.type) ? s.type : 'ai';
      if (type === 'ai') { const prompt = String(s.prompt || '').trim(); if (!prompt) continue; out.push({ type, prompt: prompt.slice(0, 4000), mode: s.mode === 'do' ? 'do' : 'ask', provider: providers.PROVIDERS[s.provider] ? s.provider : '' }); }
      else if (type === 'cmd') { const command = String(s.command || '').trim(); if (command) out.push({ type, command: command.slice(0, 1000) }); }
      else if (type === 'notify') { const text = String(s.text || '').trim(); if (text) out.push({ type, text: text.slice(0, 300) }); }
      else out.push({ type, seconds: Math.max(1, Math.min(3600, parseInt(s.seconds, 10) || 5)) });
    }
    if (!out.length) throw new Error('Add at least one step.'); if (out.length > 12) throw new Error('A workflow can have at most 12 steps.');
    return out;
  }
  saveWorkflow(w) {
    w = w || {}; const name = String(w.name || '').trim().slice(0, 60); if (!name) throw new Error('Give the workflow a name.');
    const steps = this.cleanSteps(w.steps);
    let cur = w.id && this.state.workflows.find(x => x.id === w.id);
    if (cur) Object.assign(cur, { name, steps, description: String(w.description || '').slice(0, 200) });
    else { cur = { id: rid(), name, description: String(w.description || '').slice(0, 200), steps, created: now(), runs: 0 }; this.state.workflows.push(cur); }
    this.save(); this.ev('workflows', { workflows: this.listWorkflows() }); return cur;
  }
  addTemplate(key) { const t = TEMPLATES.find(x => x.key === key); if (!t) throw new Error('Unknown template.'); return this.saveWorkflow({ name: t.name, description: t.description, steps: t.steps }); }
  removeWorkflow(id) { const n = this.state.workflows.length; this.state.workflows = this.state.workflows.filter(w => w.id !== id); this.save(); this.ev('workflows', { workflows: this.listWorkflows() }); return n !== this.state.workflows.length; }
  runWorkflow(id, vars = {}, source = 'manual') {
    const w = this.state.workflows.find(x => x.id === id); if (!w) throw new Error('Unknown workflow.');
    w.runs = (w.runs || 0) + 1; w.last = now(); this.save();
    return this.startJob({ title: w.name + (vars.file ? ' · ' + path.basename(vars.file) : ''), prompt: '', steps: w.steps, source, vars });
  }
  fill(text, j, prev) { return String(text).replace(/\{prev\}/g, prev || '').replace(/\{file\}/g, (j.vars && j.vars.file) || '').replace(/\{date\}/g, new Date().toLocaleDateString()).replace(/\{folder\}/g, this.settings.workdir || os.homedir()); }
  async runSteps(j) {
    let prev = '';
    for (const s of j.steps) {
      if (j.status === 'stopped') return false;
      s.status = 'running'; this.ev('job.text', { id: j.id, output: j.output, steps: j.steps });
      let ok = true;
      if (s.type === 'ai') {
        let prompt = this.fill(s.prompt, j, prev); if (prev && !/\{prev\}/.test(s.prompt)) prompt += '\n\nOutput of the previous step:\n' + prev.slice(0, 6000);
        const r = await this.runAiInto(j, prompt, s.provider || j.provider, s.mode, s); ok = r.ok; prev = r.text;
      } else if (s.type === 'cmd') {
        const r = await this.runCommand(this.fill(s.command, j, prev), j.title, j.id); ok = r.ok; s.output = r.output; prev = r.output;
      } else if (s.type === 'notify') {
        const t = this.fill(s.text, j, prev); this.ev('say', { agent: '', text: t, reaction: 'speak' }); this.notifyPhone('🔔 ' + t); s.output = t;
      } else if (s.type === 'wait') { await new Promise(r => setTimeout(r, s.seconds * 1000)); s.output = `Waited ${s.seconds}s`; }
      s.status = ok ? 'done' : 'error';
      j.output = j.steps.map((x, i) => `#${i + 1} ${x.type.toUpperCase()}${x.status === 'error' ? ' (failed)' : ''}\n${String(x.output || '').trim()}`).filter(Boolean).join('\n\n');
      this.ev('job.text', { id: j.id, output: j.output, steps: j.steps });
      if (!ok) return false;
    }
    return true;
  }
  runCommand(command, why, jobId) {
    return new Promise(async resolve => {
      const wd = this.settings.workdir || os.homedir();
      const verdict = policy.classify('Bash', { command }, { workdir: wd, dataDir: this.core.folder });
      if (verdict.kind !== 'auto') { const ok = await this.approve({ title: verdict.title, detail: command, reason: `Workflow "${why}" wants to run this command. ` + (verdict.reason || ''), nice: 'Workflow command' }); if (!ok) { this.log('cmd', command, 'rejected', false); return resolve({ ok: false, output: 'Rejected in Buddy.' }); } }
      const sh = IS_WIN ? 'cmd.exe' : '/bin/sh'; const args = IS_WIN ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
      const p = spawn(sh, args, { cwd: wd, windowsHide: true, windowsVerbatimArguments: IS_WIN }); let out = '';
      const kill = () => { try { IS_WIN ? spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }) : p.kill(); } catch { /* */ } };
      const t = setTimeout(kill, 10 * 60 * 1000); if (jobId) this.cancels.set(jobId, kill);
      p.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-100000); }); p.stderr.on('data', d => out += d);
      p.on('error', e => { clearTimeout(t); resolve({ ok: false, output: e.message }); });
      p.on('close', code => { clearTimeout(t); this.log('cmd', command, code === 0 ? 'ok' : 'exit ' + code, true); resolve({ ok: code === 0, output: out.trim().slice(-8000) + (code ? `\n(exit code ${code})` : '') }); });
    });
  }

  // ---------------------------------------------------------------- approvals + action log
  approve({ title, detail, reason, nice = 'Buddy' }) {
    return this.core.askPermission({ tool_name: 'buddy_action', input: { __approval: true, title, detail, reason, nice } }).then(r => r && r.behavior === 'allow');
  }
  log(tool, target, result, approved) { this.state.actions.push({ at: now(), tool, target: String(target || '').slice(0, 200), result: String(result || '').slice(0, 120), approved: !!approved }); if (this.state.actions.length > MAX_LOG) this.state.actions = this.state.actions.slice(-MAX_LOG); this.save(); this.ev('actions', { actions: this.state.actions.slice(-60).reverse() }); }
  listActions() { return this.state.actions.slice(-60).reverse(); }

  // ---------------------------------------------------------------- PC control (MCP tools)
  async tool(name, args) {
    args = args || {};
    switch (name) {
      case 'buddy_open': return this.open(String(args.target || ''));
      case 'buddy_system': return this.system(String(args.action || ''));
      case 'buddy_clipboard': return this.clipboard(args);
      case 'buddy_knowledge': return { results: this.knowledge.search(String(args.query || ''), Math.min(10, args.limit || 5)).map(r => ({ file: r.file, lines: `${r.line}-${r.end}`, text: r.text.slice(0, 900) })), indexed_files: this.knowledge.files || 0 };
      case 'buddy_background': { const j = this.startJob({ title: args.title, prompt: args.prompt, mode: args.mode, provider: args.provider || '', source: 'ai' }); return { started: true, id: j.id, note: 'Runs in the background; the user sees it in Buddy → Planner → Activity.' }; }
      default: return undefined;
    }
  }
  async open(target) {
    target = target.trim(); if (!target) throw new Error('target is required (URL, file/folder path or app name).');
    const shell = this.core.shell; if (!shell) throw new Error('Opening things needs the Buddy desktop app.');
    const wd = this.settings.workdir || os.homedir();
    if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); this.log('open', target, 'url', true); return { opened: target }; }
    const isPath = /^([a-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/i.test(target) || fs.existsSync(target);
    if (isPath) {
      const p = path.resolve(target.replace(/^~(?=[\\/])/, os.homedir()), ''); if (!fs.existsSync(p)) throw new Error('Not found: ' + p);
      const risky = this.core.isRisky(p); const insideWd = policy.inside(p, wd) || fs.statSync(p).isDirectory();
      if (risky || !insideWd) { const ok = await this.approve({ title: risky ? 'Open a program/script file' : 'Open a file outside the project', detail: p, reason: risky ? 'This file can run code on your PC.' : `Only files in the working folder (${wd}) open without asking.`, nice: 'Open' }); if (!ok) { this.log('open', p, 'rejected', false); return { opened: false, reason: 'The user rejected it in Buddy.' }; } }
      const err = await shell.openPath(p); this.log('open', p, err || 'ok', true); if (err) throw new Error(err); return { opened: p };
    }
    // app by name → Windows "start" (approval: launching programs)
    const ok = await this.approve({ title: 'Open an app', detail: target, reason: 'Starting programs needs your Accept.', nice: 'Open app' });
    if (!ok) { this.log('open-app', target, 'rejected', false); return { opened: false, reason: 'The user rejected it in Buddy.' }; }
    if (!IS_WIN) throw new Error('Opening apps by name works on Windows.');
    const r = await ps(`Start-Process -FilePath ${JSON.stringify(target)}`); this.log('open-app', target, r.ok ? 'ok' : r.err, true); if (!r.ok) throw new Error(r.err || 'Could not start ' + target); return { opened: target };
  }
  async system(action) {
    const map = { volume_up: ['volup', 'volup', 'volup'], volume_down: ['voldown', 'voldown', 'voldown'], mute: ['mute'], media_play_pause: ['play'], media_next: ['next'], media_previous: ['prev'] };
    if (map[action]) { const r = await ps(map[action].map(k => tapScript(k)).join('\n')); this.log('system', action, r.ok ? 'ok' : r.err, true); return { done: r.ok, action, error: r.ok ? undefined : r.err }; }
    if (action === 'screenshot') { const f = await this.core.screenshotToFile(); this.log('system', 'screenshot', f ? 'ok' : 'failed', true); if (!f) throw new Error('Screenshot failed.'); this.core.attach([f]); return { saved: f, attached: true }; }
    if (action === 'lock') {
      const ok = await this.approve({ title: 'Lock the PC', detail: 'Windows lock screen', reason: 'Locking needs your Accept.', nice: 'Lock' }); if (!ok) { this.log('system', 'lock', 'rejected', false); return { done: false, reason: 'rejected' }; }
      const r = await ps('rundll32.exe user32.dll,LockWorkStation'); this.log('system', 'lock', r.ok ? 'ok' : r.err, true); return { done: r.ok };
    }
    throw new Error('Unknown action. Use volume_up, volume_down, mute, media_play_pause, media_next, media_previous, screenshot or lock.');
  }
  clipboard(args) {
    const cb = this.core.clipboard; if (!cb) throw new Error('Clipboard needs the Buddy desktop app.');
    if (args.text != null) { cb.writeText(String(args.text).slice(0, 100000)); this.log('clipboard', 'write ' + String(args.text).length + ' chars', 'ok', true); return { copied: true }; }
    return { text: cb.readText().slice(0, 20000) };
  }

  // ---------------------------------------------------------------- quick actions (global hotkey)
  async captureSelection() {
    const cb = this.core.clipboard; if (!cb) return { text: '', from: 'none' };
    const before = cb.readText(); let text = '', from = 'clipboard', hwnd = 0;
    const snap = { text: before }; try { const fm = cb.availableFormats() || []; if (fm.some(f => /html/i.test(f))) snap.html = cb.readHTML(); if (fm.some(f => /rtf/i.test(f))) snap.rtf = cb.readRTF(); if (fm.some(f => /image/i.test(f))) { const im = cb.readImage(); if (!im.isEmpty()) snap.image = im; } } catch { /* */ }
    if (IS_WIN) {
      cb.writeText(''); const r = await ps(COPY_SCRIPT, { timeout: 10000 }); hwnd = parseInt(r.out, 10) || 0;
      for (let i = 0; i < 14 && !(text = cb.readText()); i++) await new Promise(res => setTimeout(res, 60));
      if (!(r.ok && text)) text = ''; else from = 'selection';
      // put back what the user had copied (text, rich text, a picture). Copied files can't be restored from here.
      try { if (snap.text || snap.html || snap.rtf || snap.image) cb.write(snap); else cb.clear(); } catch { /* */ }
    }
    if (!text) { text = before || ''; from = text ? 'clipboard' : 'none'; }
    return { text: text.slice(0, 20000), from, hwnd };
  }
  quickPrompt(action, text, extra) {
    const t = String(text || '').trim(); const P = {
      explain: 'Explain this simply and briefly (same language as the text if it is not English, else English):', fix: 'Fix the grammar, spelling and flow of this text. Keep its meaning, tone and language. Reply with ONLY the corrected text:',
      translate: `Translate this into ${extra || 'English (if it is already English, into Roman Urdu)'}. Reply with ONLY the translation:`, reply: 'Write a short, friendly, natural reply to this message, in the same language. Reply with ONLY the reply text:',
      summarise: 'Summarise this in 3–5 short bullets:', shorter: 'Make this shorter and clearer. Reply with ONLY the new text:', code: 'Review this code: what it does, bugs or risks, and a fixed version if needed. Be brief.' };
    if (action === 'ask') return `${String(extra || '').trim()}\n\n---\n${t}`;
    return `${P[action] || P.explain}\n\n${t}`;
  }
  quick(action, text, extra) {
    if (this.quickRun) { try { this.quickRun.cancel(); } catch { /* */ } }
    const prompt = this.quickPrompt(action, text, extra);
    const sys = `You are ${this.core.assistantName}, a quick writing/coding helper. Do exactly the requested transformation. No preamble, no sign-off.`;
    const run = this.oneShot(prompt, { provider: action === 'code' ? 'auto' : '', system: sys, onText: d => this.ev('quick.text', { chunk: d }) });
    this.quickRun = run; this.ev('quick.begin', { action, provider: run.provider });
    run.done.then(r => { if (this.quickRun === run) this.quickRun = null; this.log('quick', action + ' · ' + String(text).slice(0, 40), r.ok ? 'ok' : 'failed', true); this.ev('quick.done', { ok: r.ok, text: r.text, provider: r.provider, stopped: !!r.stopped }); });
    return { provider: run.provider };
  }
  quickStop() { if (this.quickRun) { this.quickRun.cancel(); this.quickRun = null; } }

  // ---------------------------------------------------------------- knowledge + chat search
  knowledgeRoots() { const k = this.settings.knowledge; return Array.isArray(k) ? k.filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) : []; }
  rebuildKnowledge() { try { const r = this.knowledge.build(this.knowledgeRoots()); this.ev('knowledge', this.knowledgeStatus()); return r; } catch (e) { return { error: e.message }; } }
  knowledgeStatus() { return { folders: this.settings.knowledge || [], files: this.knowledge.files || 0, chunks: this.knowledge.chunks.length, at: this.knowledge.at }; }
  setKnowledge(folders) { this.settings.knowledge = [...new Set((folders || []).map(String).filter(Boolean))].slice(0, 12); this.save(); this.rebuildKnowledge(); return this.knowledgeStatus(); }
  knowledgeContext(text) {
    if (!this.knowledge.chunks.length) return ''; const hits = this.knowledge.search(text, 3).filter(h => h.score >= 1.2); if (!hits.length) return '';
    return 'Possibly relevant notes from the user\'s knowledge folders (use only if they help; cite the file):\n' + hits.map(h => `--- ${h.file} (lines ${h.line}-${h.end})\n${h.text.slice(0, 900)}`).join('\n');
  }
  searchChats(q, limit = 40) {
    q = String(q || '').trim().toLowerCase(); if (q.length < 2) return [];
    const words = q.split(/\s+/).filter(Boolean); const out = [];
    for (let i = this.state.chat.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.state.chat[i]; if (m.role !== 'user' && m.role !== 'assistant') continue; const t = String(m.text || ''); const low = t.toLowerCase();
      if (!words.every(w => low.includes(w))) continue; const at = low.indexOf(words[0]); const s = Math.max(0, at - 60);
      out.push({ index: i, provider: m.provider, role: m.role, at: m.at, snippet: (s ? '…' : '') + t.slice(s, s + 220).replace(/\s+/g, ' ') + (t.length > s + 220 ? '…' : '') });
    }
    return out;
  }

  // ---------------------------------------------------------------- folder watchers
  listWatchers() { return Array.isArray(this.settings.watch_folders) ? this.settings.watch_folders : []; }
  saveWatcher(w) {
    w = w || {}; let dir = String(w.path || '').trim(); if (!dir) throw new Error('Pick a folder to watch.'); try { if (!fs.statSync(dir).isDirectory()) throw 0; } catch { throw new Error('That folder does not exist.'); }
    const list = this.listWatchers(); const action = ['notify', 'ai', 'workflow'].includes(w.action) ? w.action : 'notify';
    if (action === 'ai' && !String(w.prompt || '').trim()) throw new Error('Write what the AI should do with new files.');
    if (action === 'workflow' && !this.state.workflows.find(x => x.id === w.workflow)) throw new Error('Pick a workflow.');
    const item = { id: w.id || rid(), path: dir, pattern: String(w.pattern || '*').trim() || '*', action, prompt: String(w.prompt || '').slice(0, 2000), workflow: w.workflow || '', enabled: w.enabled !== false };
    const i = list.findIndex(x => x.id === item.id); if (i >= 0) list[i] = item; else list.push(item);
    this.settings.watch_folders = list; this.save(); this.applyWatchers(); this.ev('watchers', { watchers: list }); return item;
  }
  removeWatcher(id) { this.settings.watch_folders = this.listWatchers().filter(w => w.id !== id); this.save(); this.applyWatchers(); this.ev('watchers', { watchers: this.settings.watch_folders }); return true; }
  globRe(pattern) { const parts = String(pattern).split(/[,;\s]+/).filter(Boolean); return new RegExp('^(' + parts.map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|') + ')$', 'i'); }
  applyWatchers() {
    for (const [id, w] of this.fsWatchers) { try { w.close(); } catch { /* */ } this.fsWatchers.delete(id); }
    for (const w of this.listWatchers()) {
      if (!w.enabled) continue; const re = this.globRe(w.pattern); const pending = new Map();
      let fw; try { fw = fs.watch(w.path, { recursive: IS_WIN || process.platform === 'darwin' }, (type, file) => {
        if (!file) return; const base = path.basename(String(file)); if (/^~\$|\.(tmp|crdownload|part|swp)$|^\./i.test(base) || !re.test(base)) return;
        const full = path.join(w.path, String(file)); clearTimeout(pending.get(full));
        const fire = prev => { let st; try { st = fs.statSync(full); } catch { pending.delete(full); return; } if (!st.isFile()) { pending.delete(full); return; }
          if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) return pending.set(full, setTimeout(() => fire(st), 1500)); // still being written
          try { fs.closeSync(fs.openSync(full, 'r+')); } catch { return pending.set(full, setTimeout(() => fire(st), 1500)); } // locked by the writer
          pending.delete(full); this.onNewFile(w, full, st); };
        pending.set(full, setTimeout(() => fire(null), 1200));
      }); } catch (e) { this.ev('say', { agent: '', text: 'Could not watch ' + w.path + ': ' + e.message, reaction: 'error' }); continue; }
      fw.on('error', () => { /* folder vanished */ }); this.fsWatchers.set(w.id, fw);
    }
  }
  onNewFile(w, file, st) {
    this.seenFiles = this.seenFiles || new Map(); const key = file + '|' + st.size + '|' + Math.floor(st.mtimeMs / 1000); if (this.seenFiles.get(file) === key) return; this.seenFiles.set(file, key);
    const name = path.basename(file); const size = st.size > 1048576 ? (st.size / 1048576).toFixed(1) + ' MB' : Math.ceil(st.size / 1024) + ' KB';
    this.addFeed('folder', `New file in ${path.basename(w.path)}: ${name} (${size})`, file);
    this.ev('say', { agent: '', text: `New file: ${name} (${size})`, reaction: 'receive' }); this.notifyPhone(`📁 New file in ${path.basename(w.path)}: ${name} (${size})`);
    if (w.action === 'ai') this.startJob({ title: 'New file · ' + name, prompt: w.prompt.replace(/\{file\}/g, file) + (/\{file\}/.test(w.prompt) ? '' : '\n\nFile: ' + file), source: 'watch' });
    if (w.action === 'workflow') { try { this.runWorkflow(w.workflow, { file }, 'watch'); } catch { /* deleted */ } }
  }
  addFeed(kind, text, link) { this.state.jobs.push({ id: rid(), title: text.slice(0, 120), prompt: '', provider: '', mode: 'ask', source: kind, status: 'event', output: link || '', started: now(), ended: now() }); while (this.state.jobs.length > MAX_JOBS) this.state.jobs.shift(); this.save(); this.emitJobs(); }

  // ---------------------------------------------------------------- GitHub Actions watcher
  ghConfig() { const g = this.settings.github || {}; return { token: g.token || '', repos: Array.isArray(g.repos) ? g.repos : [], enabled: g.enabled !== false }; }
  setGithub(c) {
    c = c || {}; const cur = this.ghConfig(); const repos = String(Array.isArray(c.repos) ? c.repos.join(',') : (c.repos ?? cur.repos.join(','))).split(/[\s,]+/).map(s => s.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '')).filter(s => /^[\w.-]+\/[\w.-]+$/.test(s));
    this.settings.github = { token: c.token != null ? String(c.token).trim() : cur.token, repos: [...new Set(repos)].slice(0, 10), enabled: c.enabled != null ? !!c.enabled : cur.enabled };
    this.save(); this.gh.seen = {}; this.startGithub(); return this.githubStatus();
  }
  githubStatus() { const c = this.ghConfig(); return { repos: c.repos, has_token: !!c.token, enabled: c.enabled, last: this.gh.last, error: this.gh.error, runs: this.gh.runs || [] }; }
  startGithub() { clearInterval(this.gh.timer); const c = this.ghConfig(); if (!c.enabled || !c.repos.length) return; this.pollGithub(true); this.gh.timer = setInterval(() => this.pollGithub(false), Number(process.env.BUDDY_GH_POLL_MS) || 90000); }
  async pollGithub(first) {
    const c = this.ghConfig(); const API = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, ''); const runs = [];
    for (const repo of c.repos) {
      try {
        const r = await request(`${API}/repos/${repo}/actions/runs?per_page=6`, { headers: { Accept: 'application/vnd.github+json', ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) } });
        for (const run of (r.workflow_runs || [])) {
          const key = repo + '#' + run.id; const prev = this.gh.seen[key]; const st = run.status === 'completed' ? (run.conclusion || 'completed') : run.status;
          runs.push({ repo, id: run.id, name: run.name || run.display_title, title: run.display_title || '', branch: run.head_branch, status: st, url: run.html_url, at: run.updated_at });
          if (!first && prev !== st) {
            if (st === 'in_progress' && !prev) this.addFeed('github', `▶ ${repo}: ${run.name} started (${run.head_branch})`, run.html_url);
            if (run.status === 'completed') {
              const good = run.conclusion === 'success'; const msg = `${good ? '✅' : '❌'} ${repo}: ${run.name} ${run.conclusion}${run.head_branch ? ' (' + run.head_branch + ')' : ''}`;
              this.addFeed('github', msg, run.html_url); this.ev('say', { agent: '', text: msg, reaction: good ? 'done' : 'error' }); this.notifyPhone(msg + '\n' + run.html_url);
            }
          }
          this.gh.seen[key] = st;
        }
        this.gh.error = '';
      } catch (e) { this.gh.error = `${repo}: ${e.status === 404 ? 'not found (private repo? add a token)' : e.status === 401 ? 'token rejected' : e.message}`; }
    }
    this.gh.last = now(); this.gh.runs = runs.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12); this.ev('github', this.githubStatus());
  }

  // ---------------------------------------------------------------- Google Calendar → meeting reminders
  startCalendar() { clearInterval(this.cal.timer); this.cal.timer = setInterval(() => this.pollCalendar(), Number(process.env.BUDDY_CAL_POLL_MS) || 5 * 60 * 1000); setTimeout(() => this.pollCalendar(), 8000); }
  async calendarEvents(hours = 24) {
    const oauth = require('./bridge/google-oauth'); const file = path.join(this.core.folder, 'google-chat.json'); if (!fs.existsSync(file)) throw new Error('Google is not connected (Connect → Google).');
    const token = await oauth.accessToken(file); const API = (process.env.GCAL_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');
    const q = new URLSearchParams({ timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + hours * 3600e3).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
    const r = await oauth.request(`${API}/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: 'Bearer ' + token } });
    return (r.items || []).filter(e => e.status !== 'cancelled' && e.start && e.start.dateTime).map(e => ({ id: e.id, title: e.summary || '(no title)', start: e.start.dateTime, end: e.end && e.end.dateTime, link: e.hangoutLink || (e.conferenceData && e.conferenceData.entryPoints && (e.conferenceData.entryPoints.find(x => x.entryPointType === 'video') || {}).uri) || e.htmlLink || '' }));
  }
  async pollCalendar() {
    if (this.settings.meeting_reminders === false) return; const file = path.join(this.core.folder, 'google-chat.json'); if (!fs.existsSync(file)) return;
    try {
      const lead = (this.settings.meeting_lead_min || 10) * 60;
      for (const e of await this.calendarEvents(3)) {
        const start = Date.parse(e.start) / 1000; const key = e.id + '|' + e.start; if (this.cal.warned.has(key)) continue;
        const remindAt = start - lead; if (remindAt - now() > 6 * 60) continue; // next poll will catch it
        this.cal.warned.add(key);
        const when = new Date(start * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const msg = `Meeting at ${when}: ${e.title}${e.link ? ' — ' + e.link : ''}`; if (this.state.reminders.some(r => r.message === msg)) continue; // already set (e.g. before a restart)
        try { this.state.addReminderAt(Math.max(Math.floor(now()) + 1, Math.floor(remindAt)), msg); } catch { /* past */ }
      }
      this.cal.error = '';
    } catch (e) { this.cal.error = /insufficient|scope|403/i.test(e.message) ? 'Sign in to Google again to allow Calendar.' : e.message; }
  }

  // ---------------------------------------------------------------- Google Chat → notifications in Buddy
  // Polls the user's spaces (one cheap spaces.list; messages only for spaces active since the last check).
  // DMs and @mentions by default ("all" = every space). Your own messages never notify.
  gchatApi() { const g = require('./bridge/google-chat-mcp').api; g.useTokenFile(path.join(this.core.folder, 'google-chat.json')); return g; }
  startGchat() {
    this.gc = this.gc || { timer: null, since: 0, unread: [], error: '', self: '' }; clearInterval(this.gc.timer);
    this.gc.timer = setInterval(() => this.pollGchat().catch(() => {}), Number(process.env.BUDDY_GCHAT_POLL_MS) || 20000);
    setTimeout(() => this.pollGchat().catch(() => {}), 5000);
  }
  gchatMode() { const m = this.settings.gchat_notify; return m === 'off' || m === 'all' ? m : 'direct'; }
  async pollGchat() {
    if (this.gc.busy || this.gchatMode() === 'off' || !fs.existsSync(path.join(this.core.folder, 'google-chat.json'))) return;
    this.gc.busy = true;
    try {
      const g = this.gchatApi(); const startedAt = new Date().toISOString();
      if (!this.gc.since) { this.gc.since = startedAt; return; } // first check: only messages from now on
      if (!this.gc.self) this.gc.self = await g.selfUserId();
      const raw = await g.rawSpaces(); const labels = new Map((await g.spaces()).map(s => [s.id, s.name]));
      const active = raw.filter(s => s.lastActiveTime && s.lastActiveTime > this.gc.since).slice(0, 15);
      const mode = this.gchatMode(); const fresh = [];
      for (const s of active) {
        const direct = s.spaceType === 'DIRECT_MESSAGE';
        let ms = []; try { ms = await g.messages(s.name, 10, this.gc.since); } catch { continue; }
        for (const m of ms) {
          if (!m.text && !m.attachments.length) continue; if (this.gc.self && m.from_id === this.gc.self) continue;
          const mention = !!(this.gc.self && m.mentions.includes(this.gc.self));
          if (mode === 'direct' && !direct && !mention && s.spaceType !== 'GROUP_CHAT') continue;
          fresh.push({ id: m.id, space: s.name, space_name: labels.get(s.name) || s.displayName || 'Google Chat', direct, mention, from: m.from || 'Someone', text: (m.text || '[' + m.attachments.join(', ') + ']').slice(0, 600), thread: m.thread, time: m.time });
        }
      }
      this.gc.since = startedAt; this.gc.error = '';
      for (const n of fresh.sort((a, b) => String(a.time).localeCompare(String(b.time)))) {
        if (this.gc.unread.some(x => x.id === n.id)) continue;
        this.gc.unread.push(n); this.gc.unread = this.gc.unread.slice(-30);
        this.ev('gchat.message', n);
      }
      if (fresh.length) this.ev('gchat.unread', { unread: this.gc.unread.length });
    } catch (e) { this.gc.error = /insufficient|scope|403/i.test(e.message) ? 'Sign in to Google again (Connect → Google).' : e.message; }
    finally { this.gc.busy = false; }
  }
  gchatUnread() { return { unread: (this.gc && this.gc.unread) || [], error: (this.gc && this.gc.error) || '', mode: this.gchatMode() }; }
  gchatClear(id) { if (!this.gc) return; this.gc.unread = id ? this.gc.unread.filter(x => x.id !== id) : []; this.ev('gchat.unread', { unread: this.gc.unread.length }); }
  async gchatReply(space, text, thread, id) {
    // the user typed this reply themselves in Buddy's card → sent as them, no extra approval
    const r = await this.gchatApi().send(space, text, thread); this.gchatClear(id); this.log('gchat', 'reply in ' + space, 'sent', true); return r;
  }

  // ---------------------------------------------------------------- voice (Windows)
  async dictate() {
    if (this.settings.dictation === 'offline') {
      if (this.dictation) return { error: 'Already listening.' };
      this.ev('voice', { state: 'listening' });
      const r = await new Promise(resolve => { const exe = process.env.BUDDY_FAKE_PS || 'powershell.exe'; if (!IS_WIN && !process.env.BUDDY_FAKE_PS) return resolve({ ok: false, err: 'Voice input works on Windows.' }); const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DICTATE_SCRIPT], { windowsHide: true }); this.dictation = p; let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('error', e => resolve({ ok: false, err: e.message })); p.on('close', c => resolve({ ok: c === 0, out: out.trim(), err: err.trim() })); });
      this.dictation = null; this.ev('voice', { state: 'idle' });
      if (!r.ok) return { error: /No speech recognizer/.test(r.err) ? 'Windows speech recognition is not installed (Settings → Time & language → Speech).' : /No microphone/.test(r.err) ? 'No microphone found.' : /recognizer|Recognition/i.test(r.err) ? 'Windows speech recognition is not installed (Settings → Time & language → Speech).' : (r.err || 'Voice input failed.').slice(0, 200) };
      return { text: r.out };
    }
    // Windows voice typing (Win+H): types straight into the focused Buddy box, many languages
    const r = await ps(tapScript('win', 'h'), { timeout: 10000 }); return r.ok ? { started: true, mode: 'windows' } : { error: r.err || 'Voice typing needs Windows 10/11.' };
  }
  stopDictation() { if (this.dictation) { try { this.dictation.kill(); } catch { /* */ } this.dictation = null; } }
  applyWake() {
    const on = !!this.settings.wake_word && (IS_WIN || process.env.BUDDY_FAKE_PS);
    if (!on) return this.stopWake(); if (this.wake) return;
    const exe = process.env.BUDDY_FAKE_PS || 'powershell.exe'; const phrase = 'hey ' + String(this.core.assistantName || 'buddy').toLowerCase();
    const p = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WAKE_SCRIPT(phrase)], { windowsHide: true }); this.wake = p; let buf = '';
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (/^WAKE/.test(line) && Date.now() - (this.lastWake || 0) > 2500) { this.lastWake = Date.now(); this.ev('wake', {}); } } });
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('close', () => { if (this.wake === p) { this.wake = null; if (err) this.ev('say', { agent: '', text: '"Hey Buddy" stopped: ' + (/No speech recognizer/.test(err) ? 'Windows speech recognition is not installed.' : /microphone/i.test(err) ? 'no microphone found.' : 'the microphone stopped responding.'), reaction: 'error' }); } });
  }
  stopWake() { if (this.wake) { const p = this.wake; this.wake = null; try { p.kill(); } catch { /* */ } } }
}

module.exports = { Assistant, Knowledge, pickProvider, PICK_WHY, TEMPLATES, ps, tapScript, pasteScript, COPY_SCRIPT, WAKE_SCRIPT };
