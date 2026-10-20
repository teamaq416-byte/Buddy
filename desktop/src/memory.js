'use strict';
// Buddy memory (who the user is, what they work on, what the AI learned) + skills discovery.
// Memory = three markdown files in <data>/memory, readable/editable by the user and by any connected agent.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILES = ['profile', 'projects', 'notes'];
const MAX_CHARS = 14000; // what gets injected into prompts
const SEED = {
  profile: `# Profile — who I am
<!-- Buddy gives this file to Claude / Codex / Gemini with every task. Keep it short and true. Replace the examples. -->

- Name: (your name)
- Role: (what you do, e.g. game developer, designer, student)
- Tools I use: (e.g. Unity, Photoshop, VS Code)

## How I like to work
- Reply in the language I write in.
- Keep answers short and practical; do the task when a sensible default exists.
- Deliver finished files, not instructions to do it myself.

## Rules (always)
<!-- Add things the AI must always follow, e.g. "Save Photoshop projects as PSB" or "Use TypeScript". -->
`,
  projects: `# Projects — what I'm working on
<!-- One section per project. Buddy and the AI update this as things change. -->

## (Project name)
- What it is, where it lives, what matters.
`,
  notes: `# Notes — things the AI learned
<!-- Appended automatically by buddy_remember (Claude / Codex) and by Buddy. Dated, newest last. Prune freely. -->
`,
};

class Memory {
  constructor(folder) { this.dir = path.join(folder, 'memory'); this.ensure(); }
  file(name) { if (!FILES.includes(name)) throw new Error('Unknown memory file: ' + name); return path.join(this.dir, name + '.md'); }
  ensure() { fs.mkdirSync(this.dir, { recursive: true }); for (const n of FILES) { const f = this.file(n); if (!fs.existsSync(f)) fs.writeFileSync(f, SEED[n]); } }
  read(name) { try { return fs.readFileSync(this.file(name), 'utf8'); } catch { return ''; } }
  write(name, text) { fs.writeFileSync(this.file(name), String(text ?? '').replace(/\r\n/g, '\n')); return true; }
  all() { return Object.fromEntries(FILES.map(n => [n, this.read(n)])); }
  remember(text, by = '') {
    text = String(text || '').trim().replace(/\s+/g, ' '); if (!text) throw new Error('Nothing to remember.');
    const line = `- ${new Date().toISOString().slice(0, 10)}${by ? ' (' + by + ')' : ''}: ${text.slice(0, 500)}\n`;
    const cur = this.read('notes'); if (cur.includes(text)) return { remembered: false, reason: 'already noted' };
    fs.writeFileSync(this.file('notes'), (cur.replace(/\s+$/, '') + '\n' + line)); return { remembered: true };
  }
  // Project context: BUDDY.md (or AGENTS.md / CLAUDE.md / GEMINI.md) in the working folder or any parent, nearest first.
  projectText(workdir) {
    if (!workdir) return '';
    let dir = path.resolve(workdir); const seen = new Set(); const out = [];
    for (let i = 0; i < 6 && dir && !seen.has(dir); i++) {
      seen.add(dir);
      for (const name of ['BUDDY.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
        const f = path.join(dir, name);
        try { const t = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim(); if (t) { out.push(`### ${f}\n${t.slice(0, 6000)}`); break; } } catch { /* none */ }
      }
      const up = path.dirname(dir); if (up === dir) break; dir = up;
    }
    return out.join('\n\n');
  }
  // Buddy's own notes per working folder (memory/projects/<name>-<hash>.md), editable in Settings → Memory → This project
  projectNotesFile(workdir) { if (!workdir) return ''; const abs = path.resolve(workdir); const slug = (path.basename(abs) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40) + '-' + require('crypto').createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 6); return path.join(this.dir, 'projects', slug + '.md'); }
  projectNotes(workdir) { const f = this.projectNotesFile(workdir); if (!f) return ''; try { return fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/^#.*$/m, '').trim().slice(0, 6000); } catch { return ''; } }
  readProjectNotes(workdir) { const f = this.projectNotesFile(workdir); if (!f) return ''; try { return fs.readFileSync(f, 'utf8'); } catch { return `# ${path.basename(path.resolve(workdir))}\n<!-- Notes Buddy gives the AIs whenever this folder is the working folder: stack, conventions, where things live, decisions. -->\n`; } }
  writeProjectNotes(workdir, text) { const f = this.projectNotesFile(workdir); if (!f) throw new Error('Set a working folder first (Settings → AI).'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(text ?? '').replace(/\r\n/g, '\n')); return true; }
  // Standing rules the user gave with /rule → "## Rules" section of profile.md
  addRule(text) {
    text = String(text || '').trim().replace(/\s+/g, ' '); if (!text) throw new Error('Rule text is required.');
    let cur = this.read('profile'); if (cur.includes(text)) return { added: false };
    if (!/^## Rules\b/m.test(cur)) cur = cur.replace(/\s+$/, '') + '\n\n## Rules (always)\n';
    cur = cur.replace(/\s+$/, '') + '\n- ' + text + '\n'; this.write('profile', cur); return { added: true };
  }
  // Recent work log: one line per finished task, newest last (kept short; used for "that playable from yesterday")
  logWork(provider, task, result) {
    const f = path.join(this.dir, 'recent.md'); let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* */ }
    const line = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} [${provider}] ${String(task).replace(/\s+/g, ' ').slice(0, 110)} → ${String(result || '').replace(/\s+/g, ' ').slice(0, 140)}`;
    const lines = cur.split('\n').filter(l => l.startsWith('- ')); lines.push(line);
    fs.writeFileSync(f, '# Recent work (auto)\n' + lines.slice(-30).join('\n') + '\n');
  }
  // Style samples: the user's own short messages, so the AI mirrors how they talk (language mix, tone, length)
  recordStyle(text) {
    text = String(text || '').trim().replace(/\s+/g, ' '); if (!text || text.length < 3 || text.length > 160 || text.startsWith('/')) return;
    const f = path.join(this.dir, 'style.md'); let lines = []; try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('- ')); } catch { /* */ }
    if (lines.includes('- ' + text)) return; lines.push('- ' + text);
    fs.writeFileSync(f, '# How the user writes (auto, last 30 messages)\n' + lines.slice(-30).join('\n') + '\n');
  }
  styleText(n = 12) { try { return fs.readFileSync(path.join(this.dir, 'style.md'), 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-n).join('\n'); } catch { return ''; } }
  recentText(n = 10) { try { return fs.readFileSync(path.join(this.dir, 'recent.md'), 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-n).join('\n'); } catch { return ''; } }
  // Compact text for prompts: strips HTML comments, trims each file to a budget.
  promptText() {
    const out = []; let budget = MAX_CHARS;
    for (const n of FILES) {
      let t = this.read(n).replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!t || /^#[^\n]*$/.test(t)) continue; // empty apart from the heading
      if (t.length > budget) t = n === 'notes' ? '…(older notes trimmed)\n' + t.slice(-Math.max(0, budget - 30)) : t.slice(0, Math.max(0, budget - 20)) + '\n…(truncated)'; /* newest notes are at the end */ budget -= t.length; out.push(t); if (budget <= 0) break;
    }
    return out.join('\n\n');
  }
}

// ----------------------------------------------------------------- skills
// A skill is a SKILL.md (Agent Skills format: frontmatter name/description) in any of:
//   <data>/skills/<name>/SKILL.md or <data>/skills/<name>.md   (Buddy's own)
//   ~/.codex/skills/<name>/SKILL.md                             (Codex)
//   ~/.claude/skills/<name>/SKILL.md                            (Claude Code)
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/); const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([\w-]+)\s*:\s*(.*)$/); if (k) meta[k[1].toLowerCase()] = k[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: m ? text.slice(m[0].length) : text };
}
const slug = s => String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function listSkills(folder) {
  const roots = [[path.join(folder, 'skills'), 'buddy'], [path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'), 'codex'], [path.join(os.homedir(), '.claude', 'skills'), 'claude']];
  const seen = new Map();
  for (const [root, source] of roots) {
    let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      let file = null;
      if (e.isDirectory()) { const f = path.join(root, e.name, 'SKILL.md'); if (fs.existsSync(f)) file = f; }
      else if (/\.md$/i.test(e.name)) file = path.join(root, e.name);
      if (!file) continue;
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const { meta, body } = parseFrontmatter(text);
      const name = slug(meta.name || e.name); if (!name || seen.has(name)) continue;
      const description = (meta.description || (body.match(/^(?!#)\s*(\S[^\n]{0,160})/m) || [])[1] || '').trim().slice(0, 160);
      seen.set(name, { name, description, file, dir: path.dirname(file), source });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function skillPrompt(skill, task, files) {
  const text = fs.readFileSync(skill.file, 'utf8'); const { body } = parseFrontmatter(text);
  return [
    `Follow the skill "${skill.name}" below exactly. Its folder is ${skill.dir} — scripts, templates and references it mentions live there (resolve relative paths against it).`,
    '--- SKILL.md ---', body.trim(), '--- end of skill ---',
    `Task: ${task || (files && files.length ? 'Run this skill on the attached files.' : 'Run this skill. Ask only if something essential is missing.')}`,
  ].join('\n\n');
}

module.exports = { Memory, FILES, listSkills, skillPrompt, parseFrontmatter };
