'use strict';
// "Continue" — carry the current conversation out of Buddy:
//  • Terminal: resume the exact same CLI session (Claude Code / Codex / Gemini keep the session id).
//  • App or browser: the AI's desktop app when it is installed, otherwise its website. The conversation so far is copied
//    to the clipboard (and pre-filled in the browser when the site supports it), so one paste continues it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const WEB = {
  claude: { label: 'claude.ai', url: q => 'https://claude.ai/new' + (q ? '?q=' + encodeURIComponent(q) : ''), prefill: true },
  codex: { label: 'ChatGPT', url: q => 'https://chatgpt.com/' + (q ? '?q=' + encodeURIComponent(q) : ''), prefill: true },
  gemini: { label: 'Gemini', url: () => 'https://gemini.google.com/app', prefill: false },
};
const APPS = {
  claude: [{ name: 'Claude', proto: 'claude', exes: la => [path.join(la, 'AnthropicClaude', 'claude.exe'), path.join(la, 'Programs', 'Claude', 'Claude.exe')], pkg: /^(Claude|Anthropic)/i }],
  codex: [{ name: 'Codex', proto: 'codex', exes: la => [path.join(la, 'Programs', 'Codex', 'Codex.exe'), path.join(la, 'Codex', 'Codex.exe')], pkg: /Codex/i },
          { name: 'ChatGPT', proto: 'chatgpt', exes: la => [path.join(la, 'Programs', 'ChatGPT', 'ChatGPT.exe')], pkg: /ChatGPT/i }],
  gemini: [],
};

let cache = { at: 0, apps: {} };
function protoRegistered(proto) {
  if (!IS_WIN) return false;
  try { const r = spawnSync('reg', ['query', `HKCR\\${proto}`, '/v', 'URL Protocol'], { windowsHide: true, timeout: 2500, encoding: 'utf8' }); return r.status === 0; } catch { return false; }
}
function storePackage(re) {
  if (!IS_WIN) return false;
  try { const pk = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages'); return fs.readdirSync(pk).some(d => re.test(d)); } catch { return false; }
}
// → { name, proto?, exe? } for the first installed desktop app of this AI, or null
function findApp(provider) {
  if (process.env.BUDDY_FAKE_APPS) { const f = process.env.BUDDY_FAKE_APPS.split(',').find(x => x.startsWith(provider + ':')); return f ? { name: f.split(':')[1], proto: provider } : null; }
  if (Date.now() - cache.at < 60000 && provider in cache.apps) return cache.apps[provider];
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); let hit = null;
  for (const a of APPS[provider] || []) {
    const exe = a.exes(la).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (exe) { hit = { name: a.name, exe, proto: protoRegistered(a.proto) ? a.proto : '' }; break; }
    if (protoRegistered(a.proto) || (storePackage(a.pkg) && protoRegistered(a.proto))) { hit = { name: a.name, proto: a.proto }; break; }
  }
  cache.at = Date.now(); cache.apps[provider] = hit; return hit;
}

function transcript(core, max = 7000) {
  const name = core.provider.name; const msgs = core.state.chat.filter(m => m.provider === name && (m.role === 'user' || m.role === 'assistant')).slice(-12);
  const who = core.bossName || 'Me'; const wd = core.state.settings.workdir;
  let body = msgs.map(m => `${m.role === 'user' ? who : core.provider.label}: ${String(m.text || '').trim()}`).join('\n\n');
  if (body.length > max) body = '…' + body.slice(-max);
  const head = `Continuing a conversation I started in Buddy with ${core.provider.label}${wd ? ` (working folder: ${wd})` : ''}. Here it is so far — pick up from the last message:`;
  return msgs.length ? `${head}\n\n${body}\n\n` : '';
}
function terminalCommand(core) {
  const P = require('./providers'); const prov = core.provider.name; const sid = core.state.settings.sessions[core.sessionKey(prov)] || '';
  const ex = (P.PROVIDERS[prov] || P.Claude).executable(); const bin = ex ? `"${ex}"` : prov;
  const cmd = prov === 'codex' ? (bin + ' resume' + (sid ? ' ' + sid : ' --last')) : prov === 'gemini' ? (bin + (sid ? ' -r ' + sid : '')) : (bin + (sid ? ' -r ' + sid : ' -c'));
  return { cmd, installed: !!ex, sid };
}

function options(core) {
  const prov = core.provider.name; const label = core.provider.label; const t = terminalCommand(core); const app = findApp(prov); const web = WEB[prov] || WEB.claude;
  return [
    { id: 'terminal', title: 'Continue in terminal', sub: t.installed ? (t.sid ? `Resumes this exact ${label} session in its CLI` : `Opens the ${label} CLI in your working folder`) : `${label} CLI isn't installed`, available: t.installed },
    app ? { id: 'app', title: `Continue in the ${app.name} app`, sub: 'Opens the desktop app; the conversation is copied — paste with Ctrl+V', available: true }
        : { id: 'web', title: 'Continue in the browser', sub: web.prefill ? `Opens ${web.label} with the conversation filled in` : `Opens ${web.label}; the conversation is copied — paste with Ctrl+V`, available: true },
  ];
}

async function run(core, id, { shell, clipboard } = {}) {
  const prov = core.provider.name; const cwd = core.state.settings.workdir || os.homedir();
  if (id === 'terminal') {
    const t = terminalCommand(core); if (!t.installed) throw new Error(`${core.provider.label} CLI isn't installed — Connect → ${core.provider.label}.`);
    if (IS_WIN) {
      // Windows Terminal when present (tabs, nicer font), otherwise classic cmd
      const wt = spawnSync('where', ['wt.exe'], { windowsHide: true, encoding: 'utf8', timeout: 2500 }).status === 0;
      if (wt) spawn('wt.exe', ['-w', '0', 'nt', '--title', `Buddy · ${core.provider.label}`, '-d', cwd, 'cmd', '/k', t.cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('cmd.exe', ['/c', `start "Buddy · ${core.provider.label}" /D "${cwd}" cmd /k ${t.cmd}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
      return { done: true, message: `Opened ${core.provider.label} in the terminal${t.sid ? ' — same session' : ''}.`, cmd: t.cmd };
    }
    if (clipboard) clipboard.writeText(`cd "${cwd}" && ${t.cmd}`);
    return { done: false, message: `Copied the command — paste it in a terminal: ${t.cmd}`, cmd: t.cmd };
  }
  const text = transcript(core);
  if (id === 'app') {
    const app = findApp(prov); if (!app) throw new Error('The desktop app was not found.');
    if (text && clipboard) clipboard.writeText(text);
    if (app.exe) spawn(app.exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); else if (shell) await shell.openExternal(app.proto + '://');
    return { done: true, copied: !!text, message: text ? `Opened ${app.name}. The conversation is on your clipboard — paste with Ctrl+V.` : `Opened ${app.name}.` };
  }
  const web = WEB[prov] || WEB.claude; const fill = web.prefill && text && text.length < 1800;
  if (text && clipboard) clipboard.writeText(text);
  if (shell) await shell.openExternal(web.url(fill ? text : ''));
  return { done: true, copied: !!text, url: web.url(fill ? text : ''), message: fill ? `Opened ${web.label} with the conversation filled in.` : text ? `Opened ${web.label}. The conversation is on your clipboard — paste with Ctrl+V.` : `Opened ${web.label}.` };
}

module.exports = { options, run, transcript, terminalCommand, findApp };
