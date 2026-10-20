'use strict';
// Terminal-free sign-in for the AI CLIs. Buddy runs every login itself, hidden, and sends the user straight to the browser.
//  • Gemini CLI: Buddy runs Google's loopback OAuth with the Gemini CLI's own installed-app client and writes
//    ~/.gemini/oauth_creds.json — exactly the file the CLI writes after its own browser login.
//  • Claude Code: `claude auth login` (hidden). It opens the browser; if the browser shows a code, Buddy asks for it.
//  • Codex: `codex login` (hidden). It opens the browser and finishes on its localhost callback by itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('./providers');
const goauth = require('./bridge/google-oauth');

const LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
// errors that mean "sign in first" (checked only against that provider's own errors)
const NOT_SIGNED = {
  claude: /not logged in|run \/login|invalid api key|oauth (token|session) (has )?expired|could not be refreshed|failed to authenticate|login expired|authentication_error|please log ?in|claude auth login/i,
  codex: /not logged in|codex login|please (re-?)?(log|sign) ?in|refresh token (was|is|has)|token_expired|\b401 unauthorized\b/i,
  gemini: /not signed in|manual authorization|consent could not|set an auth method|invalid_grant|unauthenticated|keyring/i,
};
function needsLogin(name, msg) { msg = String(msg || ''); if (/\bmcp\b|mcp server|mcp_servers/i.test(msg)) return false; return !!(NOT_SIGNED[name] && NOT_SIGNED[name].test(msg)); }

// ---------- Gemini ----------
const GEMINI_SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
// Public "installed app" client shipped inside the open-source Gemini CLI (not a secret in the OAuth sense).
// (no client secret is shipped: the id/secret are read from the user's installed Gemini CLI, which is open source)
const GEMINI_CLIENT = null;
function geminiDir() { return process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini'); }
// Prefer the client id baked into the user's installed Gemini CLI, in case Google ever rotates it.
function geminiClient() {
  try {
    const exe = providers.Gemini && providers.Gemini.executable(); if (!exe) throw new Error('Gemini CLI not installed');
    const shim = providers.resolveNodeShim(exe); let dir = path.dirname(shim ? shim.script : fs.realpathSync(exe));
    for (let i = 0; i < 4 && !fs.existsSync(path.join(dir, 'package.json')); i++) dir = path.dirname(dir);
    for (const sub of ['bundle', 'dist', '.']) {
      const d = path.join(dir, sub); if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter(n => /\.m?js$/.test(n))) {
        const st = fs.statSync(path.join(d, f)); if (st.size > 40e6) continue;
        const t = fs.readFileSync(path.join(d, f), 'utf8'); const id = t.match(/OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+\.apps\.googleusercontent\.com)["']/); const sec = t.match(/OAUTH_CLIENT_SECRET\s*=\s*["'](GOCSPX-[\w-]+)["']/);
        if (id && sec) return { client_id: id[1], client_secret: sec[1] };
      }
    }
  } catch { /* none */ }
  throw new Error('Could not read the Gemini CLI sign-in client');
}
function writeGeminiCreds(tok) {
  const dir = geminiDir(); fs.mkdirSync(dir, { recursive: true });
  const creds = { access_token: tok.access_token, refresh_token: tok.refresh_token, scope: GEMINI_SCOPES.join(' '), token_type: 'Bearer', expiry_date: tok.expiry };
  fs.writeFileSync(path.join(dir, 'oauth_creds.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
  if (tok.email) { const p = path.join(dir, 'google_accounts.json'); let a = {}; try { a = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* new */ } const old = new Set(a.old || []); if (a.active && a.active !== tok.email) old.add(a.active); old.delete(tok.email); fs.writeFileSync(p, JSON.stringify({ active: tok.email, old: [...old] }, null, 2)); }
  // make the CLI use the Google login (not an API key / Vertex) from now on
  const sp = path.join(dir, 'settings.json'); let s = {}, raw = '';
  try { raw = fs.readFileSync(sp, 'utf8').replace(/^\uFEFF/, ''); } catch { /* new file */ }
  if (raw.trim()) { try { s = JSON.parse(raw); } catch { try { s = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { s = null; } } }
  // (unreadable settings.json is left alone — Buddy then passes GOOGLE_GENAI_USE_GCA=true when it runs gemini)
  if (s && typeof s === 'object') { s.security = s.security || {}; s.security.auth = s.security.auth || {}; s.security.auth.selectedType = 'oauth-personal'; if ('selectedAuthType' in s) s.selectedAuthType = 'oauth-personal'; if (raw.trim()) try { fs.copyFileSync(sp, sp + '.buddy-backup'); } catch { /* */ } fs.writeFileSync(sp, JSON.stringify(s, null, 2)); }
}

// ---------- Login manager ----------
class Login {
  constructor(core) { this.core = core; this.cur = null; this.lastOk = {}; }
  // signed in successfully a moment ago? then a new "not signed in" error is a real CLI problem — don't loop the browser
  recentlyOk(which) { return Date.now() - (this.lastOk[which] || 0) < 10 * 60 * 1000; }
  status() { const c = this.cur; return c ? { which: c.which, state: c.state, url: c.url || '', needsCode: !!c.needsCode, message: c.message || '' } : null; }
  emit() { this.core.ev('login', this.status() || { state: 'idle' }); }
  set(patch) { Object.assign(this.cur, patch); this.emit(); }

  start(which, auto = false) {
    if (!LABEL[which]) return false;
    if (this.cur && this.cur.which === which && ['starting', 'browser'].includes(this.cur.state)) { this.emit(); if (this.cur.url && !auto) this.core.openUrl(this.cur.url); return true; }
    this.cancel(true);
    const c = this.cur = { which, state: 'starting', url: '', needsCode: false, message: '', started: Date.now() };
    const label = LABEL[which];
    if (!auto) this.core.system(`${label}: opening your browser to sign in. Sign in there — Buddy finishes the rest.`);
    this.core.ev('say', { agent: '', text: `Sign in to ${label} in your browser 🌐`, reaction: 'waiting' });
    this.emit();
    this.cli(c); // Gemini = Antigravity CLI now (its first prompt runs Google sign-in in the browser); this.gemini() is the old Gemini-CLI OAuth, kept for reference
    return true;
  }
  async gemini(c) {
    try {
      const tok = await goauth.signIn(geminiClient(), url => { if (this.cur !== c) throw new Error('cancelled'); this.set({ state: 'browser', url }); this.core.openUrl(url); }, { scopes: GEMINI_SCOPES, label: 'Gemini CLI', timeoutMs: 10 * 60 * 1000, onServer: s => { c.server = s; } });
      if (this.cur !== c) return;
      writeGeminiCreds(tok);
      this.finish(c, true, tok.email ? 'as ' + tok.email : '');
    } catch (e) { if (this.cur === c) this.finish(c, false, e.message); }
  }
  cli(c) {
    const P = providers.PROVIDERS[c.which]; const exe = c.which === 'gemini' ? providers.Gemini.agyPath() : P && P.executable();
    if (!exe) { this.finish(c, false, `${LABEL[c.which]} CLI is not installed yet.`); if (!process.env.BUDDY_NO_AUTOINSTALL) this.core.installCli(c.which); return; }
    if (c.which === 'gemini') providers.agyAllow();
    const args = c.which === 'claude' ? ['auth', 'login'] : c.which === 'gemini' ? ['-p', 'Reply with just: OK', '--mode', 'plan', '--dangerously-skip-permissions', '--print-timeout', '10m'] : ['login'];
    let child; try { child = providers.spawnCompat(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }); } catch (e) { return this.finish(c, false, e.message); }
    c.child = child; let out = '';
    const onData = d => {
      out += String(d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); if (out.length > 20000) out = out.slice(-20000);
      if (this.cur !== c) return;
      const urls = out.match(/https:\/\/[^\s"'<>]+/g) || []; const url = urls.find(u => /oauth|authorize|login|auth\./i.test(u)) || urls[0];
      const needsCode = (c.which === 'claude' || c.which === 'gemini') && /paste (the )?code|enter (the )?code|authorization code/i.test(out);
      if ((url && url !== c.url) || needsCode !== c.needsCode) this.set({ state: 'browser', url: url || c.url, needsCode });
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (this.cur === c) this.finish(c, false, e.message); });
    child.on('close', code => {
      if (this.cur !== c) return;
      if (c.which === 'gemini') return this.finish(c, code === 0 && /\S/.test(out) && !/sign[ -]?in failed|error/i.test(out.slice(-300)), code === 0 ? '' : (out.trim().split('\n').slice(-2).join(' ') || 'exit code ' + code));
      const ok = code === 0 && !/error|failed|invalid/i.test(out.split('\n').slice(-3).join(' ')) || /login successful|successfully logged in|logged in as/i.test(out);
      this.finish(c, ok, ok ? '' : (out.trim().split('\n').slice(-2).join(' ') || 'exit code ' + code));
    });
    c.timer = setTimeout(() => { if (this.cur === c) { try { child.kill(); } catch { /* */ } this.finish(c, false, 'Sign-in timed out.'); } }, 10 * 60 * 1000);
  }
  // Claude's browser page sometimes shows a code instead of redirecting back: the user pastes it into Buddy.
  submitCode(code) {
    const c = this.cur; code = String(code || '').trim(); if (!c || !c.child || !code) return false;
    try { c.child.stdin.write(code + '\n'); this.set({ message: 'Checking the code…' }); return true; } catch { return false; }
  }
  finish(c, ok, detail) {
    clearTimeout(c.timer); c.state = ok ? 'done' : 'error'; c.message = detail || '';
    try { if (c.child && c.child.exitCode == null) c.child.kill(); } catch { /* */ }
    const label = LABEL[c.which];
    if (ok) { this.lastOk[c.which] = Date.now(); this.core.ev('say', { agent: '', text: `${label} signed in ✓`, reaction: 'done' }); }
    else if (detail !== 'cancelled') this.core.system(`${label} sign-in didn't finish: ${detail}`, true);
    this.emit();
    if (ok && this.core.provider && this.core.provider.name === c.which) this.core.checkProvider();
  }
  cancel(silent) {
    const c = this.cur; if (!c) return;
    clearTimeout(c.timer); try { if (c.child && c.child.exitCode == null) c.child.kill(); } catch { /* */ } try { if (c.server) c.server.close(); } catch { /* */ }
    this.cur = null; if (!silent) { this.core.system(`${LABEL[c.which]} sign-in cancelled.`); this.emit(); }
  }
}

module.exports = { Login, needsLogin, writeGeminiCreds, geminiClient, GEMINI_SCOPES, LABEL };
