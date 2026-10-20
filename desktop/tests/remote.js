'use strict';
process.env.BUDDY_NO_AUTOINSTALL = '1';
// Phone remote: fake Telegram + Slack APIs → link owner → task runs through core → reply, permission relay, notifications.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-remote-'));
const sent = { tg: [], slack: [] }; let tgUpdates = []; let slackMsgs = [];
const api = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const j = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = u.pathname;
    // telegram
    if (/\/bot[^/]+\/getMe$/.test(p)) return j({ ok: true, result: { username: 'bolt_buddy_bot' } });
    if (/\/getUpdates$/.test(p)) { const off = +u.searchParams.get('offset') || 0; const out = tgUpdates.filter(x => x.update_id >= off); if (out.length) return j({ ok: true, result: out }); return setTimeout(() => j({ ok: true, result: [] }), 300); }
    if (/\/sendMessage$/.test(p)) { sent.tg.push(JSON.parse(body)); return j({ ok: true, result: {} }); }
    if (/\/answerCallbackQuery$/.test(p)) return j({ ok: true });
    if (/\/sendPhoto$/.test(p)) { sent.tg.push({ photo: true }); return j({ ok: true, result: {} }); }
    // slack
    if (p === '/auth.test') return j({ ok: true, user_id: 'UBOT', user: 'buddy', team: 'GameDistrict' });
    if (p === '/conversations.list') return j({ ok: true, channels: [{ id: 'D1', user: 'UBOLT' }] });
    if (p === '/conversations.history') { const b = JSON.parse(body); const out = slackMsgs.filter(m => +m.ts > +b.oldest); return j({ ok: true, messages: out.reverse() }); }
    if (p === '/users.info') return j({ ok: true, user: { name: 'bolt' } });
    if (p === '/chat.postMessage') { sent.slack.push(JSON.parse(body)); return j({ ok: true }); }
    if (p === '/conversations.open') return j({ ok: true, channel: { id: 'D1' } });
    res.writeHead(404); res.end('{"ok":false,"error":"no route ' + p + '"}');
  });
});

(async () => {
  await new Promise(r => api.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + api.address().port;
  process.env.TELEGRAM_API_BASE = base; process.env.SLACK_API_BASE = base;
  const { Core } = require('../src/core');
  const core = new Core(DATA);
  // fake provider: echoes, and asks a permission on "edit" tasks
  core.provider = { name: 'claude', label: 'Claude', accent: '#fff', cancel() {}, run: async (prompt, ctx, emit) => {
    if (/edit/.test(prompt)) { const r = await core.askPermission({ tool_name: 'Bash', input: { command: 'git push origin main' } }); if (r.behavior === 'deny') return emit('done', 'Skipped the push.'); }
    emit('done', `Done: ${prompt} (${ctx.agent ? 'do' : 'ask'})`);
  } };
  // telegram link + task
  const who = await core.remote.connect('telegram', '123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert(who === '@bolt_buddy_bot', 'telegram token verified: ' + who);
  tgUpdates.push({ update_id: 1, message: { text: '/do make the build', from: { username: 'bolt' }, chat: { id: 777 } } });
  await sleep(1200);
  assert(sent.tg[0] && /Linked to Buddy as @bolt/.test(sent.tg[0].text) && sent.tg[0].chat_id === 777, 'first sender linked as owner');
  assert(sent.tg.some(m => /Done: make the build \(do\)/.test(m.text)), 'task ran in Do mode and replied: ' + JSON.stringify(sent.tg.map(m => m.text)));
  const st = core.remote.status(); assert(st.telegram.owner === '@bolt' && st.telegram.bot === '@bolt_buddy_bot', 'status shows link');
  // stranger blocked
  tgUpdates.push({ update_id: 2, message: { text: 'hi', from: { username: 'someone' }, chat: { id: 999 } } });
  await sleep(900); assert(sent.tg.some(m => m.chat_id === 999 && /linked to someone else/.test(m.text)), 'other people are refused');
  // permission relayed to phone and answered there
  tgUpdates.push({ update_id: 3, message: { text: '/do edit the config', from: { username: 'bolt' }, chat: { id: 777 } } });
  await sleep(900); const ask = sent.tg.find(m => /Approval needed: Git push/.test(m.text)); assert(ask && ask.reply_markup && /^accept:p\d+$/.test(ask.reply_markup.inline_keyboard[0][0].callback_data), 'approval sent to phone with Accept/Reject buttons');
  tgUpdates.push({ update_id: 4, message: { text: 'haan kar do', from: { username: 'bolt' }, chat: { id: 777 } } });
  await sleep(900); assert(sent.tg.some(m => /Words alone never approve/.test(m.text)) && !sent.tg.some(m => /Done: edit/.test(m.text)), 'typing "haan" does not approve');
  const pid = ask.reply_markup.inline_keyboard[0][1].callback_data.split(':')[1];
  tgUpdates.push({ update_id: 5, callback_query: { id: 'cq1', from: { id: 777, username: 'bolt' }, data: 'reject:' + pid } });
  await sleep(900); assert(sent.tg.some(m => /Skipped the push/.test(m.text)) && sent.tg.some(m => m.text === 'Rejected.'), 'reject button from phone reached the tool');
  // /status + notifications from MCP agents
  tgUpdates.push({ update_id: 6, message: { text: '/status', from: { username: 'bolt' }, chat: { id: 777 } } });
  await sleep(700); assert(sent.tg.some(m => /Idle|claude: done/.test(m.text)), '/status answered');
  core.state.execute('buddy_status', { agent: 'codex', state: 'waiting', message: 'Need the API key' });
  await sleep(500); assert(sent.tg.some(m => /Codex needs you: Need the API key/.test(m.text)), 'agent waiting → phone ping');
  // slack
  const sw = await core.remote.connect('slack', 'xoxb-123-456'); assert(/@buddy in GameDistrict/.test(sw), 'slack token verified');
  await sleep(300);
  slackMsgs.push({ type: 'message', user: 'UBOLT', text: '/ask what is 2+2', ts: (Date.now() / 1000).toFixed(6) });
  await sleep(3500);
  assert(sent.slack.some(m => /Linked to Buddy as @bolt/.test(m.text)) && sent.slack.some(m => /Done: what is 2\+2 \(ask\)/.test(m.text)), 'slack DM → task → reply: ' + JSON.stringify(sent.slack.map(m => m.text)));
  core.remote.unlink('telegram'); assert(!core.remote.status().telegram.configured, 'unlink clears config');
  core.close(); api.close(); console.log('REMOTE OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
