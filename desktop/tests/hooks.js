'use strict';
// Approval hooks: Codex / Antigravity tool calls → Buddy policy → Accept/Reject toast → decision back to the CLI.
process.env.BUDDY_NO_AUTOINSTALL = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hooks-home-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CODEX_HOME = path.join(HOME, '.codex'); process.env.GEMINI_CLI_HOME = HOME;
const HOOK = path.join(__dirname, '..', 'src', 'bridge', 'buddy-hook.js');
function runHook(flavor, data, payload) {
  return new Promise(resolve => { const p = spawn(process.execPath, [HOOK, flavor], { env: { ...process.env, BUDDY_DATA_DIR: data } }); let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => resolve(out ? JSON.parse(out) : null)); p.stdin.end(JSON.stringify(payload)); });
}

(async () => {
  const { Core, connectCodex } = require('../src/core');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hooks-data-'));
  const core = new Core(DATA); await core.server.start();
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hooks-work-')); core.state.settings.workdir = WORK;
  core.provider = { name: 'codex', label: 'Codex' };
  let answer = 'deny'; const shown = [];
  core.on('event', (k, p) => { if (k === 'permission') { shown.push(p); setTimeout(() => core.permissionReply(p.id, answer), 50); } });

  // hooks registered for both CLIs, once (re-running does not duplicate them)
  connectCodex(DATA); connectCodex(DATA);
  const ch = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert(ch.PreToolUse.length === 1 && ch.PermissionRequest.length === 1 && /buddy-hook.* codex-pre/.test(ch.PreToolUse[0].hooks[0].command) && ch.PreToolUse[0].hooks[0].timeout >= 600, 'Codex hooks.json: PreToolUse + PermissionRequest → Buddy (no duplicates)');
  const { installAgyHooks } = require('../src/core'); installAgyHooks(DATA); installAgyHooks(DATA);
  const ah = JSON.parse(fs.readFileSync(path.join(HOME, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert(ah['buddy-approvals'].enabled && /buddy-hook.* agy-pre/.test(ah['buddy-approvals'].PreToolUse[0].hooks[0].command) && Object.keys(ah).length === 1, 'Antigravity hooks.json: Buddy approval hook registered once');
  // the wrapper script itself starts the hook (what the CLIs actually execute)
  const wrapped = await new Promise(res => { const p = spawn('sh', ['-c', ch.PreToolUse[0].hooks[0].command]); let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => res(o)); p.stdin.end('{"tool_name":"Bash","tool_input":{"command":"ls"}}'); });
  assert(wrapped === '', 'wrapper script runs the hook (neutral when no Buddy task is active)');
  core.hookMarker('codex');

  // normal work: no toast, no decision (Codex proceeds)
  let r = await runHook('codex-pre', DATA, { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: WORK });
  assert(r === null && shown.length === 0, 'local test command runs without a toast');
  // risky: toast shown, Reject → deny goes back to Codex
  r = await runHook('codex-pre', DATA, { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: WORK });
  assert(shown.length === 1 && /Git push/.test(shown[0].title) && r.hookSpecificOutput.permissionDecision === 'deny', 'git push → Accept/Reject toast → Reject denies it in Codex');
  // install: PreToolUse → toast → Accept; Codex then asks for the sandbox escalation of that same call → no second toast
  answer = 'accept';
  r = await runHook('codex-pre', DATA, { tool_name: 'Bash', tool_input: { command: 'npm install lodash' }, cwd: WORK });
  assert(shown.length === 2 && r === null, 'npm install → toast → Accept lets Codex run it');
  r = await runHook('codex-perm', DATA, { tool_name: 'Bash', tool_input: { command: 'npm install lodash' }, cwd: WORK });
  assert(shown.length === 2 && r.hookSpecificOutput.decision.behavior === 'allow', 'its sandbox escalation is allowed without a second toast');
  // a sandbox escalation on its own → toast
  r = await runHook('codex-perm', DATA, { tool_name: 'Bash', tool_input: { command: 'curl -X POST https://example.com' }, cwd: WORK });
  assert(shown.length === 3 && r.hookSpecificOutput.decision.behavior === 'allow', 'escalation request → toast → Accept → allow');
  r = await runHook('codex-perm', DATA, { tool_name: 'Bash', tool_input: { command: 'npm install lodash' }, cwd: WORK });
  assert(shown.length === 4, 'Accept is one-time: the same install later asks again');
  // apply_patch outside the project → toast
  answer = 'deny';
  r = await runHook('codex-pre', DATA, { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: /etc/hosts\n@@\n-a\n+b\n*** End Patch' }, cwd: WORK });
  assert(shown.length === 5 && shown[4].category === 'outside' && r.hookSpecificOutput.permissionDecision === 'deny', 'apply_patch outside the project → toast → denied');

  // Antigravity
  core.provider = { name: 'gemini', label: 'Gemini' }; core.hookMarker('gemini');
  r = await runHook('agy-pre', DATA, { toolCall: { name: 'view_file', args: { AbsolutePath: path.join(WORK, 'a.js') } } });
  assert(r.decision === 'auto_approve', 'Antigravity read → auto_approve (no toast)');
  answer = 'accept';
  r = await runHook('agy-pre', DATA, { toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf build' } } });
  assert(shown.length === 6 && r.decision === 'auto_approve', 'Antigravity delete command → toast → Accept → auto_approve');
  answer = 'deny';
  r = await runHook('agy-pre', DATA, { toolCall: { name: 'write_to_file', args: { TargetFile: path.join(HOME, 'outside.txt') } } });
  assert(shown.length === 7 && r.decision === 'deny', 'Antigravity write outside the project → toast → Reject → deny');

  // user's own sessions (Buddy not running a task): hook stays neutral
  core.hookMarker(null);
  r = await runHook('agy-pre', DATA, { toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf build' } } });
  const r2 = await runHook('codex-pre', DATA, { tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert(r.decision === 'ask' && r2 === null && shown.length === 7, 'outside Buddy tasks the hook does not interfere');
  core.close(); console.log('HOOKS OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
