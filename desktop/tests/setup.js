'use strict';
// Background CLI setup: every missing AI CLI gets installed once, silently (no sign-in popups); installer commands are the official ones.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };

(async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-setup-home-'));
  const BIN = path.join(HOME, '.local', 'bin'); fs.mkdirSync(BIN, { recursive: true });
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.PATH = '/usr/bin:/bin';
  delete process.env.BUDDY_NO_AUTOINSTALL; delete process.env.GEMINI_API_KEY; process.env.BUDDY_NPM_REGISTRY = 'http://127.0.0.1:9';
  const { Core } = require('../src/core');
  const core = new Core(fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-setup-data-')));
  const ran = []; const make = n => { const f = path.join(BIN, n); fs.writeFileSync(f, '#!/bin/sh\necho ok\n'); fs.chmodSync(f, 0o755); };
  core.cliRun = async (cmd, args) => {
    const line = [cmd, ...args].join(' '); ran.push(line);
    if (/claude\.ai\/install/.test(line)) make('claude');
    if (/antigravity\.google\/cli\/install/.test(line)) make('agy');
    if (/install -g @openai\/codex/.test(line)) make('codex');
    return { code: 0, out: 'done' };
  };
  core.ensureNpm = async () => '/usr/bin/npm';
  const signIns = []; core.signIn = n => signIns.push(n);
  core.provider = { name: 'claude', label: 'Claude' }; core.checkProvider = () => {};
  await core.cliSetup();
  const P = require('../src/providers');
  assert(P.Claude.executable() && P.Codex.executable() && P.Gemini.agyPath(), 'Claude, Codex and Gemini (Antigravity) all installed in the background: ' + ran.join(' | '));
  assert(ran.some(l => /claude\.ai\/install\.sh/.test(l)) && ran.some(l => /npm install -g @openai\/codex/.test(l)) && ran.some(l => /antigravity\.google\/cli\/install\.sh/.test(l)), 'official installers used');
  assert(signIns.length === 0, 'background installs do not pop up sign-in');
  const n = ran.length; await core.cliSetup(); const again = ran.slice(n).filter(l => !/ --version$/.test(l)); assert(!again.length, 'second run: only version checks, nothing reinstalled (' + again.join(' | ') + ')');
  core.close(); console.log('SETUP OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
