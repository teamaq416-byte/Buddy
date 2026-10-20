'use strict';
process.env.BUDDY_NO_AUTOINSTALL = '1';
// Memory files, skill discovery, /skill commands and the buddy_memory / buddy_remember tools.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-mem-'));
const HOME = path.join(DATA, 'home'); fs.mkdirSync(HOME, { recursive: true });
os.homedir = () => HOME; process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CODEX_HOME = path.join(HOME, '.codex');

const { Memory, listSkills, skillPrompt } = require('../src/memory');
const m = new Memory(DATA);
assert(fs.existsSync(path.join(DATA, 'memory', 'profile.md')) && /## Rules/.test(m.read('profile')) && /(your name)/.test(m.read('profile')), 'memory seeded with a neutral profile template');
m.write('profile', '# Profile\n- Name: Bolt\n\n## Rules (always)\n- Repeated UI = one Smart Object, reused.\n- Save Photoshop projects as PSB.\n');
assert(m.remember('Prefers Codex for PSD work', 'claude').remembered && !m.remember('Prefers Codex for PSD work').remembered, 'remember appends once (dedupe)');
assert(/\(claude\): Prefers Codex/.test(m.read('notes')), 'note is dated and attributed');
const pt = m.promptText(); assert(!/<!--/.test(pt) && /Smart Object/.test(pt) && /Prefers Codex/.test(pt), 'prompt text strips comments, includes rules and notes');
m.write('projects', '# Projects\n'); assert(!/# Projects\n\n# Notes/.test(m.promptText()) && m.promptText().includes('Prefers Codex'), 'heading-only file skipped');

// skills in three roots
fs.mkdirSync(path.join(DATA, 'skills', 'psd'), { recursive: true }); fs.writeFileSync(path.join(DATA, 'skills', 'psd', 'SKILL.md'), '---\nname: Game UI to PSD\ndescription: Rebuild a UI reference as an editable PSB\n---\n# Steps\n1. Inspect ref.png\n2. Use scripts/build.py');
fs.mkdirSync(path.join(HOME, '.codex', 'skills', 'scene-psd'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.codex', 'skills', 'scene-psd', 'SKILL.md'), '# Scene PSD\nRebuild a scene mockup as layers.\n');
fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'bad'), { recursive: true }); // no SKILL.md → ignored
fs.writeFileSync(path.join(DATA, 'skills', 'quick.md'), 'Quick one-liner skill');
const ks = listSkills(DATA);
assert(ks.map(k => k.name).join(',') === 'game-ui-to-psd,quick,scene-psd', 'skills discovered + slugged: ' + ks.map(k => k.name));
assert(ks[0].description === 'Rebuild a UI reference as an editable PSB' && ks[2].description === 'Rebuild a scene mockup as layers.' && ks[2].source === 'codex', 'descriptions from frontmatter or first line');
const sp = skillPrompt(ks[0], 'ref.png', []);
assert(/Follow the skill "game-ui-to-psd"/.test(sp) && /Use scripts\/build\.py/.test(sp) && /Task: ref\.png/.test(sp) && !/^---/.test(sp) && sp.includes(ks[0].dir), 'skill prompt has body, folder and task');

// core: /skill runs in Do mode with the skill text, chat shows the short command; tools read/write memory
const { Core } = require('../src/core');
const core = new Core(DATA);
const runs = []; core.provider = { name: 'claude', label: 'Claude', accent: '#fff', run: async (prompt, ctx, emit) => { runs.push({ prompt, ctx }); emit('done', 'ok'); }, cancel() {} };
const events = []; core.on('event', (k, p) => events.push([k, p]));
core.submit('/game-ui-to-psd ref.png');
assert(runs.length === 2 && runs[0].ctx.agent === true && /Steps/.test(runs[0].prompt) && /Task: ref\.png/.test(runs[0].prompt), 'skill command → Do mode with skill body');
assert(/^Verify what you just did/.test(runs[1].prompt) && runs[1].ctx.agent === true, 'Do-mode task is followed by a verify pass');
assert(/ok\n\n⚠️ ok|ok/.test(events.filter(e => e[0] === 'chat.done').pop()[1].text), 'verify note appended to the reply');
assert(/\[claude\] \/game-ui-to-psd ref\.png/.test(core.memory.recentText()), 'work logged to recent.md');
core.submit('/rule never use PSD, always PSB'); assert(/## Rules/.test(core.memory.read('profile')) && /always PSB/.test(core.memory.read('profile')), '/rule appends to profile');
fs.writeFileSync(path.join(DATA, 'BUDDY.md'), '# Project\nUse pnpm.'); core.state.settings.workdir = DATA; assert(/Use pnpm/.test(core.systemPrompt(false)) && /Recent tasks/.test(core.systemPrompt(false)), 'BUDDY.md + recent work in system prompt');
core.submit('nahi, yellow nahi — blue use karo'); assert(/Correction from the user: nahi, yellow/.test(core.memory.read('notes')), 'corrections auto-noted');
assert(events.find(e => e[0] === 'chat.user')[1].text === '/game-ui-to-psd ref.png', 'chat shows the command, not the skill text');
assert(/Smart Object/.test(runs[0].ctx.system) && /buddy_remember/.test(runs[0].ctx.system), 'system prompt carries memory + remember hint');
core.submit('/skills'); assert(/\/game-ui-to-psd — Rebuild/.test(events.filter(e => e[0] === 'chat.system').pop()[1].text), '/skills lists skills');
core.submit('/remember Sara owns the Ads space'); assert(/Sara owns/.test(core.memory.read('notes')), '/remember writes notes');
const r = core.state.execute('buddy_remember', { text: 'Uses PSB always', agent: 'codex' }); assert(r.remembered && /\(codex\): Uses PSB/.test(core.memory.read('notes')), 'buddy_remember tool');
const mm = core.state.execute('buddy_memory', {}); assert(/Bolt/.test(mm.profile) && /Uses PSB/.test(mm.notes), 'buddy_memory tool');
assert(core.snapshot('x').skills.length === 3, 'snapshot exposes skills');
core.close();
console.log('MEMORY OK');
