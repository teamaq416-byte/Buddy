'use strict';
// Assistant layer: AI picking, knowledge search, background jobs, workflows (AI / command / notify), approvals,
// folder + GitHub watchers, Calendar meeting reminders, Calendar/Gmail MCP tools, PC tools through the tool server.
process.env.BUDDY_NO_AUTOINSTALL = '1'; process.env.BUDDY_ONLY_PROVIDERS = 'gemini'; // the fake CLI is the only AI in tests process.env.BUDDY_NO_VERIFY = '1';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } throw new Error('timeout: ' + what); };
process.env.PATH = path.join(__dirname, 'fake-gemini') + path.delimiter + process.env.PATH;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-asst-'));
const HOME = path.join(DATA, 'home'); fs.mkdirSync(HOME, { recursive: true }); os.homedir = () => HOME; process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.BUDDY_DATA_DIR = DATA; process.env.BUDDY_GH_POLL_MS = '3600000'; process.env.BUDDY_CAL_POLL_MS = '3600000';

// mock GitHub + Google APIs
let ghRun = { id: 7, name: 'Release', display_title: 'v2.0.2', head_branch: 'main', status: 'in_progress', conclusion: null, html_url: 'https://github.com/a/b/actions/runs/7', updated_at: new Date().toISOString() };
const soon = new Date(Date.now() + 5 * 60e3).toISOString(), later = new Date(Date.now() + 65 * 60e3).toISOString();
let oldHit = false; const posted = [];
const mock = http.createServer((req, res) => {
  const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const fut = new Date(Date.now() + 120000).toISOString();
  if (req.url.startsWith('/v1/spaces?')) return send({ spaces: [{ name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE', lastActiveTime: fut }, { name: 'spaces/ROOM', displayName: 'Ads', spaceType: 'SPACE', lastActiveTime: fut }, { name: 'spaces/OLD', displayName: 'Old', spaceType: 'SPACE', lastActiveTime: '2020-01-01T00:00:00Z' }] });
  if (/^\/v1\/spaces\/\w+\/members\/bolt/.test(req.url)) return send({ member: { name: 'users/me1' } });
  if (/^\/v1\/spaces\/\w+\/members/.test(req.url)) return send({ memberships: [{ member: { name: 'users/me1', displayName: 'Bolt', type: 'HUMAN' } }, { member: { name: 'users/h', displayName: 'Sara', type: 'HUMAN' } }] });
  if (req.url.startsWith('/v1/spaces/DM1/messages') && req.method === 'GET') return send({ messages: [{ name: 'spaces/DM1/messages/m2', sender: { name: 'users/me1' }, text: 'mine', createTime: fut }, { name: 'spaces/DM1/messages/m1', sender: { name: 'users/h' }, text: 'build ready?', createTime: fut, thread: { name: 'spaces/DM1/threads/t1' } }] });
  if (req.url.startsWith('/v1/spaces/ROOM/messages') && req.method === 'GET') return send({ messages: [{ name: 'spaces/ROOM/messages/r2', sender: { name: 'users/h' }, text: '@Bolt check the QA', createTime: fut, annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/me1' } } }] }, { name: 'spaces/ROOM/messages/r1', sender: { name: 'users/h' }, text: 'random chatter', createTime: fut }] });
  if (req.url.startsWith('/v1/spaces/OLD/messages')) { oldHit = true; return send({ messages: [] }); }
  if (req.url.startsWith('/v1/spaces/DM1/messages') && req.method === 'POST') { let b = ''; req.on('data', d => b += d); return req.on('end', () => { posted.push({ url: req.url, body: JSON.parse(b) }); send({ name: 'spaces/DM1/messages/sent1' }); }); }
  if (req.url.startsWith('/repos/a/b/actions/runs')) return send({ workflow_runs: [ghRun] });
  if (req.url.startsWith('/repos/private/repo')) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
  if (req.url.startsWith('/calendar/v3/calendars/primary/events')) return send({ items: [{ id: 'e1', summary: 'Ads sync', start: { dateTime: soon }, end: { dateTime: later }, hangoutLink: 'https://meet.google.com/abc' }, { id: 'e2', summary: 'Lunch', start: { dateTime: later } }] });
  if (req.url.startsWith('/gmail/v1/users/me/messages?')) return send({ messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
  if (req.url.startsWith('/gmail/v1/users/me/messages/m1')) return send({ id: 'm1', snippet: 'Build is ready', payload: { headers: [{ name: 'From', value: 'Sara <h@x.com>' }, { name: 'Subject', value: 'Build ready' }, { name: 'Date', value: 'Fri' }] } });
  res.writeHead(404); res.end('{}');
});

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); const BASE = 'http://127.0.0.1:' + mock.address().port;
  process.env.GITHUB_API_BASE = BASE; process.env.GCHAT_API_BASE = BASE; process.env.BUDDY_GCHAT_POLL_MS = '3600000'; process.env.GCAL_API_BASE = BASE; process.env.GMAIL_API_BASE = BASE;
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { provider: 'gemini', boss_name: 'Bolt' } }));

  const { pickProvider, Knowledge } = require('../src/assistant');
  // --- AI picking
  const all = ['codex', 'claude', 'gemini'];
  assert(pickProvider('fix this TypeError in main.js', { available: all }) === 'codex', 'code → Codex');
  assert(pickProvider('draft an email to the client about the delay', { available: all }) === 'claude', 'writing → Claude');
  assert(pickProvider('kal mausam kaisa hoga?', { available: all }) === 'gemini', 'quick question → Gemini');
  assert(pickProvider('fix this bug', { available: ['claude', 'gemini'] }) === 'claude', 'falls back to the next best installed AI');

  // --- knowledge
  const KN = path.join(DATA, 'docs'); fs.mkdirSync(path.join(KN, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(KN, 'playables.md'), '# Playable rules\nAppLovin needs mraid.open for the install button.\nKeep the build under 5 MB.\n');
  fs.writeFileSync(path.join(KN, 'other.txt'), 'Lunch menu: biryani on Friday, karahi on Saturday.\n');
  fs.writeFileSync(path.join(KN, 'node_modules', 'skip.md'), 'mraid mraid mraid install button');
  const k = new Knowledge(); const kb = k.build([KN]);
  assert(kb.files === 2, 'knowledge indexes text files and skips node_modules');
  const hit = k.search('how does the install button work mraid'); assert(hit.length && /playables\.md$/.test(hit[0].file) && hit[0].line === 1, 'search finds the right passage with file + line');

  const { Core } = require('../src/core');
  const core = new Core(DATA); const evs = []; core.on('event', (kind, p) => evs.push([kind, p]));
  const opened = []; core.shell = { openExternal: async u => opened.push(u), openPath: async p => { opened.push(p); return ''; } };
  let clip = 'old clip'; core.clipboard = { readText: () => clip, writeText: t => { clip = t; } };
  await core.start(); const a = core.assistant;
  const approve = async (answer) => { const p = await until(() => { const e = evs.find(x => x[0] === 'permission' && !x[2]); if (e) e[2] = true; return e && e[1]; }, 5000, 'approval card'); core.permissionReply(p.id, answer); return p; };

  // --- background job
  const j0 = a.startJob({ prompt: 'research the playable market', provider: 'gemini' }); const j = core.state.jobs.find(x => x.id === j0.id);
  assert(['queued', 'running'].includes(j.status), 'job starts');
  await until(() => j.status === 'done', 10000, 'job done'); assert(/research the playable market/.test(j.output) && j.provider === 'gemini', 'background job runs outside the chat and keeps its output');
  assert(!core.chatBusy && evs.some(e => e[0] === 'jobs'), 'chat stays free; Activity list is broadcast');
  assert(evs.some(e => e[0] === 'say' && /Done: research/.test(e[1].text)), 'Buddy pings when the job finishes');

  // --- /bg command
  core.submit('/bg summarise yesterday'); const bg = await until(() => core.state.jobs.find(x => x.source === 'chat'), 3000, '/bg job');
  await until(() => bg.status === 'done', 10000, '/bg done'); assert(/summarise yesterday/.test(bg.output), '/bg starts a background job from chat');

  // --- workflow: AI → notify → AI with {prev}, plus a safe command
  const wf = a.saveWorkflow({ name: 'Test flow', steps: [{ type: 'ai', prompt: 'first step', provider: 'gemini' }, { type: 'cmd', command: 'echo hello-from-cmd' }, { type: 'notify', text: 'Step 2 said: {prev}' }, { type: 'ai', prompt: 'second step', provider: 'gemini' }] });
  assert(wf.steps.length === 4 && core.state.workflows.length === 1, 'workflow saved');
  let threw = ''; try { a.saveWorkflow({ name: 'x', steps: [] }); } catch (e) { threw = e.message; } assert(/at least one step/.test(threw), 'empty workflow rejected');
  const runId = a.runWorkflow(wf.id).id; const run = core.state.jobs.find(x => x.id === runId); await until(() => run.status === 'done' || run.status === 'error', 15000, 'workflow done');
  assert(run.status === 'done' && run.steps.every(s => s.status === 'done'), 'every step ran: ' + JSON.stringify(run.steps.map(s => s.status)));
  assert(/hello-from-cmd/.test(run.steps[1].output), 'safe local command ran without asking');
  assert(/hello-from-cmd/.test(run.steps[2].output), 'notify step got {prev}');
  assert(/hello-from-cmd/.test(run.steps[3].output) && core.state.workflows[0].runs === 1, 'next AI step receives the previous output; run counted');
  // risky command → approval card → reject stops the workflow
  const wf2 = a.saveWorkflow({ name: 'Risky', steps: [{ type: 'cmd', command: 'git push origin main' }, { type: 'notify', text: 'never' }] });
  const run2Id = a.runWorkflow(wf2.id).id; const run2 = core.state.jobs.find(x => x.id === run2Id); const card = await approve('deny');
  assert(/push/i.test(card.title + card.detail) && card.nice === 'Workflow command', 'risky command asks first: ' + card.title);
  await until(() => run2.status === 'error', 5000, 'rejected workflow'); assert(run2.steps[1].status === 'pending', 'reject stops the workflow; later steps never run');
  assert(core.state.actions.some(x => x.tool === 'cmd' && x.result === 'rejected'), 'rejection is in the action log');
  // templates
  assert(a.templates().length >= 4 && a.addTemplate('briefing').name === 'Morning briefing', 'templates install as workflows');

  // --- schedules that run a workflow / in the background don't need the chat
  const sw = core.state.addSchedule({ workflow: wf.id, title: 'Test flow', at: Date.now() / 1000 - 1 }); core.tick();
  await until(() => core.state.schedules.find(s => s.id === sw.id).last, 3000, 'workflow schedule'); assert(core.state.jobs.some(x => x.source === 'schedule'), 'schedule can run a workflow');
  const sb = core.state.addSchedule({ prompt: 'nightly check', at: Date.now() / 1000 - 1, background: true }); core.tick();
  await until(() => core.state.jobs.some(x => x.source === 'schedule' && /nightly check/.test(x.prompt)), 3000, 'bg schedule'); assert(!core.chatBusy, 'background schedule keeps chat free');

  // --- folder watcher → AI job
  const WD = path.join(DATA, 'builds'); fs.mkdirSync(WD);
  threw = ''; try { a.saveWatcher({ path: path.join(DATA, 'nope') }); } catch (e) { threw = e.message; } assert(/does not exist/.test(threw), 'watcher needs a real folder');
  a.saveWatcher({ path: WD, pattern: '*.html', action: 'ai', prompt: 'QA check {file}' });
  fs.writeFileSync(path.join(WD, 'notes.txt'), 'ignored'); fs.writeFileSync(path.join(WD, 'playable_v3.html'), '<html></html>');
  const wj = await until(() => core.state.jobs.find(x => x.source === 'watch'), 8000, 'watch job');
  assert(/playable_v3\.html/.test(wj.title) && /QA check .*playable_v3\.html/.test(wj.prompt), 'new matching file → AI job with {file} filled in');
  assert(!core.state.jobs.some(x => /notes\.txt/.test(x.title)), 'non-matching files ignored');
  assert(evs.some(e => e[0] === 'say' && /New file: playable_v3/.test(e[1].text)), 'Buddy tells you about the new file');

  // --- GitHub watcher
  a.setGithub({ repos: 'https://github.com/a/b.git, private/repo, not a repo' }); assert(a.githubStatus().repos.join() === 'a/b,private/repo', 'repo list cleaned (URLs, junk dropped)');
  await until(() => a.githubStatus().last, 3000, 'first poll'); const say0 = evs.length;
  ghRun = { ...ghRun, status: 'completed', conclusion: 'failure', updated_at: new Date().toISOString() }; await a.pollGithub(false);
  assert(evs.slice(say0).some(e => e[0] === 'say' && /❌ a\/b: Release failure/.test(e[1].text)), 'failed run → alert');
  assert(core.state.jobs.some(x => x.source === 'github' && x.status === 'event' && /actions\/runs\/7/.test(x.output)), 'run appears in Activity with its link');
  assert(/private\/repo: not found/.test(a.githubStatus().error), 'private repo without token explains what is missing');

  // --- Calendar → meeting reminder; Calendar/Gmail MCP tools
  fs.writeFileSync(path.join(DATA, 'google-chat.json'), JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r', access_token: 'tok', expiry: Date.now() + 3600e3, email: 'bolt@x.com' }));
  await a.pollCalendar();
  const mr = core.state.reminders.find(r => /Meeting at .*Ads sync — https:\/\/meet\.google\.com\/abc/.test(r.message)); assert(mr, 'meeting in 5 min → reminder now with the Meet link');
  assert(!core.state.reminders.some(r => /Lunch/.test(r.message)), 'meetings an hour away wait for a later check');
  await a.pollCalendar(); assert(core.state.reminders.filter(r => /Ads sync/.test(r.message)).length === 1, 'never reminds twice for the same meeting');
  process.env.GCHAT_TOKEN_FILE = path.join(DATA, 'google-chat.json'); const g = require('../src/bridge/google-chat-mcp');
  const ev = JSON.parse((await g.dispatch('tools/call', { name: 'gcal_events', arguments: { days: 1 } })).content[0].text); assert(ev.events.length === 2 && ev.events[0].link === 'https://meet.google.com/abc', 'gcal_events lists meetings');
  const gm = JSON.parse((await g.dispatch('tools/call', { name: 'gmail_unread', arguments: {} })).content[0].text); assert(gm.messages[0].subject === 'Build ready' && /Sara/.test(gm.messages[0].from), 'gmail_unread reads sender + subject');

  // --- Google Chat → notifications on Buddy, reply from the card
  a.gc.since = 0; await a.pollGchat(); assert(a.gc.since && !evs.some(e => e[0] === 'gchat.message'), 'first check only marks the start (no flood of old messages)');
  await a.pollGchat(); const gm2 = evs.filter(e => e[0] === 'gchat.message').map(e => e[1]);
  assert(gm2.some(n => n.from === 'Sara' && n.text === 'build ready?' && n.direct), 'DM from Sara → notification: ' + JSON.stringify(gm2.map(n => n.text)));
  assert(gm2.some(n => n.mention && /check the QA/.test(n.text) && n.space_name === 'Ads'), '@mention in a space → notification');
  assert(!gm2.some(n => n.text === 'mine') && !gm2.some(n => n.text === 'random chatter'), 'own messages and plain space chatter stay quiet');
  assert(!oldHit, 'spaces with no new activity are not fetched');
  const before = a.gchatUnread().unread.length; await a.pollGchat(); assert(a.gchatUnread().unread.length === before, 'the same message never notifies twice');
  const dm = gm2.find(n => n.direct); await a.gchatReply(dm.space, 'on it', dm.thread, dm.id);
  assert(posted.length === 1 && posted[0].body.text === 'on it' && posted[0].body.thread.name === 'spaces/DM1/threads/t1' && /REPLY_MESSAGE/.test(posted[0].url), 'reply from Buddy goes into the same thread');
  assert(!a.gchatUnread().unread.some(n => n.id === dm.id), 'replied message leaves the unread list');
  core.state.settings.gchat_notify = 'all'; a.gc.unread = []; await a.pollGchat(); assert(a.gchatUnread().unread.some(n => n.text === 'random chatter'), '"Every space" mode includes normal space messages'); core.state.settings.gchat_notify = 'direct';

  // --- PC tools through the tool server (what the AIs call)
  const conn = JSON.parse(fs.readFileSync(path.join(DATA, 'connection.json'), 'utf8'));
  const tool = (name, args) => new Promise((resolve, reject) => { const body = JSON.stringify({ name, arguments: args }); const rq = http.request({ host: '127.0.0.1', port: conn.port, path: '/tool', method: 'POST', headers: { Authorization: 'Bearer ' + conn.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => resolve(JSON.parse(d))); }); rq.on('error', reject); rq.end(body); });
  let r = await tool('buddy_open', { target: 'https://example.com/docs' }); assert(r.result.opened === 'https://example.com/docs' && opened.includes('https://example.com/docs'), 'buddy_open: URL opens directly');
  core.state.settings.workdir = WD; const inside = path.join(WD, 'playable_v3.html'); r = await tool('buddy_open', { target: inside }); assert(r.result.opened === inside, 'file inside the working folder opens directly');
  const outside = path.join(KN, 'other.txt'); const pr = tool('buddy_open', { target: outside }); const c2 = await approve('accept'); r = await pr;
  assert(/outside the project/.test(c2.title) && r.result.opened === outside, 'file outside the project asks, Accept opens it');
  const pr2 = tool('buddy_system', { action: 'lock' }); await approve('deny'); r = await pr2; assert(r.result.done === false, 'lock asks first; Reject = nothing happens');
  r = await tool('buddy_clipboard', { text: 'copied by AI' }); assert(clip === 'copied by AI', 'buddy_clipboard writes'); r = await tool('buddy_clipboard', {}); assert(r.result.text === 'copied by AI', 'and reads');
  a.setKnowledge([KN]); r = await tool('buddy_knowledge', { query: 'mraid install' }); assert(r.result.results.length && /playables\.md/.test(r.result.results[0].file), 'buddy_knowledge searches the knowledge folders');
  r = await tool('buddy_background', { prompt: 'second opinion on the design', provider: 'gemini' }); assert(r.result.started, 'buddy_background starts a job');
  assert(core.state.actions.length >= 4 && a.listActions()[0].at >= a.listActions().slice(-1)[0].at, 'action log keeps what happened, newest first');
  // knowledge reaches the system prompt; project notes too
  assert(/playables\.md/.test(core.systemPrompt(false, 'which mraid call does the install button need')), 'relevant knowledge passages go into the prompt');
  core.memory.writeProjectNotes(WD, '# builds\nAlways zip playables before upload.'); assert(/Always zip playables/.test(core.systemPrompt(false, 'hi')), 'per-project notes go into the prompt');
  // chat search
  core.state.addChat('user', 'jigsaw ka tutorial chhota karo', 'claude'); core.state.addChat('assistant', 'Done, tutorial is 3 steps now', 'claude');
  const sr = a.searchChats('jigsaw tutorial'); assert(sr.length === 1 && sr[0].provider === 'claude' && /jigsaw/.test(sr[0].snippet), 'chat search across AIs');
  // quick actions
  const q = a.quick('fix', 'this are a test', ''); await until(() => evs.some(e => e[0] === 'quick.done'), 8000, 'quick done');
  const qd = evs.find(e => e[0] === 'quick.done')[1]; assert(qd.ok && /this are a test/.test(qd.text) && q.provider, 'quick action runs on the selected text');
  assert(/Translate this into Urdu/.test(a.quickPrompt('translate', 'hi', 'Urdu')) && /ONLY the corrected text/.test(a.quickPrompt('fix', 'x')), 'quick prompts');

  // continue elsewhere: terminal (same session) or app / website with the conversation
  const H = require('../src/handoff'); core.state.addChat('user', 'make the jigsaw tutorial shorter', 'gemini'); core.state.addChat('assistant', 'Done — 3 steps now.', 'gemini');
  core.state.settings.sessions[core.sessionKey('gemini')] = 'sess-42';
  let o = H.options(core); assert(o[0].id === 'terminal' && o[0].available && /exact Gemini session/.test(o[0].sub) && o[1].id === 'web' && /browser/.test(o[1].title) && /Gemini/.test(o[1].sub), 'menu: terminal + website when no app is installed');
  assert(/-r sess-42/.test(H.terminalCommand(core).cmd), 'terminal resumes the saved session of this working folder');
  const urls = []; const shellM = { openExternal: async u => urls.push(u) };
  let rr = await H.run(core, 'web', { shell: shellM, clipboard: core.clipboard }); assert(urls[0] === 'https://gemini.google.com/app' && /jigsaw tutorial shorter[\s\S]*3 steps now/.test(clip) && /paste with Ctrl\+V/.test(rr.message), 'website opens and the conversation is copied');
  process.env.BUDDY_FAKE_APPS = 'gemini:Antigravity'; o = H.options(core); assert(o[1].id === 'app' && /Antigravity app/.test(o[1].title), 'desktop app is offered when installed');
  rr = await H.run(core, 'app', { shell: shellM, clipboard: core.clipboard }); assert(urls[1] === 'gemini://' && rr.copied, 'app opens with the conversation on the clipboard'); delete process.env.BUDDY_FAKE_APPS;
  core.state.settings.provider = 'claude'; core.provider = require('../src/providers').make('claude'); core.state.addChat('user', 'short one', 'claude');
  rr = await H.run(core, 'web', { shell: shellM, clipboard: core.clipboard }); assert(/^https:\/\/claude\.ai\/new\?q=Continuing/.test(urls[2]), 'claude.ai gets the conversation pre-filled');
  core.state.settings.provider = 'gemini'; core.provider = require('../src/providers').make('gemini');
  rr = await H.run(core, 'terminal', { shell: shellM, clipboard: core.clipboard }); assert(process.platform === 'win32' ? rr.done : /sess-42/.test(clip), 'terminal: opens on Windows, copies the command elsewhere');

  // voice (Windows parts faked): offline dictation returns text, Windows voice typing presses Win+H, wake word fires once
  process.env.BUDDY_FAKE_PS = path.join(__dirname, 'fake-ps', 'ps.js');
  core.state.settings.dictation = 'offline'; let d = await a.dictate(); assert(d.text === 'hello from the microphone' && evs.some(e => e[0] === 'voice' && e[1].state === 'listening'), 'offline dictation returns what you said');
  core.state.settings.dictation = 'windows'; d = await a.dictate(); assert(d.started && d.mode === 'windows', 'Windows voice typing is started with Win+H');
  const { tapScript } = require('../src/assistant'); assert(/Tap @\(0x5b,0x48\)/.test(tapScript('win', 'h')), 'Win+H key codes');
  core.state.settings.wake_word = true; a.applyWake(); await until(() => evs.some(e => e[0] === 'wake'), 4000, 'wake'); assert(true, '"Hey Buddy" fires the wake event'); a.stopWake();
  core.close(); mock.close(); console.log('assistant tests passed'); process.exit(0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
