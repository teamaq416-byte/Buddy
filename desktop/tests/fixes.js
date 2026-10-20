'use strict';
// Regression checks for the review fixes: no stuck chat on spawn failure, no install loop, policy false positives, memory notes, sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.env.GEMINI_API_KEY = 'test-key';

(async () => {
  const P = require('../src/providers');
  // 1. missing working folder → clean error, no hang
  const g = new P.Gemini(); let got = null;
  process.env.PATH = path.join(__dirname, 'fake-gemini') + path.delimiter + process.env.PATH;
  const t0 = Date.now();
  await Promise.race([g.run('hi', { system: '', workdir: path.join(os.tmpdir(), 'nope-' + Date.now()), agent: false }, (k, d) => { if (k === 'error' || k === 'done') got = [k, d]; }), sleep(8000)]);
  assert(got && got[0] === 'error' && /does not exist/.test(got[1]) && Date.now() - t0 < 5000, 'deleted working folder → error, chat not stuck: ' + (got && got[1]));
  // 2. spawn of a missing program → error event, no hang
  const c = new P.Claude(); c.label = 'Claude'; let err = null;
  try { const { proc } = c.spawnCli(['/definitely/not/here/claude'], '', os.tmpdir()); const code = await Promise.race([c.waitExit(proc), sleep(5000).then(() => 'hang')]); err = [code, c.spawnErr && c.spawnErr.code]; } catch (e) { err = ['threw', e.message]; }
  assert(err && err[0] !== 'hang', 'missing executable does not hang: ' + JSON.stringify(err));

  // 3. auto-install runs once, not in a loop
  delete process.env.BUDDY_NO_AUTOINSTALL;
  const { Core } = require('../src/core');
  const core = new Core(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-fix-')));
  let installs = 0; const real = core.installCli.bind(core);
  core.installCli = async n => { installs++; return real(n); };
  core.provider = { name: 'codex', label: 'Codex', available: async () => [false, 'Codex CLI not found.'] };
  const savedPath = process.env.PATH; process.env.PATH = '/nonexistent';
  core.checkProvider(); await sleep(1500); process.env.PATH = savedPath;
  assert(installs <= 1, 'CLI auto-install tried once (was an endless loop): ' + installs);

  // 4. policy
  const { classify } = require('../src/policy'); const w = { workdir: '/home/u/p' }; const k = (t, i) => classify(t, i, w).kind;
  assert(['npm run format', 'git restore --staged a.js', 'ls x 2>/dev/null', 'node -e "[1].map(x=>x*2)"', 'grep -rn tokenize src'].every(cmd => k('Bash', { command: cmd }) === 'auto'), 'normal dev commands no longer ask for approval');
  assert(k('mcp__Google_Drive__trash_file', {}) === 'approve' && k('Bash', { command: 'format c:' }) === 'approve' && k('Bash', { command: 'cat .env' }) === 'approve' && k('Bash', { command: 'git push' }) === 'approve', 'destructive tools still need approval');

  // 5. memory: newest notes survive truncation, /rule heading not duplicated
  const { Memory } = require('../src/memory'); const m = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mem-')));
  for (let i = 0; i < 400; i++) m.remember('note number ' + i + ' ' + 'x'.repeat(40));
  assert(/note number 399/.test(m.promptText()), 'newest memory note reaches the prompt');
  m.addRule('rule one'); m.addRule('rule two'); assert((m.read('profile').match(/^## Rules/gm) || []).length === 1, 'one Rules heading');

  // 6. sessions per working folder
  core.state.settings.workdir = '/a'; const ka = core.sessionKey('claude'); core.state.settings.workdir = '/b';
  assert(ka !== core.sessionKey('claude'), 'sessions are per working folder');
  core.close(); console.log('FIXES OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
