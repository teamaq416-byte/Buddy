'use strict';
// Auto-update: fake GitHub API → newer release found → app zip downloaded, checksum verified, unpacked → "ready".
process.env.BUDDY_NO_AUTOINSTALL = '1';
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const { execFileSync } = require('child_process');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
(async () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-stage-')); fs.writeFileSync(path.join(stage, 'package.json'), '{"version":"2.0.1"}'); fs.mkdirSync(path.join(stage, 'src')); fs.writeFileSync(path.join(stage, 'src', 'main.js'), '//new');
  const zip = path.join(os.tmpdir(), 'upd-' + Date.now() + '.zip'); execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'); let tag = 'v2.0.1', badSha = false;
  const srv = http.createServer((req, res) => {
    const base = 'http://127.0.0.1:' + srv.address().port;
    if (req.url === '/repos/bolt/Buddy/releases/latest') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ tag_name: tag, body: 'New stuff', assets: [{ name: 'update.json', browser_download_url: base + '/dl/update.json' }, { name: 'Buddy-app.zip', browser_download_url: base + '/dl/redirect' }, { name: 'Buddy-Setup.cmd', browser_download_url: base + '/dl/setup' }] })); }
    if (req.url === '/dl/update.json') { res.writeHead(200); return res.end(JSON.stringify({ version: tag.slice(1), electron: process.versions.electron || '', app: 'Buddy-app.zip', sha256: badSha ? 'x' : sha })); }
    if (req.url === '/dl/redirect') { res.writeHead(302, { Location: '/dl/app.zip' }); return res.end(); }
    if (req.url === '/dl/app.zip') { res.writeHead(200); return res.end(fs.readFileSync(zip)); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); process.env.BUDDY_UPDATE_API = 'http://127.0.0.1:' + srv.address().port;
  const { Core } = require('../src/core'); const { Updater, newer } = require('../src/updater');
  assert(newer('2.0.10', '2.0.9') && !newer('2.0.0', '2.0.0') && newer('v3.0.0', '2.9.9'), 'version compare');
  const core = new Core(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-data-'))); const ev = []; core.on('event', (k, p) => ev.push([k, p]));
  const u = new Updater(core, { repo: 'bolt/Buddy', version: '2.0.0', appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'upd-app-')), packaged: true });
  let st = await u.check(true);
  assert(st.state === 'ready' && st.version === '2.0.1' && fs.readFileSync(path.join(u.pending.dir, 'src', 'main.js'), 'utf8') === '//new', 'newer release downloaded, verified and unpacked: ' + JSON.stringify(st));
  assert(ev.some(e => e[0] === 'say' && /2\.0\.1 is ready/.test(e[1].text)), 'Buddy says the update is ready');
  const u2 = new Updater(core, { repo: 'bolt/Buddy', version: '2.0.1' }); st = await u2.check(true); assert(st.state === 'latest', 'same version → latest');
  badSha = true; tag = 'v2.0.2'; const u3 = new Updater(core, { repo: 'bolt/Buddy', version: '2.0.0' }); st = await u3.check(true); assert(st.state === 'error' && /checksum/.test(st.message), 'tampered download rejected');
  core.close(); srv.close(); console.log('UPDATE OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
