#!/usr/bin/env node
'use strict';
// Buddy MCP bridge — dependency-free stdio MCP server (Node / Electron-as-Node).
// Forwards tool calls to the running Buddy over loopback HTTP (port/token in <data>/connection.json).
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = '2.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const AGENT = (process.env.BUDDY_AGENT || 'claude').trim().toLowerCase();
const SESSION = crypto.randomBytes(6).toString('hex');
const DATA = process.env.BUDDY_DATA_DIR || path.join(os.homedir(), 'Buddy-data');
let heartbeatStarted = false;

const TOOLS = [
  { name: 'buddy_status', description: "ALWAYS call this first, before doing any task the user asks for (no need to be asked): state='working' with a short message when you start, 'waiting' when you need the user, 'done' when finished, 'error' on failure. It shows live progress on the user's desktop companion (Buddy). Report only real activity.",
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['working', 'waiting', 'done', 'error', 'idle'] }, message: { type: 'string', description: 'Short status, max 160 chars' } }, required: ['state'], additionalProperties: false } },
  { name: 'buddy_step', description: "Call this as you work (after buddy_status working) for each meaningful step so the user sees progress on Buddy, e.g. tool='Read' detail='src/app.py', tool='Write' detail='report.md', tool='Search' detail='pricing'. Each new running step completes the previous one; status='done'|'error' closes the last step.",
    inputSchema: { type: 'object', properties: { tool: { type: 'string' }, detail: { type: 'string' }, status: { type: 'string', enum: ['running', 'done', 'error'] } }, required: ['tool'], additionalProperties: false } },
  { name: 'buddy_say', description: "Show a short speech bubble from Buddy on the user's screen (max 200 chars).", inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'buddy_files', description: 'List files the user attached or dropped onto Buddy.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'buddy_read_file', description: 'Read up to 32 KB of an attached text/code file. Only attached files can be read.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'buddy_remind', description: 'Schedule a local reminder shown by Buddy after N seconds (Buddy must be running). Optional repeat: hourly, daily, weekdays or weekly.', inputSchema: { type: 'object', properties: { seconds: { type: 'integer', minimum: 1, maximum: 31622400 }, message: { type: 'string' }, repeat: { type: 'string', enum: ['', 'hourly', 'daily', 'weekdays', 'weekly'] } }, required: ['seconds', 'message'], additionalProperties: false } },
  { name: 'buddy_schedule', description: "Schedule an AI task that Buddy runs by itself later (e.g. 'every weekday at 9 summarise my new Google Chat messages'). seconds = delay until the first run; repeat = '', hourly, daily, weekdays or weekly; mode 'ask' (read-only, default) or 'do' (may edit and run in the working folder). The user sees and manages it in Buddy → Planner → Schedules.", inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, seconds: { type: 'integer', minimum: 1, maximum: 31622400 }, repeat: { type: 'string', enum: ['', 'hourly', 'daily', 'weekdays', 'weekly'] }, mode: { type: 'string', enum: ['ask', 'do'] } }, required: ['prompt', 'seconds'], additionalProperties: false } },
  { name: 'buddy_task', description: "Add a task to the user's local checklist in Buddy.", inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'buddy_tasks', description: "List the user's Buddy checklist (id, text, done).", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'buddy_complete_task', description: 'Mark a Buddy task as done by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'buddy_memory', description: "Read what Buddy knows about the user: profile (who they are, how they like to work, standing rules), projects, and notes learned earlier. Call once at the start of a task and follow the rules in it.", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'buddy_remember', description: "Save one short durable fact about the user or a project to Buddy's memory (a decision, a preference, a project detail). Not for transient task details.", inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'One line, max 500 chars' } }, required: ['text'], additionalProperties: false } },
  { name: 'buddy_open', description: "Open something on the user's PC: a URL, a file or folder path, or an app by name (e.g. 'notepad', 'Photoshop'). URLs and files in the working folder open directly; apps, scripts and files elsewhere ask the user first on Buddy.", inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } },
  { name: 'buddy_system', description: 'PC controls: volume_up, volume_down, mute, media_play_pause, media_next, media_previous, screenshot (saved and attached to Buddy so you can look at it), lock (asks the user first).', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['volume_up', 'volume_down', 'mute', 'media_play_pause', 'media_next', 'media_previous', 'screenshot', 'lock'] } }, required: ['action'], additionalProperties: false } },
  { name: 'buddy_clipboard', description: "Read the user's clipboard text, or copy text to it (pass `text`).", inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } },
  { name: 'buddy_knowledge', description: "Search the user's knowledge folders (docs, notes, code they added in Buddy → Settings → Knowledge). Returns matching passages with file and line numbers.", inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'buddy_background', description: 'Start a separate AI job that runs in the background while you continue (e.g. a long research or a second task). The user sees progress in Buddy → Planner → Activity and gets a ping when done.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, title: { type: 'string' }, mode: { type: 'string', enum: ['ask', 'do'] }, provider: { type: 'string', enum: ['', 'claude', 'codex', 'gemini'] } }, required: ['prompt'], additionalProperties: false } },
  { name: 'buddy_permission', description: 'Internal: asks the user on Buddy whether a tool may run (used as a permission prompt). Do not call directly.',
    inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'], additionalProperties: true } },
];
const INSTRUCTIONS = "Buddy is the user's desktop companion and shows your progress on screen. Do this automatically for every task, without being asked: when you begin a user task call buddy_status(state='working', message=...); call buddy_step as you read/edit/run things; buddy_status(state='waiting') when you need the user, and buddy_status(state='done'|'error') when you finish. Report only real activity. Attached files, reminders and the checklist are available through the buddy_* tools. Call buddy_memory once at the start of a task for the user's profile/projects/rules, and buddy_remember(text) when you learn something durable.";

function localCall(name, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let info; try { info = JSON.parse(fs.readFileSync(path.join(DATA, 'connection.json'), 'utf8')); } catch { return reject(new Error('Buddy is not running. Start Buddy, then try again.')); }
    const body = JSON.stringify({ name, arguments: args });
    const req = http.request({ host: '127.0.0.1', port: info.port, path: '/tool', method: 'POST', timeout, headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => { try { const p = JSON.parse(data); p.error ? reject(new Error(p.error)) : resolve(p.result || {}); } catch (e) { reject(new Error('Bad reply from Buddy: ' + e.message)); } });
    });
    req.on('error', e => reject(new Error(`Buddy is not reachable (${e.message}). Start Buddy, then try again.`)));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}
function startHeartbeat() {
  if (heartbeatStarted) return; heartbeatStarted = true;
  const beat = () => localCall('buddy_heartbeat', { agent: AGENT, session: SESSION }).catch(() => {});
  beat(); setInterval(beat, 10000).unref();
}
const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': { const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0]; startHeartbeat(); return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'buddy', version: VERSION }, instructions: INSTRUCTIONS }; }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'prompts/list': return { prompts: [] };
    case 'resources/list': return { resources: [] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'tools/call': {
      const name = String(params.name || ''); const args = { ...(params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) };
      if (!TOOLS.some(t => t.name === name)) return toolResult('Unknown tool: ' + name, true);
      args.agent = AGENT; if (name === 'buddy_status') args.session = SESSION;
      if (name === 'buddy_permission') {
        // Permission prompt: the user answers on Buddy; wait up to 10 minutes, deny if Buddy is unreachable.
        try { return toolResult(JSON.stringify(await localCall(name, args, 11 * 60 * 1000))); }
        catch (e) { return toolResult(JSON.stringify({ behavior: 'deny', message: 'Buddy could not ask the user: ' + e.message })); }
      }
      const long = ['buddy_open', 'buddy_system'].includes(name) ? 11 * 60 * 1000 : 10000; // these may wait for the user's Accept
      try { return toolResult(JSON.stringify(await localCall(name, args, long))); } catch (e) { return toolResult('Buddy tool failed: ' + e.message, true); }
    }
    default: { const err = new Error('Method not found: ' + method); err.code = -32601; throw err; }
  }
}
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    line = line.trim(); if (!line) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return; // notifications: no answer
    try { write({ jsonrpc: '2.0', id: msg.id, result: await dispatch(String(msg.method || ''), msg.params && typeof msg.params === 'object' ? msg.params : {}) }); }
    catch (e) { write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.code ? e.message : 'Internal error: ' + e.message } }); }
  });
  rl.on('close', () => process.exit(0));
}
module.exports = { main, dispatch, TOOLS };
if (require.main === module || process.argv.includes('--mcp')) main();
