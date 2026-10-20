'use strict';
// Persistent JSON state + agent activity + the tool surface used by the MCP bridge.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const AGENTS = ['claude', 'codex', 'gemini'];
const STATES = ['idle', 'working', 'waiting', 'done', 'error'];
const TEXT_TYPES = new Set(['.txt', '.md', '.markdown', '.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.csv', '.tsv', '.log',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.cs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.rs', '.go', '.rb',
  '.php', '.sh', '.bat', '.cmd', '.ps1', '.xml', '.sql', '.env', '.gitignore', '.svg', '']);
const MAX_READ = 32 * 1024, MAX_STEPS = 12, MAX_CHAT = 2000, ACTIVITY_TTL = 90, HEARTBEAT_TTL = 25;

const DEFAULTS = {
  assistant_name: 'Buddy', boss_name: 'Boss', display_mode: 'notch', provider: 'claude',
  workdir: '', autostart: false,
  sessions: {}, pet_pos: null, agent_mode: false, reduce_motion: false, always_allow: [], notch_lock: false, pet_lock: false, auto_update: true, skin: 'classic', auto_pick: true, voice_replies: false, voice_name: '', dictation: 'windows', wake_word: false, quick_hotkey: true, quick_hotkey_accel: '', meeting_reminders: true, gchat_notify: 'direct', meeting_lead_min: 10, knowledge: [], watch_folders: [], github: null,
};

const now = () => Date.now() / 1000;
const id = () => crypto.randomBytes(4).toString('hex');
const REPEATS = ['', 'hourly', 'daily', 'weekdays', 'weekly'];
// next occurrence after `at` (seconds) for a repeat rule, always strictly in the future; local time so "daily 9:00" stays 9:00
function nextAt(at, repeat, from = now()) {
  if (!repeat) return at;
  let d = new Date(at * 1000); const step = () => {
    if (repeat === 'hourly') d = new Date(d.getTime() + 3600e3);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else { d.setDate(d.getDate() + 1); if (repeat === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); }
  };
  let guard = 0; do { step(); } while (d.getTime() / 1000 <= from && ++guard < 100000);
  return Math.floor(d.getTime() / 1000);
}

class State extends EventEmitter {
  constructor(folder) {
    super();
    this.folder = folder;
    fs.mkdirSync(folder, { recursive: true });
    this.path = path.join(folder, 'state.json');
    this.files = []; this.tasks = []; this.reminders = []; this.schedules = []; this.jobs = []; this.workflows = []; this.actions = []; this.chat = [];
    this.settings = { ...DEFAULTS, sessions: {} };
    this.agents = Object.fromEntries(AGENTS.map(a => [a, this.blankAgent()]));
    this.load();
  }
  blankAgent() { return { state: 'idle', message: '', at: 0, heartbeat: 0, session: '', steps: [] }; }
  load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { return; }
    if (!data || typeof data !== 'object') return;
    this.files = (data.files || []).filter(f => typeof f === 'string' && fs.existsSync(f));
    this.tasks = (data.tasks || []).filter(t => t && t.text);
    this.reminders = (data.reminders || []).filter(r => r && r.at);
    this.schedules = (data.schedules || []).filter(s => s && s.prompt && s.at);
    this.workflows = (data.workflows || []).filter(w => w && w.name && Array.isArray(w.steps));
    this.actions = (data.actions || []).slice(-150);
    // jobs that were running when Buddy closed can't resume
    this.jobs = (data.jobs || []).filter(j => j && j.id).map(j => (j.status === 'running' || j.status === 'queued') ? { ...j, status: 'error', ended: j.ended || now(), output: (j.output ? j.output + '\n' : '') + '(Buddy was closed before this finished.)' } : j).slice(-40);
    this.chat = (data.chat || []).slice(-MAX_CHAT);
    for (const k of Object.keys(DEFAULTS)) if (data.settings && k in data.settings) this.settings[k] = data.settings[k];
    if (!['claude', 'codex', 'gemini'].includes(this.settings.provider)) this.settings.provider = this.settings.provider === 'ollama' ? 'gemini' : 'claude';
    if (!this.settings.sessions || typeof this.settings.sessions !== 'object') this.settings.sessions = {};
  }
  save() {
    const payload = { files: this.files, tasks: this.tasks, reminders: this.reminders, schedules: this.schedules, jobs: (this.jobs || []).map(({ cancel, ...j }) => j), workflows: this.workflows, actions: this.actions, chat: this.chat.slice(-MAX_CHAT), settings: this.settings };
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.path);
  }

  // files -----------------------------------------------------------------
  addFiles(paths) {
    const added = [];
    for (const raw of paths || []) {
      let p; try { p = fs.realpathSync(String(raw)); } catch { continue; }
      if (!this.files.includes(p)) { this.files.push(p); added.push(p); }
    }
    if (added.length) { this.save(); this.emit('files', { files: [...this.files], added, removed: [] }); }
    return added;
  }
  removeFile(p) {
    const i = this.files.indexOf(p);
    if (i >= 0) { this.files.splice(i, 1); this.save(); this.emit('files', { files: [...this.files], added: [], removed: [p] }); }
  }
  preview(raw) {
    let p; try { p = fs.realpathSync(String(raw)); } catch (e) { throw new Error('Cannot resolve path: ' + e.message); }
    if (!this.files.includes(p)) throw new Error('Attach this file in Buddy first; only attached files can be read.');
    if (!fs.statSync(p).isFile()) throw new Error('Attached path is not a file.');
    if (!TEXT_TYPES.has(path.extname(p).toLowerCase())) throw new Error('Preview supports text and code files. Open other formats in their own app.');
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(MAX_READ + 1);
    const n = fs.readSync(fd, buf, 0, MAX_READ + 1, 0);
    fs.closeSync(fd);
    let text = buf.subarray(0, Math.min(n, MAX_READ)).toString('utf8');
    if (n > MAX_READ) text += '\n[Preview truncated at 32 KB]';
    return text;
  }

  // tasks / reminders -----------------------------------------------------
  addTask(text) {
    text = String(text || '').trim();
    if (!text) throw new Error('Task text is required.');
    const task = { id: id(), text: text.slice(0, 300), done: false, created: now() };
    this.tasks.push(task); this.save(); this.emit('tasks', { tasks: [...this.tasks] });
    return task;
  }
  setTaskDone(taskId, done) {
    const t = this.tasks.find(t => t.id === taskId);
    if (!t) throw new Error('Unknown task id.');
    t.done = !!done; this.save(); this.emit('tasks', { tasks: [...this.tasks] });
    return t;
  }
  clearDoneTasks() { this.tasks = this.tasks.filter(t => !t.done); this.save(); this.emit('tasks', { tasks: [...this.tasks] }); }
  addReminder(seconds, message, repeat) {
    seconds = parseInt(seconds, 10);
    if (!(seconds >= 1 && seconds <= 366 * 86400)) throw new Error('Reminder must be between 1 second and 1 year.');
    return this.addReminderAt(now() + seconds, message, repeat);
  }
  addReminderAt(at, message, repeat) {
    at = Math.floor(Number(at)); repeat = REPEATS.includes(repeat) ? repeat : '';
    if (!(at > 0)) throw new Error('Pick a time for the reminder.');
    if (!repeat && at < now() - 60) throw new Error('That time has already passed.');
    if (at > now() + 366 * 86400) throw new Error('Reminders can be at most a year ahead.');
    message = String(message || '').trim(); if (!message) throw new Error('Write what Buddy should remind you about.');
    if (repeat && at <= now()) at = nextAt(at, repeat);
    const r = { id: id(), at, message: message.slice(0, 300), repeat, created: now() };
    this.reminders.push(r); this.save(); this.emitReminders();
    return r;
  }
  listReminders() { return [...this.reminders].sort((a, b) => a.at - b.at); }
  removeReminder(rid) { const n = this.reminders.length; this.reminders = this.reminders.filter(r => r.id !== rid); if (this.reminders.length !== n) { this.save(); this.emitReminders(); } return n !== this.reminders.length; }
  emitReminders() { this.emit('reminders', { reminders: this.listReminders() }); }
  dueReminders() {
    const t = now();
    const due = this.reminders.filter(r => r.at <= t);
    if (due.length) {
      for (const r of due) if (r.repeat) r.at = nextAt(r.at, r.repeat, t);
      this.reminders = this.reminders.filter(r => r.at > t); this.save(); this.emitReminders();
    }
    return due;
  }

  // scheduled AI tasks ------------------------------------------------------
  // { id, title, prompt, at (next run, s), repeat, mode: 'ask'|'do', provider: ''|name, enabled, last: { at, ok, summary } }
  addSchedule(o) {
    o = o || {}; const prompt = String(o.prompt || (o.workflow ? 'Workflow: ' + (o.title || o.workflow) : '')).trim(); if (!prompt) throw new Error('Write what the AI should do.');
    let at = Math.floor(Number(o.at)); const repeat = REPEATS.includes(o.repeat) ? o.repeat : '';
    if (!(at > 0)) throw new Error('Pick when it should run.');
    if (!repeat && at < now() - 60) throw new Error('That time has already passed.');
    if (repeat && at <= now()) at = nextAt(at, repeat);
    const s = { id: id(), title: String(o.title || prompt.split('\n')[0]).trim().slice(0, 80), prompt: prompt.slice(0, 4000), at, repeat, mode: o.mode === 'do' ? 'do' : 'ask', provider: AGENTS.includes(o.provider) ? o.provider : '', enabled: true, created: now(), last: null, workflow: String(o.workflow || ''), background: !!o.background };
    this.schedules.push(s); this.save(); this.emitSchedules();
    return s;
  }
  updateSchedule(sid, ch) {
    const s = this.schedules.find(x => x.id === sid); if (!s) throw new Error('Unknown schedule.');
    ch = ch || {};
    if ('enabled' in ch) { s.enabled = !!ch.enabled; if (s.enabled && s.at <= now()) { if (s.repeat) s.at = nextAt(s.at, s.repeat); else s.enabled = false; } }
    if ('prompt' in ch && String(ch.prompt).trim()) { s.prompt = String(ch.prompt).trim().slice(0, 4000); s.title = s.prompt.split('\n')[0].slice(0, 80); }
    if ('mode' in ch) s.mode = ch.mode === 'do' ? 'do' : 'ask';
    if ('provider' in ch) s.provider = AGENTS.includes(ch.provider) ? ch.provider : '';
    this.save(); this.emitSchedules(); return s;
  }
  removeSchedule(sid) { const n = this.schedules.length; this.schedules = this.schedules.filter(s => s.id !== sid); if (n !== this.schedules.length) { this.save(); this.emitSchedules(); } return n !== this.schedules.length; }
  listSchedules() { return [...this.schedules].sort((a, b) => (b.enabled - a.enabled) || a.at - b.at); }
  emitSchedules() { this.emit('schedules', { schedules: this.listSchedules() }); }
  // due schedules move to their next run (or switch off when one-time) the moment they fire
  dueSchedules() {
    const t = now(); const due = this.schedules.filter(s => s.enabled && s.at <= t);
    for (const s of due) { if (s.repeat) s.at = nextAt(s.at, s.repeat, t); else s.enabled = false; }
    if (due.length) { this.save(); this.emitSchedules(); }
    return due.map(s => ({ ...s }));
  }
  markScheduleRun(sid, ok, summary) { const s = this.schedules.find(x => x.id === sid); if (!s) return; s.last = { at: now(), ok: !!ok, summary: String(summary || '').slice(0, 200) }; this.save(); this.emitSchedules(); }

  // chat ------------------------------------------------------------------
  addChat(role, text, provider, extra) { this.chat.push({ role, text, provider, at: now(), ...(extra && extra.images && extra.images.length ? { images: extra.images } : {}) }); this.chat = this.chat.slice(-MAX_CHAT); this.save(); }
  clearChat(provider) { if (provider) { this.chat = this.chat.filter(m => m.provider !== provider); for (const k of Object.keys(this.settings.sessions)) if (k === provider || k.startsWith(provider + '|')) delete this.settings.sessions[k]; } else { this.chat = []; this.settings.sessions = {}; } this.save(); }

  // agents ----------------------------------------------------------------
  agent(name) {
    name = String(name || '').toLowerCase();
    if (!AGENTS.includes(name)) throw new Error('Client must identify as claude, codex or gemini.');
    return this.agents[name];
  }
  setAgentState(name, state, message = '', session = '', source = 'mcp') {
    state = String(state || '').toLowerCase();
    if (!STATES.includes(state)) throw new Error(`Unknown state '${state}'. Use one of: ${STATES.join(', ')}.`);
    const a = this.agent(name);
    Object.assign(a, { state, message: String(message || '').slice(0, 160), at: now() });
    if (session) a.session = session;
    if (['done', 'error', 'idle'].includes(state)) for (const s of a.steps) if (s.status === 'running') s.status = state === 'done' ? 'done' : 'error';
    if (state === 'idle') a.steps = [];
    this.emit('agent', { agent: name, state, message: a.message, source });
    return a;
  }
  addAgentStep(name, tool, detail = '', status = 'running') {
    tool = String(tool || '').trim().slice(0, 32);
    if (!tool) throw new Error('Tool name is required.');
    if (!['running', 'done', 'error'].includes(status)) throw new Error('Step status must be running, done or error.');
    const a = this.agent(name);
    for (const s of a.steps) if (s.status === 'running') s.status = 'done';
    const step = { tool, detail: String(detail || '').slice(0, 120), status, at: now() };
    a.steps.push(step); a.steps = a.steps.slice(-MAX_STEPS);
    if (a.state !== 'working') Object.assign(a, { state: 'working', at: now() });
    this.emit('step', { agent: name, step });
    return step;
  }
  closeRunningStep(name, status = 'done') { for (const s of this.agent(name).steps) if (s.status === 'running') s.status = status; }
  heartbeat(name, session) { const a = this.agent(name); a.heartbeat = now(); if (session) a.session = session; }
  agentLinked(name) { return now() - this.agents[name].heartbeat < HEARTBEAT_TTL; }
  agentActivity(name) {
    const a = this.agents[name];
    const fresh = a.at && (now() - a.at < ACTIVITY_TTL || ['working', 'waiting'].includes(a.state));
    return fresh ? { state: a.state, message: a.message, steps: a.steps.slice(-MAX_STEPS) } : { state: 'idle', message: '', steps: a.steps.slice(-MAX_STEPS) };
  }
  headline() {
    const prio = { waiting: 2, working: 2, error: 1, done: 1, idle: 0 };
    let best = ['', 'idle', ''], rank = [-1, 0];
    for (const name of AGENTS) {
      const act = this.agentActivity(name);
      const r = [prio[act.state], this.agents[name].at];
      if (act.state !== 'idle' && (r[0] > rank[0] || (r[0] === rank[0] && r[1] > rank[1]))) { rank = r; best = [name, act.state, act.message]; }
    }
    return best;
  }

  // tool calls from the bridge -------------------------------------------
  execute(name, args) {
    args = args || {};
    const agent = String(args.agent || '').toLowerCase();
    switch (name) {
      case 'buddy_heartbeat': this.heartbeat(agent, String(args.session || '')); return { connected: true };
      case 'buddy_status': this.setAgentState(agent, args.state, args.message, String(args.session || '')); return { updated: true, agent, state: this.agents[agent].state };
      case 'buddy_step': return { recorded: true, step: this.addAgentStep(agent, args.tool, args.detail, args.status || 'running') };
      case 'buddy_say': { const text = String(args.text || '').trim(); if (!text) throw new Error('Text is required.'); this.emit('say', { agent, text: text.slice(0, 200) }); return { shown: true }; }
      case 'buddy_files': return { files: [...this.files] };
      case 'buddy_read_file': return { path: String(args.path || ''), text: this.preview(args.path) };
      case 'buddy_remind': { const r = this.addReminder(args.seconds, args.message, args.repeat); return { scheduled: true, id: r.id, at: r.at, repeat: r.repeat }; }
      case 'buddy_schedule': { const sec = parseInt(args.seconds, 10); if (!(sec >= 1)) throw new Error('seconds must be at least 1.'); const s = this.addSchedule({ prompt: args.prompt, at: now() + sec, repeat: args.repeat, mode: args.mode }); return { scheduled: true, id: s.id, next_run: new Date(s.at * 1000).toISOString(), repeat: s.repeat, mode: s.mode }; }
      case 'buddy_task': return { added: true, task: this.addTask(args.text) };
      case 'buddy_tasks': return { tasks: [...this.tasks] };
      case 'buddy_complete_task': return { task: this.setTaskDone(String(args.id || ''), true) };
      case 'buddy_memory': { if (!this.memory) throw new Error('Memory unavailable.'); const m = this.memory.all(); return { profile: m.profile, projects: m.projects, notes: m.notes, note: 'Follow the rules in profile. Call buddy_remember(text) for durable facts.' }; }
      case 'buddy_remember': { if (!this.memory) throw new Error('Memory unavailable.'); const r = this.memory.remember(args.text, agent); this.emit('memory', {}); return r; }
      default: throw new Error('Unknown tool: ' + name);
    }
  }
}

module.exports = { State, AGENTS, DEFAULTS, nextAt, REPEATS };
