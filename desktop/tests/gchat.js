'use strict';
// Google Chat MCP server against a fake Chat API (no Google account needed) + registration into app configs.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-gchat-'));
const HOME = path.join(DATA, 'home'); fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });

// fake Chat API ---------------------------------------------------------------
const sent = [];
const api = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const j = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer tok123') { res.writeHead(401); return res.end('{"error":{"message":"bad token"}}'); }
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const p = decodeURIComponent(u.pathname);
    if (p === '/v1/spaces' && req.method === 'GET') return j({ spaces: [{ name: 'spaces/A1', displayName: 'Ads Team', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' }, { name: 'spaces/D1', spaceType: 'DIRECT_MESSAGE' }] });
    if (p === '/v1/spaces/D1/members/bolt@example.com') return j({ member: { name: 'users/me', type: 'HUMAN' } });
    if (p === '/v1/spaces/D1/members') return j({ memberships: [{ member: { name: 'users/1', displayName: 'Sara Khan', type: 'HUMAN' } }, { member: { name: 'users/me', displayName: 'Bolt', type: 'HUMAN' } }] });
    if (p === '/v1/spaces/A1/members') return j({ memberships: [{ member: { name: 'users/1', displayName: 'Sara Khan', type: 'HUMAN' }, role: 'ROLE_MEMBER' }] });
    if (p === '/v1/spaces/A1/messages' && req.method === 'GET') {
      const all = [{ name: 'spaces/A1/messages/m2', createTime: '2026-10-14T10:00:00Z', sender: { name: 'users/1' }, text: 'Build is ready for review', thread: { name: 'spaces/A1/threads/t1' } }, { name: 'spaces/A1/messages/m1', createTime: '2026-10-14T09:00:00Z', sender: { name: 'users/1' }, text: 'Morning all' }];
      const f = u.searchParams.get('filter') || ''; const since = (f.match(/createTime > "([^"]+)"/) || [])[1];
      return j({ messages: since ? all.filter(m => m.createTime > since) : all });
    }
    if (p === '/v1/spaces/D1/messages' && req.method === 'GET') return j({ messages: [] });
    if (p === '/v1/users/me/spaces/A1/spaceReadState') return j({ lastReadTime: '2026-10-14T09:30:00Z' });
    if (p === '/v1/users/me/spaces/D1/spaceReadState') return j({ lastReadTime: '2026-10-14T12:00:00Z' });
    if (p === '/v1/spaces/A1/messages' && req.method === 'POST') { sent.push({ q: u.search, body: JSON.parse(body) }); return j({ name: 'spaces/A1/messages/new1', createTime: '2026-10-14T11:00:00Z' }); }
    if (p === '/v1/spaces:findDirectMessage') { res.writeHead(404); return res.end('{"error":{"message":"not found"}}'); }
    if (p === '/v1/spaces:setup') { sent.push({ setup: JSON.parse(body) }); return j({ name: 'spaces/D2' }); }
    if (p === '/v1/spaces/D2/messages' && req.method === 'POST') { sent.push({ dm: JSON.parse(body) }); return j({ name: 'spaces/D2/messages/x', createTime: '2026-10-14T11:01:00Z' }); }
    res.writeHead(404); res.end('{"error":{"message":"no route ' + p + '"}}');
  });
});

function rpc(proc, id, method, params) {
  return new Promise(resolve => {
    const onLine = buf => { for (const line of String(buf).split('\n')) { if (!line.trim()) continue; const m = JSON.parse(line); if (m.id === id) { proc.stdout.off('data', onLine); resolve(m); } } };
    proc.stdout.on('data', onLine); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const text = r => JSON.parse(r.result.content[0].text);

(async () => {
  await new Promise(r => api.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + api.address().port;
  fs.writeFileSync(path.join(DATA, 'google-chat.json'), JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r', access_token: 'tok123', expiry: Date.now() + 3600000, email: 'bolt@example.com' }));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'bridge', 'google-chat-mcp.js')], { env: { ...process.env, BUDDY_DATA_DIR: DATA, GCHAT_API_BASE: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  const init = await rpc(srv, 1, 'initialize', { protocolVersion: '2025-03-26' }); assert(init.result.serverInfo.name === 'google-chat', 'initialize');
  assert((await rpc(srv, 2, 'tools/list')).result.tools.length === 10, 'tools listed (chat + calendar + gmail)');
  const sp = text(await rpc(srv, 3, 'tools/call', { name: 'gchat_spaces', arguments: {} }));
  assert(sp.spaces.length === 2 && sp.spaces[1].name === 'DM: Sara Khan', 'spaces with DM labelled by person: ' + JSON.stringify(sp.spaces));
  const ms = text(await rpc(srv, 4, 'tools/call', { name: 'gchat_messages', arguments: { space: 'ads team', limit: 10 } }));
  assert(ms.space === 'spaces/A1' && ms.messages.length === 2 && ms.messages[1].from === 'Sara Khan' && ms.messages[0].text === 'Morning all', 'messages by display name, oldest first, sender resolved');
  const un = text(await rpc(srv, 5, 'tools/call', { name: 'gchat_unread', arguments: {} }));
  assert(un.spaces.length === 1 && un.spaces[0].unread === 1 && un.spaces[0].messages[0].text === 'Build is ready for review', 'unread uses read state');
  const se = text(await rpc(srv, 6, 'tools/call', { name: 'gchat_search', arguments: { query: 'READY' } }));
  assert(se.hits.length === 1 && se.hits[0].id === 'spaces/A1/messages/m2', 'search is case-insensitive');
  const snd = text(await rpc(srv, 7, 'tools/call', { name: 'gchat_send', arguments: { space: 'Ads Team', text: 'On it 👍', thread: 'spaces/A1/messages/m2' } }));
  assert(snd.sent && sent[0].body.text === 'On it 👍' && sent[0].body.thread.name === 'spaces/A1/threads/m2' && /REPLY_MESSAGE_FALLBACK/.test(sent[0].q), 'send threaded reply');
  const dm = text(await rpc(srv, 8, 'tools/call', { name: 'gchat_dm', arguments: { email: 'hamza@example.com', text: 'ping' } }));
  assert(dm.sent && dm.space === 'spaces/D2' && sent[1].setup.memberships[0].member.name === 'users/hamza@example.com' && sent[2].dm.text === 'ping', 'DM creates the space then sends');
  const bad = await rpc(srv, 9, 'tools/call', { name: 'gchat_messages', arguments: { space: 'nope' } });
  assert(bad.result.isError && /No space or DM matching/.test(bad.result.content[0].text), 'unknown space → helpful error');
  srv.stdin.end();

  // registration into Claude Code (~/.claude.json fallback), Codex config.toml, Claude Desktop ---------------------
  const core = require('../src/core.js');
  const prevHome = os.homedir; os.homedir = () => HOME; process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CODEX_HOME = path.join(HOME, '.codex');
  const prevPath = process.env.PATH; process.env.PATH = ''; // no `claude` CLI → JSON fallback
  fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const notes = core.registerGoogleChat(DATA);
  assert(notes.includes('Claude Code') && notes.includes('Codex'), 'registered: ' + notes.join(', '));
  const cj = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')); assert(cj.mcpServers['google-chat'].env.BUDDY_DATA_DIR === DATA && /google-chat-mcp\.js$/.test(cj.mcpServers['google-chat'].args[0]), 'claude.json entry');
  const toml = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8'); assert(/\[mcp_servers\.other\]/.test(toml) && /\[mcp_servers\.google-chat\]/.test(toml) && /\[mcp_servers\.google-chat\.env\]/.test(toml), 'codex toml keeps other servers');
  const st = core.gchatStatus(DATA); assert(st.account === 'bolt@example.com' && st.apps.claude_code && st.apps.codex, 'status: ' + JSON.stringify(st));
  core.registerGoogleChat(DATA, true);
  assert(!JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')).mcpServers['google-chat'] && !/google-chat/.test(fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8')), 'remove cleans both');
  os.homedir = prevHome; process.env.PATH = prevPath;
  // OAuth loopback sign-in against a fake token endpoint --------------------------------------------------
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/token') { const f = new URLSearchParams(b); res.end(JSON.stringify(f.get('grant_type') === 'authorization_code' && f.get('code') === 'CODE9' && f.get('code_verifier') ? { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } : { error: 'bad' })); }
    else res.end(JSON.stringify({ email: 'bolt@example.com' })); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r)); const fb = 'http://127.0.0.1:' + fake.address().port;
  process.env.GOOGLE_OAUTH_TOKEN_URL = fb + '/token'; process.env.GOOGLE_OAUTH_USERINFO_URL = fb + '/userinfo';
  delete require.cache[require.resolve('../src/bridge/google-oauth')]; const oauth = require('../src/bridge/google-oauth');
  const tok = await oauth.signIn({ client_id: 'cid', client_secret: 'sec' }, url => {
    const u = new URL(url); assert(u.searchParams.get('code_challenge_method') === 'S256' && /chat\.messages/.test(u.searchParams.get('scope')), 'consent url has PKCE + scopes');
    const back = u.searchParams.get('redirect_uri') + '/?state=' + u.searchParams.get('state') + '&code=CODE9';
    http.get(back, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => assert(/Signed in/.test(b), 'browser gets a success page')); });
  });
  assert(tok.refresh_token === 'rt' && tok.email === 'bolt@example.com' && tok.client_id === 'cid', 'token saved with email');
  fs.writeFileSync(path.join(DATA, 'cred.json'), JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }));
  let err = ''; try { oauth.readClient(path.join(DATA, 'cred.json')); } catch (e) { err = e.message; } assert(/Desktop app/.test(err), 'web client rejected with guidance');
  fake.close();
  api.close(); console.log('GCHAT OK');
})().catch(e => { console.error(e); process.exit(1); });
