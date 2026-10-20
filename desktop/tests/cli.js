// AI tools: versions from the CLIs, newest version from the npm registry (local fake), update via npm / `claude update`,
// never during a reply, retried when the reply ends, status for Settings → AI tools.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-cli-')); const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
process.env.HOME = tmp; process.env.USERPROFILE = tmp; process.env.PATH = bin + path.delimiter + path.dirname(process.execPath);
const NODE = process.execPath;
const ver = n => path.join(tmp, n + '.ver');
// fake CLIs: print their version file; `claude update` bumps itself to 2.5.0
const cli = (n, extra = '') => { fs.writeFileSync(path.join(bin, n), `#!${NODE}\nconst fs=require('fs');const a=process.argv.slice(2);${extra}if(a[0]==='--version'){console.log(fs.readFileSync(${JSON.stringify(ver(n))},'utf8').trim()+' (${n})');}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
fs.writeFileSync(ver('claude'), '2.0.1'); fs.writeFileSync(ver('codex'), '0.40.0');
cli('claude', `if(a[0]==='update'){fs.writeFileSync(${JSON.stringify(ver('claude'))},'2.5.0');console.log('Updated');process.exit(0);}`);
cli('codex');
// fake npm: `npm install -g @openai/codex@latest` -> codex 0.50.0
fs.writeFileSync(path.join(bin, 'npm'), `#!${NODE}\nconst a=process.argv.slice(2);require('fs').appendFileSync(${JSON.stringify(path.join(tmp, 'npm.log'))},a.join(' ')+'\\n');if(a.join(' ')==='install -g @openai/codex@latest')require('fs').writeFileSync(${JSON.stringify(ver('codex'))},'0.50.0');\n`); fs.chmodSync(path.join(bin, 'npm'), 0o755);
const LATEST = { '@anthropic-ai%2Fclaude-code': '2.5.0', '@openai%2Fcodex': '0.50.0' };
const srv = http.createServer((req, res) => { const k = Object.keys(LATEST).find(k => req.url.startsWith('/' + k + '/latest')); res.writeHead(k ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(k ? JSON.stringify({ version: LATEST[k] }) : '{}'); });

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); process.env.BUDDY_NPM_REGISTRY = `http://127.0.0.1:${srv.address().port}`;
  const providers = require('../src/providers'); const { CliTools, newer } = require('../src/clitools');
  const Core = require('../src/core'); const CoreClass = Core.Core || Core;
  assert(newer('2.5.0', '2.0.1') && !newer('2.0.1', '2.5.0') && !newer('1.0.0', '1.0.0') && newer('0.10.0', '0.9.9'), 'semver compare');
  const msgs = [], evs = [];
  const core = { state: { settings: {}, save() {} }, chatBusy: false, installing: null, installTried: {}, system: (t, e) => msgs.push(t), ev: (k, p) => evs.push([k, p]),
    cliRun: CoreClass.prototype.cliRun, ensureNpm: async () => providers.which(['npm']), installCli: async () => false };
  const t = new CliTools(core);
  await t.check();
  let st = t.status(); const by = n => st.tools.find(x => x.name === n);
  assert.strictEqual(by('claude').version, '2.0.1'); assert.strictEqual(by('claude').latest, '2.5.0'); assert(by('claude').update, 'claude update available');
  assert.strictEqual(by('codex').version, '0.40.0'); assert(by('codex').update, 'codex update available');
  assert(!by('gemini').installed, 'gemini not installed');
  assert(evs.some(e => e[0] === 'cli'), 'status is sent to the panel');
  console.log('PASS versions + newest versions');
  // during a reply nothing is touched
  core.chatBusy = true; assert.strictEqual(await t.update('codex', { quiet: true }), false); assert.strictEqual(fs.readFileSync(ver('codex'), 'utf8'), '0.40.0');
  console.log('PASS no update while a reply runs');
  core.chatBusy = false;
  // the full run updates both: claude natively (`claude update`), codex via npm
  st = await t.run({ force: true });
  assert.strictEqual(by('claude').version, '2.5.0', 'claude updated'); assert.strictEqual(by('codex').version, '0.50.0', 'codex updated');
  assert(!by('claude').update && !by('codex').update, 'both up to date');
  const npmLog = fs.readFileSync(path.join(tmp, 'npm.log'), 'utf8');
  assert(npmLog.includes('install -g @openai/codex@latest') && !npmLog.includes('claude-code'), 'npm only for codex; claude used its own updater');
  assert(msgs.some(m => /Claude Code updated 2\.0\.1 → 2\.5\.0/.test(m)) && msgs.some(m => /Codex updated 0\.40\.0 → 0\.50\.0/.test(m)), 'user told about updates');
  console.log('PASS updates: Claude via `claude update`, Codex via npm');
  // nothing newer -> nothing runs
  fs.writeFileSync(path.join(tmp, 'npm.log'), ''); await t.run({ force: true });
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'npm.log'), 'utf8'), '', 'no reinstall when up to date');
  console.log('PASS up to date: nothing reinstalled');
  // automatic off: only checks
  core.state.settings.auto_cli = false; LATEST['@openai%2Fcodex'] = '0.60.0'; await t.run();
  assert.strictEqual(fs.readFileSync(ver('codex'), 'utf8'), '0.50.0'); assert(t.status().tools.find(x => x.name === 'codex').update, 'shows the update');
  console.log('PASS automatic off: shows the update, does not install');
  srv.close(); console.log('\nALL PASSED');
})().catch(e => { console.error('FAIL', e); srv.close(); process.exit(1); });
