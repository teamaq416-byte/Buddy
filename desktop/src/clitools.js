'use strict';
// AI tools (Claude Code, Codex, Antigravity/Gemini CLI): installed version, newest version, automatic updates.
// Buddy checks at start and every 6 hours; when a newer version exists and no chat is running, it updates silently.
// Settings → AI tools shows each version with an Update button; "Keep AI tools up to date" turns it off.
const https = require('https');
const providers = require('./providers');

const IS_WIN = process.platform === 'win32';
const PKG = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini (Antigravity CLI)' };
const NAMES = ['claude', 'codex', 'gemini'];
const CHECK_EVERY = 6 * 3600e3;

function exeOf(name) { return name === 'gemini' ? providers.Gemini.agyPath() : providers.PROVIDERS[name].executable(); }
function semver(s) { const m = String(s || '').match(/(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1, 4).map(Number) : null; }
function newer(a, b) { // is a newer than b
  const x = semver(a), y = semver(b); if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
// newest version from the npm registry (plain HTTPS: works even before Node/npm is installed)
function latestVersion(name) {
  const pkg = PKG[name]; if (!pkg) return Promise.resolve('');
  const base = (process.env.BUDDY_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
  const url = `${base}/${pkg.replace('/', '%2F')}/latest`;
  return new Promise(resolve => {
    const lib = url.startsWith('http://') ? require('http') : https;
    const req = lib.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Buddy' }, timeout: 10000 }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? String(JSON.parse(d).version || '') : ''); } catch { resolve(''); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(''));
  });
}
async function installedVersion(core, name) {
  const exe = exeOf(name); if (!exe) return '';
  const r = await core.cliRun(exe, ['--version'], { timeout: 15000 });
  const v = semver(r.out); return v ? v.join('.') : '';
}
// native Claude installs update with `claude update`; npm installs get `npm i -g pkg@latest`; Antigravity via winget
function isNpmInstall(exe) { return /node_modules|[\\/]npm[\\/]|\.cmd$/i.test(exe || ''); }

class CliTools {
  constructor(core) { this.core = core; this.timer = null; this.busy = ''; }
  get info() { const s = this.core.state.settings; s.cli_info = s.cli_info || {}; return s.cli_info; }
  auto() { return this.core.state.settings.auto_cli !== false && !process.env.BUDDY_NO_AUTOINSTALL; }
  status() {
    const out = { auto: this.core.state.settings.auto_cli !== false, busy: this.busy || this.core.installing || '', tools: [] };
    for (const n of NAMES) { const i = this.info[n] || {}; out.tools.push({ name: n, label: LABEL[n], installed: !!exeOf(n), version: i.version || '', latest: i.latest || '', checked: i.checked || 0, updated: i.updated || 0, error: i.error || '', update: !!(i.latest && i.version && newer(i.latest, i.version)) }); }
    return out;
  }
  emit() { this.core.ev('cli', this.status()); }
  save(name, patch) { this.info[name] = { ...(this.info[name] || {}), ...patch }; this.core.state.save(); }
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.run().catch(() => {}), Number(process.env.BUDDY_CLI_CHECK_MS) || CHECK_EVERY);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  // check versions; install missing CLIs once; update outdated ones when idle
  async run({ force = false } = {}) {
    if (!force && !this.auto()) { await this.check(); return this.status(); }
    for (const n of NAMES) {
      while (this.core.installing) await new Promise(r => setTimeout(r, 3000));
      if (!exeOf(n) && !(this.core.installTried || {})[n] && this.auto()) await this.core.installCli(n, { quiet: true });
    }
    await this.check();
    for (const t of this.status().tools) if (t.installed && t.update) await this.update(t.name, { quiet: true });
    return this.status();
  }
  async check() {
    for (const n of NAMES) {
      if (!exeOf(n)) { this.save(n, { version: '', checked: Date.now() }); continue; }
      const [version, latest] = await Promise.all([installedVersion(this.core, n), latestVersion(n)]);
      this.save(n, { version, latest: latest || (this.info[n] || {}).latest || '', checked: Date.now() });
    }
    this.emit();
  }
  async update(name, { quiet = false } = {}) {
    const exe = exeOf(name); if (!exe) return this.core.installCli(name, { quiet });
    // never swap files under a running reply (Windows locks them); try again on the next check
    if (this.core.chatBusy) { if (!quiet) this.core.system(`${LABEL[name]} will update when the current reply is done.`); this.pending = true; return false; }
    if (this.busy || this.core.installing) return false;
    this.busy = name; this.emit();
    const before = (this.info[name] || {}).version || '';
    let r = { code: -1, out: '' };
    try {
      if (name === 'gemini') r = IS_WIN ? await this.core.cliRun('winget', ['upgrade', '-e', '--id', 'Google.AntigravityCLI', '--accept-source-agreements', '--accept-package-agreements', '--silent']) : { code: 0, out: '' };
      else if (name === 'claude' && !isNpmInstall(exe)) {
        r = await this.core.cliRun(exe, ['update']);
        if (r.code !== 0) { const npm = await this.core.ensureNpm(true); if (npm) r = await this.core.cliRun(npm, ['install', '-g', PKG.claude + '@latest']); }
      } else {
        const npm = await this.core.ensureNpm(true);
        r = npm ? await this.core.cliRun(npm, ['install', '-g', PKG[name] + '@latest']) : { code: -1, out: 'npm is not available' };
      }
      providers.resetNpmCache();
      const after = await installedVersion(this.core, name);
      const ok = !!after && (r.code === 0 || after !== before);
      this.save(name, { version: after || before, updated: ok ? Date.now() : (this.info[name] || {}).updated, error: ok ? '' : String(r.out || '').trim().split('\n').slice(-2).join(' ').slice(0, 300) });
      this.core.state.settings.cli_updated = { ...(this.core.state.settings.cli_updated || {}), [name]: Date.now() }; this.core.state.save();
      if (ok && after !== before) this.core.system(`${LABEL[name]} updated${before ? ` ${before} → ${after}` : ` to ${after}`}.`);
      else if (!ok && !quiet) this.core.system(`${LABEL[name]} update failed: ${(this.info[name] || {}).error || 'unknown error'}`, true);
      return ok;
    } finally { this.busy = ''; this.emit(); }
  }
  // a reply just ended: run an update that had to wait
  idle() { if (this.pending && !this.core.chatBusy) { this.pending = false; setTimeout(() => this.run().catch(() => {}), 3000); } }
}

module.exports = { CliTools, newer, semver, latestVersion, PKG, LABEL };
