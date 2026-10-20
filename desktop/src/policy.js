'use strict';
// Permission policy: classifies a tool call into "auto" (normal development) or an approval category.
// Auto: reading/searching, code edits and new files inside the project, local tests/builds, harmless shell.
// Approval: secrets, changes outside the project, delete/overwrite, software install, git push, deploy/publish, external messages.
const path = require('path');
const os = require('os');

const SECRET_FILE = /(^|[\\/])(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_rsa[^\\/]*|id_ed25519[^\\/]*|.*\.(pem|key|p12|pfx|kdbx)|credentials(\.json)?|client_secret[^\\/]*\.json|secrets?\.(json|ya?ml|toml)|\.aws[\\/]credentials|\.docker[\\/]config\.json|token\.json|google-chat\.json)$/i;
const SECRET_CMD = /\b(printenv|set\s*$|env\s*$|cat|type|Get-Content|gc|more|less|head|tail|findstr|grep|rg|Select-String)\b[^|&;]*(\.env(?![a-z])|\bsecrets?\b|\btokens?\b|api[_-]?key|\bcredentials?\b|\bpasswords?\b|\.npmrc|\.netrc|id_rsa|id_ed25519|\.pem(?![a-z])|\.key(?![a-z]))/i;
const DELETE_CMD = /(^|[\s;&|(])(rm|rmdir|del|erase|rd|Remove-Item|ri|unlink|shred|git\s+clean|git\s+reset\s+--hard|git\s+checkout\s+--\s|git\s+restore\b(?!\s+--staged)|truncate|diskpart|mkfs)\b|(^|[\s;&|(])format\s+[a-z]:/i;
const OVERWRITE_CMD = /(^|[^<>=\d-])>\s*(?!\/dev\/null|nul\b|&)[^>\s&|]+|(\bcp|\bcopy|\bmove|\bmv|\bxcopy|\brobocopy|\bCopy-Item|\bMove-Item)\b[^|&;]*\s(-f|--force|\/y)\b/i;
const INSTALL_CMD = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|up|update|upgrade|link|exec|x|dlx)\b|\bnpx\s+(?!(jest|vitest|mocha|tsc|eslint|prettier|playwright\s+test)\b)|\bpip3?\s+(install|uninstall)|\buv\s+(pip|add|tool)|\bpipx\b|\bwinget\b|\bchoco\b|\bscoop\b|\bbrew\s+(install|uninstall|upgrade)|\bapt(-get)?\s+(install|remove|purge)|\bdnf\b|\byum\b|\bcargo\s+install|\bgo\s+install|\bdotnet\s+tool\s+install|\bgem\s+install|\bcomposer\s+(global\s+)?require|\bInstall-Module|\bInstall-Package|\bmsiexec\b|\bsetup\.exe|\.msi\b/i;
const GIT_PUSH = /\bgit\s+push\b|\bgit\s+remote\s+(add|set-url|remove)|\bgh\s+(pr\s+(create|merge)|release\s+(create|upload)|repo\s+(create|delete))|\bglab\s+/i;
const DEPLOY_CMD = /\b(npm|pnpm|yarn)\s+publish\b|\bvercel\b|\bnetlify\s+deploy|\bfirebase\s+deploy|\bgcloud\s+(app|run|functions)\s+deploy|\baws\s+(s3\s+(cp|sync)|lambda\s+update|cloudformation\s+deploy|deploy)|\baz\s+(webapp|functions)\s+deploy|\bheroku\s+|\bfly\s+deploy|\bwrangler\s+(publish|deploy)|\bdocker\s+push|\bkubectl\s+(apply|delete|rollout)|\bhelm\s+(install|upgrade)|\bterraform\s+(apply|destroy)|\bpulumi\s+up|\bcap\s+deploy|\brsync\b.*@|\bscp\b.*@|\bssh\b|\bcurl\b[^|]*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s)|\bInvoke-WebRequest\b[^|]*-Method\s+(POST|PUT|DELETE)|\bInvoke-RestMethod\b|\btwine\s+upload|\bgradle\s+publish|\bmvn\s+deploy|\bgoreleaser\b|\bexpo\s+publish|\beas\s+(build|submit)|\bfastlane\b/i;
const MESSAGE_TOOL = /(^|__)(gchat_(send|dm)|send_message|post_message|send_email|send_mail|reply|chat_post|slack_post|create_issue|create_comment|tweet|publish)\b/i;
const SAFE_CMD = /^\s*(ls|dir|pwd|cd|echo|cat|type|head|tail|less|more|find|findstr|grep|rg|wc|sort|uniq|tree|stat|file|which|where|whoami|date|node\s+-v|npm\s+-v|python\s+--version|git\s+(status|log|diff|branch|show|blame|ls-files|rev-parse|describe|tag\s*$|stash\s+list|remote\s+-v)|npm\s+(test|run\s+(test|lint|build|dev|start|check|typecheck|format)|ls|ci\s*$)|pnpm\s+(test|run|lint|build)|yarn\s+(test|lint|build)|npx\s+(jest|vitest|mocha|tsc|eslint|prettier|playwright\s+test)|pytest|python\s+-m\s+(pytest|unittest)|python\s+[\w./\\-]+\.py|node\s+[\w./\\-]+\.(m?js|cjs)|go\s+(test|build|vet|run)|cargo\s+(test|build|check|run)|dotnet\s+(test|build|run)|mvn\s+(test|compile)|gradle\s+(test|build)|make(\s+test|\s+build)?|tsc\b|eslint\b|prettier\b|jest\b|vitest\b|mkdir|md|touch|New-Item\s+-ItemType\s+Directory|Get-ChildItem|gci|Select-String|Get-Content\b(?!.*(\.env|secret|token|key|credential)))\b/i;

function norm(p) { return path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase(); }
function inside(file, root) { if (!file || !root) return false; const f = norm(file), r = norm(root).replace(/\/$/, ''); return f === r || f.startsWith(r + '/'); }
function pathsIn(text) { return (String(text || '').match(/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\s"'<>|*?;&]+/g) || []); }

// → { kind: 'auto' | 'approve', category, title, target, reason }
function classify(toolName, input, opts = {}) {
  const tool = String(toolName || ''); const t = tool.toLowerCase(); input = input && typeof input === 'object' ? input : {};
  const workdir = opts.workdir || os.homedir(); const dataDir = opts.dataDir || '';
  const file = input.file_path || input.path || input.notebook_path || '';
  const cmd = String(input.command || '');
  const A = (category, title, target, reason) => ({ kind: 'approve', category, title, target: String(target || '').slice(0, 200), reason });
  const OK = (why) => ({ kind: 'auto', category: 'auto', title: tool, target: String(file || cmd || '').slice(0, 200), reason: why });

  if (/^(mcp__)?buddy(__|_)/.test(t)) return OK('Buddy progress/memory call');
  // Codex apply_patch (from Buddy's approval hook): every touched file must be inside the project; deletes always ask
  if (t === 'apply_patch') {
    const files = (input.files || []).map(f => path.isAbsolute(f) ? f : path.join(input.cwd || workdir, f)); const dels = (input.deletes || []).map(f => path.isAbsolute(f) ? f : path.join(input.cwd || workdir, f));
    if (dels.length) return A('delete', 'Delete files', dels.join(', '), 'Deleting files happens only after you accept.');
    const secret = files.find(f => SECRET_FILE.test(f)); if (secret) return A('secrets', 'Change a secret file', secret, 'Secret/credential files change only after you accept.');
    const out = files.find(f => !inside(f, workdir)); if (out) return A('outside', 'Change a file outside the project', out, `Only files inside the working folder (${workdir}) change automatically.`);
    return OK('code edit inside the project');
  }
  const mcpName = t.startsWith('mcp__') ? t.split('__').pop() : '';
  if (mcpName && /(^|[_-])(delete|remove|trash|destroy|drop|purge|wipe|merge|push|share|revoke|uninstall|unshare|transfer)([_-]|$)/.test(mcpName)) return A('delete', 'Destructive action: ' + tool.replace(/^mcp__/, '').replace(/__/g, ' · '), input.file_id || input.id || input.name || input.path || JSON.stringify(input).slice(0, 120), 'Deleting, sharing or merging through a connected app happens only after you accept.');
  if (MESSAGE_TOOL.test(t)) return A('message', 'Send a message', input.space || input.email || input.channel || input.to || tool, 'External messages are sent only after you accept.');
  // reads & searches
  if (/^(read|glob|grep|ls|websearch|webfetch|notebookread|todoread|todowrite|task|exit_plan_mode|read_file|list_directory|search_file_content|glob|google_web_search|web_fetch)$/.test(t) || /^(read|list|get|search|find|status|history|fetch|query|describe|inspect)([_-]|$)/.test(mcpName)) {
    if (file && SECRET_FILE.test(file)) return A('secrets', 'Read a secret file', file, 'Secret/credential files are opened only after you accept.');
    return OK('read/search');
  }
  // edits & new files
  if (/^(edit|write|multiedit|notebookedit|write_file|replace|create_file|save_file)$/.test(t) || /^(write|edit|create|save|update)([_-]|$)/.test(mcpName)) {
    if (file && SECRET_FILE.test(file)) return A('secrets', 'Change a secret file', file, 'Secret/credential files change only after you accept.');
    if (file && dataDir && inside(file, dataDir)) return A('outside', "Change Buddy's own data", file, "Buddy's data folder is protected.");
    if (file && !inside(file, workdir)) return A('outside', 'Change a file outside the project', file, `Only files inside the working folder (${workdir}) change automatically.`);
    return OK('code edit / new file inside the project');
  }
  // shell
  if (/^(bash|run_shell_command|shell|powershell|cmd|execute_command|run_command)$/.test(t) || /command/.test(t) && cmd) {
    const c = cmd.trim();
    if (SECRET_CMD.test(c)) return A('secrets', 'Command touches secrets', c, 'Commands that read tokens/keys/.env run only after you accept.');
    if (GIT_PUSH.test(c)) return A('git-push', 'Git push / remote change', c, 'Pushing to a remote happens only after you accept.');
    if (INSTALL_CMD.test(c)) return A('install', 'Install software', c, 'Installs run only after you accept.');
    if (DEPLOY_CMD.test(c)) return A('deploy', 'Deploy / publish / external call', c, 'Deploys, publishes and outbound requests run only after you accept.');
    if (DELETE_CMD.test(c)) return A('delete', 'Delete or discard files', c, 'Deleting or discarding changes happens only after you accept.');
    if (OVERWRITE_CMD.test(c)) return A('overwrite', 'Overwrite files', c, 'Overwrites happen only after you accept.');
    const outside = pathsIn(c).filter(p => !/^\/(dev|tmp|proc)\b/.test(p) && !inside(p, workdir) && !/node_modules|\.cache|appdata[\\/]local[\\/]temp|[\\/]temp[\\/]/i.test(p));
    if (outside.length && /(^|[\s;&|])(mkdir|md|touch|New-Item|cp|copy|mv|move|xcopy|robocopy|Copy-Item|Move-Item|Set-Content|Out-File|Add-Content|tee|sed\s+-i|perl\s+-i)\b/i.test(c)) return A('outside', 'Change files outside the project', outside[0], `Only the working folder (${workdir}) changes automatically.`);
    if (SAFE_CMD.test(c)) return OK('local test/build/read command');
    return OK('shell command inside the project');
  }
  // other MCP tools (Photoshop etc.): allowed — they are local tools; destructive ones are covered above by name
  if (t.startsWith('mcp__')) return OK('local tool');
  return A('other', 'Use ' + tool, file || cmd || JSON.stringify(input).slice(0, 120), 'Unknown tool — runs only after you accept.');
}

// What each AI backend can and cannot enforce — shown in Settings so the limits are explicit, not hidden.
const BACKENDS = {
  claude: { enforce: 'Full: every tool call is routed through Buddy\'s policy (Claude Code --permission-prompt-tool). Accept allows exactly that one call.', limit: 'Read/Glob/Grep are auto-allowed by Claude Code itself before reaching Buddy, so reading a secret file via the Read tool cannot be intercepted (shell reads are).' },
  codex: { enforce: 'Codex hooks (~/.codex/hooks.json → Buddy): every shell command, file patch and MCP call is checked by Buddy\'s policy; risky ones show the Accept/Reject toast. Do = workspace-write sandbox, Ask = read-only; sandbox escalations also come to the toast.', limit: 'Hosted tools (web search) are not covered by Codex hooks. Hooks need a recent Codex CLI (Buddy keeps it updated).' },
  gemini: { enforce: 'Antigravity hook (~/.gemini/config/hooks.json → Buddy): every tool call is checked by Buddy\'s policy; risky ones show the Accept/Reject toast. Ask mode = plan (no edits/commands).', limit: 'If an Antigravity build ignores hook answers in headless mode, Buddy falls back to auto-approve for that run and says so in the chat.' },
};

module.exports = { classify, BACKENDS, inside };
