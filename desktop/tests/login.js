'use strict';
// Terminal-free sign-in: Gemini (Antigravity CLI, hidden; its own browser sign-in),
// Claude (`claude auth login` hidden + pasted code), Codex (`codex login` hidden), auto-start on "not signed in" errors.
process.env.BUDDY_NO_AUTOINSTALL = '1';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-login-'));
process.env.GEMINI_CLI_HOME = HOME;
process.env.PATH = path.join(__dirname, 'fake-login') + path.delimiter + process.env.PATH;

const google = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.startsWith('/token')) { const q = new URLSearchParams(b); return res.end(JSON.stringify(q.get('code') === 'gcode' && q.get('client_id').endsWith('.apps.googleusercontent.com') ? { access_token: 'ya29.x', refresh_token: '1//r', expires_in: 3599 } : { error: 'bad' })); }
  res.end(JSON.stringify({ email: 'bolt@example.com' }));
}); });

(async () => {
  await new Promise(r => google.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + google.address().port;
  process.env.GOOGLE_OAUTH_TOKEN_URL = base + '/token'; process.env.GOOGLE_OAUTH_USERINFO_URL = base + '/userinfo';
  const { needsLogin } = require('../src/login');
  assert(needsLogin('claude', 'Claude: Not logged in · Please run /login') && needsLogin('codex', 'Codex: unexpected status 401 Unauthorized') && needsLogin('gemini', 'Gemini is not signed in yet.') && !needsLogin('claude', 'Claude failed: rate limit'), 'not-signed-in errors detected per CLI');
  assert(needsLogin('claude', 'Failed to authenticate: OAuth session expired and could not be refreshed'), 'expired Claude OAuth session opens sign-in');

  const { Core } = require('../src/core');
  const core = new Core(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-login-data-')));
  const events = []; const opened = [];
  core.on('event', (k, p) => { events.push([k, p]); if (k === 'open_url') opened.push(p.url); });
  const lastLogin = () => [...events].reverse().find(e => e[0] === 'login')[1];

  // Gemini = Antigravity CLI: Buddy runs it hidden, its own Google sign-in opens the browser; URL captured for "open again"
  core.signIn('gemini'); await sleep(1500);
  assert(events.some(e => e[0] === 'login' && e[1].which === 'gemini' && /accounts\.google\.com/.test(e[1].url)) && lastLogin().state === 'done' && lastLogin().which === 'gemini', 'Gemini (Antigravity): hidden sign-in, URL captured, finished');
  const P = require('../src/providers'); const g = new P.Gemini(); let out = [];
  await g.run('hello agy', { system: 'SYS', workdir: HOME, agent: false }, (k, d) => out.push([k, d]));
  const done = out.find(o => o[0] === 'done'); assert(done && /Agy says: hello agy \[plan\]/.test(done[1]) && !/\x1b/.test(done[1]), 'Gemini (Antigravity): prompt as argument, Ask = plan mode, ANSI stripped: ' + JSON.stringify(out));
  const allowF = path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json'); const allow = JSON.parse(fs.readFileSync(allowF, 'utf8')).permissions.allow;
  assert(allow.includes('mcp(buddy/buddy_status)') && allow.includes('read_file(*)'), 'Antigravity: Buddy tools pre-allowed for headless mode (no "mcp permission auto-denied")');
  out = []; await g.run('fix it', { system: '', workdir: HOME, agent: true }, (k, d) => out.push([k, d])); assert(out.some(o => o[0] === 'done' && /\[do\]/.test(o[1])), 'Gemini (Antigravity): Do mode runs with Buddy approval hooks (no skip-permissions)');
  process.env.AGY_FAKE_SOFTDENY = '1'; out = []; await g.run('fix it', { system: '', workdir: HOME, agent: true }, (k, d) => out.push([k, d])); delete process.env.AGY_FAKE_SOFTDENY;
  assert(out.some(o => o[0] === 'step' && /ignored/.test(o[1].detail)) && out.some(o => o[0] === 'done' && /\[do-skip\]/.test(o[1])), 'Gemini (Antigravity): if this agy ignores hooks, Buddy falls back instead of failing');
  fs.unlinkSync(path.join(HOME, '.agy-fake-token')); process.env.AGY_FAKE_NOAUTH = '1'; out = [];
  await g.run('hi', { system: '', workdir: HOME, agent: false }, (k, d) => out.push([k, d])); delete process.env.AGY_FAKE_NOAUTH;
  assert(out.some(o => o[0] === 'error' && /not signed in/.test(o[1])), 'Gemini (Antigravity): not-signed-in detected: ' + JSON.stringify(out));
  fs.writeFileSync(path.join(HOME, '.agy-fake-token'), 'ok');
  // a "not signed in" right after a successful sign-in must NOT reopen the browser (no loop) — show the CLI's reason
  const before = opened.length; core.chatEvent({ name: 'gemini', label: 'Gemini' }, 'error', 'Gemini is not signed in yet. (Manual authorization is required)'); await sleep(200);
  const loopErr = [...events].reverse().find(e => e[0] === 'chat.error')[1].message;
  assert(opened.length === before && /still refuses right after sign-in.*Manual authorization/.test(loopErr) && lastLogin().state === 'done', 'no sign-in loop after success: ' + loopErr);
  // Claude: hidden `claude auth login`; URL captured; pasted code goes to the process
  core.signIn('claude'); await sleep(1200);
  let st = lastLogin(); assert(st.which === 'claude' && st.state === 'browser' && /claude\.com\/cai\/oauth/.test(st.url) && st.needsCode, 'Claude: sign-in URL captured, code box offered');
  core.login.submitCode('GOODCODE'); await sleep(800);
  assert(lastLogin().state === 'done' && events.some(e => e[0] === 'say' && /Claude signed in/.test(e[1].text)), 'Claude: pasted code → signed in');

  // Codex: auto-started from a "not signed in" chat error, finishes by itself (localhost callback)
  core.provider = { name: 'codex', label: 'Codex', accent: '#fff', cancel() {}, available: async () => [true, 'ok'], run: async (p, ctx, emit) => emit('error', 'Codex: unexpected status 401 Unauthorized: Missing bearer') };
  core.submit ? core.submit('hello') : null; await sleep(300);
  if (!events.some(e => e[0] === 'login' && e[1].which === 'codex')) core.chatEvent(core.provider, 'error', 'Codex: unexpected status 401 Unauthorized');
  await sleep(1800);
  const ce = [...events].reverse().find(e => e[0] === 'chat.error'); assert(ce && /not signed in yet — opening your browser/.test(ce[1].message), 'chat error rewritten: ' + (ce && ce[1].message));
  assert(events.some(e => e[0] === 'login' && e[1].which === 'codex' && /auth\.openai\.com/.test(e[1].url)) && lastLogin().state === 'done', 'Codex: auto sign-in on 401, no terminal, finished');
  core.close(); google.close(); console.log('LOGIN OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
