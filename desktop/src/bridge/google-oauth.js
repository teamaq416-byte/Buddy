'use strict';
// Minimal Google OAuth 2.0 (installed-app / loopback flow) — no dependencies.
// Shared by the Buddy app (sign-in) and the Google Chat MCP server (token refresh).
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const USERINFO_URL = process.env.GOOGLE_OAUTH_USERINFO_URL || 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.spaces.create',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/chat.users.readstate.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function request(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Accept: 'application/json', ...headers }; if (data != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const req = mod.request(u, { method, headers: h, timeout }, res => {
      let out = ''; res.on('data', d => out += d); res.on('end', () => {
        let json = null; try { json = out ? JSON.parse(out) : {}; } catch { json = { raw: out }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else { const msg = (json && json.error && (json.error.message || json.error_description || json.error)) || out.slice(0, 200) || ('HTTP ' + res.statusCode); const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.status = res.statusCode; e.body = json; reject(e); }
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timed out')));
    if (data != null) req.write(data); req.end();
  });
}

// credentials.json from Google Cloud Console (OAuth client, type "Desktop app")
function readClient(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); const c = j.installed || j.web || j;
  if (!c.client_id || !c.client_secret) throw new Error('This is not an OAuth client file. In Google Cloud Console create an OAuth client of type "Desktop app" and download its JSON.');
  if (j.web && !j.installed) throw new Error('This OAuth client is a "Web application". Create one of type "Desktop app" instead.');
  return { client_id: c.client_id, client_secret: c.client_secret };
}

// Opens the consent screen (via `open(url)`), waits for Google to redirect to the loopback port, exchanges the code.
async function signIn(client, open, { scopes = SCOPES, timeoutMs = 5 * 60 * 1000, label = 'Google Chat', onServer = null } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const stateTok = crypto.randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    let done = false; const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { server.close(); } catch { /* */ } err ? reject(err) : resolve(val); };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1'); if (u.pathname !== '/') { res.writeHead(404); return res.end(); }
      const H = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const page = (title, text) => { title = H(title); text = H(text); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:15px system-ui;background:#0c0d12;color:#eef0fa;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:42px">${title === 'Signed in' ? '✓' : '✕'}</div><h2>${title}</h2><p style="color:#969cb2">${text}</p></div>`); };
      if (u.searchParams.get('error')) { page('Sign-in failed', u.searchParams.get('error')); return finish(new Error('Google sign-in was cancelled: ' + u.searchParams.get('error'))); }
      if (!u.searchParams.get('code')) { res.writeHead(204); return res.end(); } // stray request (prefetch, favicon…) — keep waiting
      if (u.searchParams.get('state') !== stateTok) { page('Sign-in failed', 'Bad response.'); return finish(new Error('Bad OAuth response.')); }
      try {
        const redirect = `http://127.0.0.1:${server.address().port}`;
        const tok = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: u.searchParams.get('code'), client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }).toString() });
        if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove Buddy from https://myaccount.google.com/permissions and sign in again.');
        let email = ''; try { email = (await request(USERINFO_URL, { headers: { Authorization: 'Bearer ' + tok.access_token } })).email || ''; } catch { /* optional */ }
        page('Signed in', `Buddy is connected to ${label}${email ? ' as ' + email : ''}. You can close this tab.`);
        finish(null, { ...client, refresh_token: tok.refresh_token, access_token: tok.access_token, expiry: Date.now() + (tok.expires_in || 3600) * 1000 - 60000, email, scopes });
      } catch (e) { page('Sign-in failed', e.message); finish(e); }
    });
    const timer = setTimeout(() => finish(new Error('Google sign-in timed out.')), timeoutMs);
    if (onServer) onServer(server);
    server.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${server.address().port}`;
      const url = AUTH_URL + '?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state: stateTok, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      Promise.resolve().then(() => open(url)).catch(e => finish(e));
    });
  });
}

// Returns a valid access token, refreshing and persisting when needed.
async function accessToken(file) {
  let t; try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Google Chat is not connected in Buddy. Open Buddy → Connect → Google Chat.'); }
  if (t.access_token && t.expiry && Date.now() < t.expiry) return t.access_token;
  const r = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }).toString() })
    .catch(e => { throw new Error('Google sign-in expired (' + e.message + '). Open Buddy → Connect → Google Chat and sign in again.'); });
  t.access_token = r.access_token; t.expiry = Date.now() + (r.expires_in || 3600) * 1000 - 60000;
  try { fs.writeFileSync(file, JSON.stringify(t, null, 2)); } catch { /* read-only is fine */ }
  return t.access_token;
}

module.exports = { request, readClient, signIn, accessToken, SCOPES };
