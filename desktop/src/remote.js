'use strict';
// Remote control: talk to Buddy from your phone via Telegram or Slack (DM the bot → Buddy runs it → replies back).
// Pure HTTP polling, no public URL, no dependencies. Only the first person who messages the bot is linked (owner).
const fs = require('fs');
const path = require('path');

const TG_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const SLACK_BASE = process.env.SLACK_API_BASE || 'https://slack.com/api';
const MAX_MSG = 3800;

async function jfetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 40000) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 200) }; }
  if (!r.ok && j.ok !== true) throw new Error(j.description || j.error || ('HTTP ' + r.status));
  return j;
}
const chunks = (t, n = MAX_MSG) => { const out = []; t = String(t || ''); while (t.length > n) { let cut = t.lastIndexOf('\n', n); if (cut < n / 2) cut = n; out.push(t.slice(0, cut)); t = t.slice(cut); } out.push(t); return out; };
const imagePaths = text => [...new Set((String(text || '').match(/[A-Za-z]:\\[^\s"'<>|*?]+?\.(?:png|jpe?g|gif|webp)|\/[^\s"'<>|*?]+?\.(?:png|jpe?g|gif|webp)/gi) || []).filter(p => { try { return fs.statSync(p).size < 20e6; } catch { return false; } }))];

// ------------------------------------------------------------- Telegram
class Telegram {
  constructor(cfg, onMessage, save) { this.cfg = cfg; this.onMessage = onMessage; this.save = save; this.name = 'telegram'; this.stopped = false; this.offset = cfg.offset || 0; }
  url(m) { return `${TG_BASE}/bot${this.cfg.token}/${m}`; }
  async verify() { const r = await jfetch(this.url('getMe'), { timeoutMs: 15000 }); if (!r.ok) throw new Error(r.description || 'bad token'); this.cfg.bot = '@' + r.result.username; return this.cfg.bot; }
  // fresh link: skip messages that were waiting before Buddy connected (a stranger's old message must not become the owner)
  async skipBacklog() { try { const r = await jfetch(this.url('getUpdates') + '?offset=-1&timeout=0', { timeoutMs: 15000 }); const last = (r.result || []).pop(); if (last) { this.offset = last.update_id + 1; this.cfg.offset = this.offset; } } catch { /* */ } }
  async loop() {
    while (!this.stopped) {
      try {
        const r = await jfetch(this.url('getUpdates') + `?timeout=25&offset=${this.offset}&allowed_updates=["message","callback_query"]`, { timeoutMs: 40000 });
        for (const u of r.result || []) {
          this.offset = u.update_id + 1; this.cfg.offset = this.offset; this.save();
          if (u.callback_query) { // Accept / Reject button pressed
            const cq = u.callback_query; const [act, pid] = String(cq.data || '').split(':');
            if (String((cq.from || {}).id) === this.cfg.owner && (act === 'accept' || act === 'reject')) { this.onMessage({ source: 'telegram', button: { act, pid }, reply: t => this.send(cq.from.id, t) }); }
            jfetch(this.url('answerCallbackQuery'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: cq.id, text: act === 'accept' ? 'Accepted' : 'Rejected' }), timeoutMs: 10000 }).catch(() => {});
            continue;
          }
          const m = u.message; if (!m || !m.text) continue;
          const from = m.from || {}; const chat = m.chat || {}; const who = from.username ? '@' + from.username : (from.first_name || String(chat.id));
          if (chat.type && chat.type !== 'private') { if (!this.cfg.owner) await this.send(chat.id, 'Message me in a private chat to link Buddy.'); continue; }
          if (!this.cfg.owner) { this.cfg.owner = String(chat.id); this.cfg.owner_name = who; this.save(); await this.send(chat.id, `Linked to Buddy as ${who}. Send me a task; prefix with /do to let me edit & run things, /ask for read-only. /status, /stop also work.`); }
          if (String(chat.id) !== this.cfg.owner) { await this.send(chat.id, 'This Buddy is linked to someone else.'); continue; }
          this.onMessage({ source: 'telegram', text: m.text, reply: t => this.send(chat.id, t), who });
        }
        this.backoff = 0;
      } catch (e) { if (this.stopped) break; this.lastError = e.message; this.backoff = Math.min(60000, (this.backoff || 1000) * 2); await new Promise(r => setTimeout(r, this.backoff)); }
    }
  }
  async askApproval(chatId, text, pid) {
    await jfetch(this.url('sendMessage'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '✅ Accept', callback_data: 'accept:' + pid }, { text: '❌ Reject', callback_data: 'reject:' + pid }]] } }), timeoutMs: 20000 }).catch(() => {});
  }
  async send(chatId, text) {
    for (const c of chunks(text)) await jfetch(this.url('sendMessage'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: c, disable_web_page_preview: true }), timeoutMs: 20000 }).catch(() => {});
    for (const p of imagePaths(text).slice(0, 4)) {
      try { const fd = new FormData(); fd.append('chat_id', String(chatId)); fd.append('photo', new Blob([fs.readFileSync(p)]), path.basename(p)); await jfetch(this.url('sendPhoto'), { method: 'POST', body: fd, timeoutMs: 60000 }); } catch { /* skip */ }
    }
  }
  stop() { this.stopped = true; }
}

// ---------------------------------------------------------------- Slack
class Slack {
  constructor(cfg, onMessage, save) { this.cfg = cfg; this.onMessage = onMessage; this.save = save; this.name = 'slack'; this.stopped = false; this.since = {}; }
  async api(m, params, opts = {}) {
    const r = await jfetch(`${SLACK_BASE}/${m}`, { method: 'POST', headers: { Authorization: 'Bearer ' + this.cfg.token, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params || {}), timeoutMs: 20000, ...opts });
    if (!r.ok) throw new Error(r.error || m + ' failed'); return r;
  }
  async verify() { const r = await this.api('auth.test'); this.cfg.bot_user = r.user_id; this.cfg.bot = '@' + r.user; this.cfg.team = r.team; return `${this.cfg.bot} in ${r.team}`; }
  async loop() {
    let lastList = 0, ims = [];
    while (!this.stopped) {
      try {
        if (Date.now() - lastList > 60000) { const r = await this.api('conversations.list', { types: 'im', limit: 200 }); ims = (r.channels || []).filter(c => !c.is_user_deleted); lastList = Date.now(); }
        for (const im of ims) {
          if (this.cfg.owner && im.user !== this.cfg.owner) continue;
          const oldest = this.since[im.id] || (Date.now() / 1000 - 5).toFixed(6);
          const h = await this.api('conversations.history', { channel: im.id, oldest, limit: 20, inclusive: false });
          const msgs = (h.messages || []).filter(m => m.type === 'message' && !m.bot_id && !m.subtype && m.user && m.user !== this.cfg.bot_user).sort((a, b) => +a.ts - +b.ts);
          for (const m of msgs) {
            this.since[im.id] = m.ts;
            if (!this.cfg.owner) { this.cfg.owner = m.user; let who = m.user; try { who = '@' + ((await this.api('users.info', { user: m.user })).user || {}).name; } catch { /* */ } this.cfg.owner_name = who; this.save(); await this.send(im.id, `Linked to Buddy as ${who}. Send me a task; prefix with /do to let me edit & run things, /ask for read-only. /status, /stop also work.`); }
            this.onMessage({ source: 'slack', text: m.text, reply: t => this.send(im.id, t), who: this.cfg.owner_name });
          }
          if (!this.since[im.id] && h.messages && h.messages[0]) this.since[im.id] = h.messages[0].ts;
        }
        this.backoff = 0; await new Promise(r => setTimeout(r, ims.length ? 2500 : 8000));
      } catch (e) { if (this.stopped) break; this.lastError = e.message; this.backoff = Math.min(60000, (this.backoff || 2000) * 2); await new Promise(r => setTimeout(r, this.backoff)); }
    }
  }
  async send(channel, text) {
    for (const c of chunks(text)) await this.api('chat.postMessage', { channel, text: c }).catch(() => {});
    for (const p of imagePaths(text).slice(0, 4)) {
      try {
        const buf = fs.readFileSync(p); const u = await this.api('files.getUploadURLExternal', { filename: path.basename(p), length: buf.length });
        await fetch(u.upload_url, { method: 'POST', body: buf, signal: AbortSignal.timeout(60000) });
        await this.api('files.completeUploadExternal', { files: [{ id: u.file_id, title: path.basename(p) }], channel_id: channel });
      } catch { /* skip */ }
    }
  }
  stop() { this.stopped = true; }
}

// --------------------------------------------------------------- manager
class Remote {
  constructor(core) {
    this.core = core; this.adapters = {}; this.queue = []; this.active = null; this.pendingPerm = null;
    core.on('event', (k, p) => this.onCoreEvent(k, p));
  }
  get cfg() { const s = this.core.state.settings; if (!s.remote) s.remote = {}; return s.remote; }
  save() { this.core.state.save(); }
  status() { const out = {}; for (const k of ['telegram', 'slack']) { const c = this.cfg[k] || {}; const a = this.adapters[k]; out[k] = { configured: !!c.token, bot: c.bot || '', owner: c.owner_name || '', running: !!a && !a.stopped, error: a && a.lastError || '' }; } out.notify = this.cfg.notify !== false; return out; }
  setNotify(v) { this.cfg.notify = !!v; this.save(); }
  make(kind) {
    const c = this.cfg[kind]; const onMsg = m => this.incoming(m); const save = () => this.save();
    return kind === 'telegram' ? new Telegram(c, onMsg, save) : new Slack(c, onMsg, save);
  }
  async connect(kind, token) {
    token = String(token || '').trim(); if (!token) throw new Error('Paste the bot token first.');
    if (kind === 'telegram' && !/^\d+:[\w-]{30,}$/.test(token)) throw new Error('That does not look like a Telegram bot token (123456:ABC…). Get one from @BotFather.');
    if (kind === 'slack' && !/^xox[bp]-/.test(token)) throw new Error('That does not look like a Slack bot token (xoxb-…).');
    // verify the new token first — a typo must not kill the bot that already works
    const cfg = { token }; const a = kind === 'telegram' ? new Telegram(cfg, m => this.incoming(m), () => this.save()) : new Slack(cfg, m => this.incoming(m), () => this.save());
    const who = await a.verify(); if (a.skipBacklog) await a.skipBacklog();
    this.stop(kind); this.cfg[kind] = cfg; this.save(); this.adapters[kind] = a; a.loop();
    return who;
  }
  start() { for (const k of ['telegram', 'slack']) if ((this.cfg[k] || {}).token && !this.adapters[k]) { try { const a = this.make(k); this.adapters[k] = a; a.verify().catch(e => { a.lastError = e.message; }); a.loop(); } catch { /* */ } } }
  stop(kind) { const a = this.adapters[kind]; if (a) { a.stop(); delete this.adapters[kind]; } }
  unlink(kind) { this.stop(kind); delete this.cfg[kind]; this.save(); }
  stopAll() { for (const k of Object.keys(this.adapters)) this.stop(k); }

  // inbound ---------------------------------------------------------------
  incoming(m) {
    if (m.button) { const ok = this.core.permissionReply(m.button.pid, m.button.act === 'accept' ? 'accept' : 'deny'); m.reply(ok ? (m.button.act === 'accept' ? 'Accepted — that one action runs.' : 'Rejected.') : 'That approval already expired.'); return; }
    const text = String(m.text || '').trim(); if (!text) return;
    const low = text.toLowerCase();
    const ex = low.match(/^\/(accept|reject)\s+(p\d+)$/); if (ex) { const ok = this.core.permissionReply(ex[2], ex[1] === 'accept' ? 'accept' : 'deny'); return m.reply(ok ? (ex[1] === 'accept' ? 'Accepted — that one action runs.' : 'Rejected.') : 'No such pending action (it may have expired).'); }
    if (this.pendingPerm && /^(agree|agreed|done|approve|approved|accept|allow|ok|okay|yes|haan|han|ha|ji|kar do|krdo|karo|chalo|go|deny|reject|no|nahi|nhi)\b/i.test(low)) { const p = this.core.pendingPerms.get(this.pendingPerm); if (p) { this.askOn(m, p.payload); return m.reply('Use the Accept / Reject buttons (or /accept ' + this.pendingPerm + ' · /reject ' + this.pendingPerm + '). Words alone never approve.'); } }
    if (low === '/status') { const [agent, st, msg] = this.core.state.headline(); return m.reply(agent ? `${agent}: ${st}${msg ? ' — ' + msg : ''}` : (this.core.chatBusy ? 'Thinking…' : 'Idle. Send me a task.')); }
    if (low === '/stop') { this.core.stop(); this.queue = []; return m.reply('Stopped.'); }
    if (low === '/start' || low === '/help') return m.reply('Send me a task. /do <task> lets me edit & run things, /ask <question> is read-only. /status, /stop.');
    let agent = null, body = text;
    if (/^\/do\b/i.test(text)) { agent = true; body = text.replace(/^\/do\b\s*/i, ''); } else if (/^\/ask\b/i.test(text)) { agent = false; body = text.replace(/^\/ask\b\s*/i, ''); }
    if (!body) return m.reply('What should I do?');
    this.queue.push({ ...m, text: body, agent }); this.pump();
  }
  pump() {
    if (this.active || !this.queue.length) return;
    if (this.core.chatBusy) { setTimeout(() => this.pump(), 1500); return; }
    const job = this.queue.shift(); this.active = job;
    this.core.ev('say', { agent: '', text: `${job.source === 'slack' ? 'Slack' : 'Telegram'}: ${job.text.slice(0, 60)}`, reaction: 'receive' });
    const said = []; const grab = (k, p) => { if (k === 'chat.system' && p && p.text) said.push(p.text); };
    this.core.on('event', grab);
    try { this.core.submit(job.text, job.agent == null ? undefined : job.agent); } finally { this.core.removeListener('event', grab); }
    if (!this.core.chatBusy) { if (/^\//.test(job.text)) job.reply(said.join('\n').slice(0, 3500) || 'Done.'); this.active = null; this.pump(); } // commands (/task, /clear…) finish synchronously
  }
  onCoreEvent(kind, p) {
    if (kind === 'chat.done' && this.active) { const job = this.active; this.active = null; job.reply(p.text || '(no reply)').finally(() => this.pump()); }
    else if (kind === 'chat.error' && this.active) { const job = this.active; this.active = null; job.reply(p.stopped ? 'Stopped.' : 'Error: ' + p.message).finally(() => this.pump()); }
    else if (kind === 'permission' && this.active && !p.reshow) { this.pendingPerm = p.id; this.askOn(this.active, p); }
    else if (kind === 'permission.done' && this.pendingPerm === p.id) this.pendingPerm = null;
    else if (kind === 'agent' && this.cfg.notify !== false && p.source !== 'chat' && ['waiting', 'done', 'error'].includes(p.state)) {
      const A = (p.agent || '').replace(/^./, c => c.toUpperCase()); const txt = `${A} ${p.state === 'waiting' ? 'needs you' : p.state === 'done' ? 'finished' : 'hit an error'}${p.message ? ': ' + p.message : ''}`;
      this.notifyOwner(txt);
    }
  }
  askOn(job, p) {
    const text = `Approval needed: ${p.title || p.nice}\n${p.nice}${p.target ? '\n' + p.target : ''}${p.reason ? '\n' + p.reason : ''}`;
    const a = this.adapters[job.source]; const c = this.cfg[job.source] || {};
    if (job.source === 'telegram' && a && c.owner) a.askApproval(c.owner, text, p.id).catch(() => {});
    else job.reply(text + `\nReply exactly: /accept ${p.id}  or  /reject ${p.id}`);
  }
  notifyOwner(text) {
    for (const k of ['telegram', 'slack']) { const a = this.adapters[k]; const c = this.cfg[k] || {}; if (!a || !c.owner) continue; if (k === 'telegram') a.send(c.owner, text).catch(() => {}); else a.api('conversations.open', { users: c.owner }).then(r => a.send(r.channel.id, text)).catch(() => {}); }
  }
}

module.exports = { Remote, Telegram, Slack, chunks, imagePaths };
