'use strict';
// Approval hook for Codex (PreToolUse + PermissionRequest) and Antigravity/Gemini (PreToolUse).
// Neither CLI can show an approval prompt when Buddy runs it in the background, so their hooks call Buddy: Buddy applies its
// permission policy and, for risky actions, shows the Accept / Reject toast and waits. Outside a Buddy-run session the hook
// stays out of the way (no decision), so the user's own terminal sessions behave as usual.
//   argv[2] = codex-pre | codex-perm | agy-pre      env BUDDY_DATA_DIR = Buddy's data folder
const fs = require('fs');
const path = require('path');
const http = require('http');

const flavor = process.argv[2] || 'codex-pre';
const dataDir = process.env.BUDDY_DATA_DIR || process.argv[3] || '';
const out = o => { if (o) process.stdout.write(JSON.stringify(o)); process.exit(0); };
const neutral = () => out(flavor === 'agy-pre' ? { decision: 'ask' } : null); // let the CLI do what it normally does

function readStdin() { return new Promise(r => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { s += d; }); process.stdin.on('end', () => r(s)); setTimeout(() => r(s), 3000); }); }
function active() {
  try { const a = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook-active.json'), 'utf8')); const want = flavor.startsWith('agy') ? 'gemini' : 'codex'; return a.provider === want && Date.now() - a.at < 6 * 3600 * 1000 ? a : null; } catch { return null; }
}
const strings = v => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

// CLI tool call → the tool/input shape Buddy's policy understands
function mapCodex(j) {
  const name = String(j.tool_name || ''); const ti = j.tool_input || {};
  if (/^(bash|shell|exec_command|local_shell)$/i.test(name)) { const c = ti.command; return { tool_name: 'Bash', input: { command: Array.isArray(c) ? c.join(' ') : String(c || ti.cmd || '') } }; }
  if (/apply_patch|^edit$|^write$/i.test(name)) {
    const text = strings(ti).join('\n'); const files = [], deletes = [];
    for (const m of text.matchAll(/\*\*\* (Add|Update|Delete) File: ([^\r\n]+)/g)) (m[1] === 'Delete' ? deletes : files).push(m[2].trim());
    for (const m of text.matchAll(/\*\*\* Move to: ([^\r\n]+)/g)) files.push(m[1].trim());
    return { tool_name: 'apply_patch', input: { files, deletes, cwd: j.cwd || '' } };
  }
  return { tool_name: name, input: ti };
}
function mapAgy(j) {
  const call = j.toolCall || {}; const name = String(call.name || ''); const a = call.args || {};
  const file = a.TargetFile || a.AbsolutePath || a.FilePath || a.Path || a.File || a.SearchPath || a.DirectoryPath || '';
  if (/^run_command$/i.test(name)) return { tool_name: 'Bash', input: { command: String(a.CommandLine || a.Command || '') } };
  if (/write_to_file|replace_file_content|multi_replace|edit_file|create_file/i.test(name)) return { tool_name: 'Write', input: { file_path: file } };
  if (/delete_file|remove_file/i.test(name)) return { tool_name: 'Bash', input: { command: 'rm ' + JSON.stringify(file) } };
  if (/view_file|read_|list_dir|grep|find_by_name|search|view_code|codebase/i.test(name)) return { tool_name: 'Read', input: { file_path: file } };
  if (/buddy/i.test(name)) return { tool_name: 'mcp__buddy__' + name, input: a };
  return { tool_name: 'mcp__agy__' + name, input: a }; // other built-ins: local tools (destructive names still need approval)
}

function ask(conn, args) {
  return new Promise(resolve => {
    const body = JSON.stringify({ name: 'buddy_permission', arguments: args });
    const req = http.request({ host: '127.0.0.1', port: conn.port, path: '/tool', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + conn.token }, timeout: 11 * 60 * 1000 }, res => {
      let s = ''; res.on('data', d => { s += d; }); res.on('end', () => { try { resolve((JSON.parse(s) || {}).result || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end(body);
  });
}

(async () => {
  const raw = await readStdin(); let j = {}; try { j = JSON.parse(raw || '{}'); } catch { return neutral(); }
  if (!active()) return neutral();
  let conn; try { conn = JSON.parse(fs.readFileSync(path.join(dataDir, 'connection.json'), 'utf8')); } catch { return neutral(); }
  const args = flavor.startsWith('agy') ? mapAgy(j) : mapCodex(j);
  const r = await ask(conn, { ...args, source: flavor });
  if (!r) return neutral();
  const allow = r.behavior === 'allow'; const msg = r.message || 'The user rejected this action in Buddy. Do not retry it.';
  if (flavor === 'agy-pre') return out(allow ? { decision: 'auto_approve' } : { decision: 'deny', reason: msg });
  if (flavor === 'codex-perm') return out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: msg } } });
  return out(allow ? null : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg } });
})();
