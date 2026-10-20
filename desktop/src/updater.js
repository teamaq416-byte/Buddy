'use strict';
// Auto-update from GitHub Releases. Every few hours Buddy reads the latest release of its repo; when the version is newer
// it downloads the small app payload (Buddy-app.zip, checked against update.json's sha256), unpacks it next to the data
// folder and tells the UI "Update ready". Restart swaps the app folder and starts the new version. If a release needs a
// new Electron runtime, the one-file installer (Buddy-Setup.cmd) is downloaded and run instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const API = process.env.BUDDY_UPDATE_API || 'https://api.github.com';
const IS_WIN = process.platform === 'win32';

function get(url, { json = false, file = null, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'Buddy-updater', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), { json, file, redirects: redirects - 1 })); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      if (file) { const out = fs.createWriteStream(file); res.pipe(out); out.on('finish', () => out.close(() => resolve(file))); out.on('error', reject); return; }
      let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; }); res.on('end', () => { try { resolve(json ? JSON.parse(s) : s); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timed out')));
  });
}
const newer = (a, b) => { const p = v => String(v || '').replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0); const x = p(a), y = p(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

class Updater {
  constructor(core, opts = {}) {
    this.core = core; this.repo = opts.repo || ''; this.version = opts.version || '0.0.0'; this.appDir = opts.appDir || ''; this.exe = opts.exe || process.execPath;
    this.packaged = !!opts.packaged; this.dir = path.join(core.folder, 'updates'); this.state = { state: 'idle', version: this.version };
  }
  status() { return { ...this.state, current: this.version, repo: this.repo, enabled: this.enabled() }; }
  enabled() { return !!this.repo && !process.env.BUDDY_NO_UPDATE && this.core.state.settings.auto_update !== false; }
  set(patch) { this.state = { ...this.state, ...patch }; this.core.ev('update', this.status()); }
  start() { if (!this.repo || process.env.BUDDY_NO_UPDATE) return; setTimeout(() => this.check().catch(() => {}), 30000); this.timer = setInterval(() => { if (this.enabled()) this.check().catch(() => {}); }, 6 * 3600 * 1000); }
  stop() { clearInterval(this.timer); }
  async check(manual = false) {
    if (!this.repo) { if (manual) this.set({ state: 'error', message: 'No update repo set in package.json (buddy.updateRepo).' }); return this.status(); }
    if (this.busy || this.state.state === 'ready') return this.status();
    this.busy = true;
    try {
      if (manual) this.set({ state: 'checking' });
      const rel = await get(`${API}/repos/${this.repo}/releases/latest`, { json: true });
      const ver = String(rel.tag_name || '').replace(/^v/, '');
      if (!newer(ver, this.version)) { this.set({ state: 'latest', checkedAt: Date.now() }); return this.status(); }
      const asset = n => (rel.assets || []).find(a => a.name === n);
      const manifestA = asset('update.json'); const manifest = manifestA ? await get(manifestA.browser_download_url, { json: true }) : {};
      const notes = String(rel.body || '').slice(0, 600); const dir = path.join(this.dir, ver); fs.mkdirSync(dir, { recursive: true });
      this.set({ state: 'downloading', version: ver, notes });
      const needSetup = manifest.electron && process.versions.electron && manifest.electron !== process.versions.electron;
      if (needSetup || !asset(manifest.app || 'Buddy-app.zip')) {
        const s = asset('Buddy-Setup.cmd'); if (!s) throw new Error('release has no Buddy-app.zip or Buddy-Setup.cmd');
        const f = await get(s.browser_download_url, { file: path.join(dir, 'Buddy-Setup.cmd') });
        this.pending = { kind: 'setup', file: f, version: ver };
      } else {
        const zipFile = await get(asset(manifest.app || 'Buddy-app.zip').browser_download_url, { file: path.join(dir, 'Buddy-app.zip') });
        if (manifest.sha256) { const h = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex'); if (h !== manifest.sha256) throw new Error('download checksum mismatch'); }
        const out = path.join(dir, 'app'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
        const r = IS_WIN ? spawnSync('tar', ['-xf', zipFile, '-C', out], { windowsHide: true }) : spawnSync('unzip', ['-q', '-o', zipFile, '-d', out]);
        if (r.status !== 0 || !fs.existsSync(path.join(out, 'package.json'))) {
          if (!IS_WIN) throw new Error('could not unpack the update');
          const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath $env:BZ -DestinationPath $env:BO -Force`], { windowsHide: true, env: { ...process.env, BZ: zipFile, BO: out } });
          if (ps.status !== 0 || !fs.existsSync(path.join(out, 'package.json'))) throw new Error('could not unpack the update');
        }
        this.pending = { kind: 'app', dir: out, version: ver };
      }
      this.set({ state: 'ready', version: ver, notes });
      this.core.ev('say', { agent: '', text: `Buddy ${ver} is ready — restart to update ✨`, reaction: 'done' });
      return this.status();
    } catch (e) { this.set({ state: 'error', message: e.message }); return this.status(); }
    finally { this.busy = false; }
  }
  // Swap in the new version after Buddy quits, then start it again. Returns false when there is nothing to apply.
  apply(quit) {
    const p = this.pending; if (!p) return false;
    if (p.kind === 'setup') { spawn('cmd.exe', ['/c', 'start', '""', p.file], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); quit(); return true; }
    if (!this.packaged || !this.appDir) { this.set({ state: 'error', message: 'Updates apply only to the installed app (not when running from source).' }); return false; }
    const pid = process.pid;
    if (IS_WIN) {
      const f = path.join(os.tmpdir(), `buddy-update-${Date.now()}.cmd`);
      fs.writeFileSync(f, ['@echo off', ':wait', `tasklist /fi "PID eq ${pid}" | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
        `robocopy "${p.dir}" "${this.appDir}" /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul`, `start "" "${this.exe}"`, '(goto) 2>nul & del "%~f0"', ''].join('\r\n'));
      spawn('cmd.exe', ['/c', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      const f = path.join(os.tmpdir(), `buddy-update-${Date.now()}.sh`);
      fs.writeFileSync(f, `#!/bin/sh\nwhile kill -0 ${pid} 2>/dev/null; do sleep 1; done\nrm -rf '${this.appDir}' && cp -R '${p.dir}' '${this.appDir}'\n'${this.exe}' >/dev/null 2>&1 &\nrm -f "$0"\n`); fs.chmodSync(f, 0o755);
      spawn('sh', [f], { detached: true, stdio: 'ignore' }).unref();
    }
    quit(); return true;
  }
}
module.exports = { Updater, newer };
