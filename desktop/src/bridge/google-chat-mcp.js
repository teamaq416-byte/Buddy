#!/usr/bin/env node
'use strict';
// Buddy Google Chat MCP — dependency-free stdio MCP server exposing the user's Google Chat
// (spaces, DMs, messages) to Claude Code / Codex. Signed in as the user via Buddy (Connect → Google Chat).
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const oauth = require('./google-oauth');

const VERSION = '2.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DATA = process.env.BUDDY_DATA_DIR || path.join(os.homedir(), 'Buddy-data');
let TOKEN_FILE = process.env.GCHAT_TOKEN_FILE || path.join(DATA, 'google-chat.json');
const API = (process.env.GCHAT_API_BASE || 'https://chat.googleapis.com').replace(/\/$/, '');
const GAPI = (process.env.GCAL_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');
const GMAIL = (process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com').replace(/\/$/, '');

const TOOLS = [
  { name: 'gchat_spaces', description: "List the user's Google Chat spaces, group chats and direct messages (name, id, type).", inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'gchat_messages', description: 'Read recent messages from a space or DM. `space` is a space id (spaces/XXX) or its display name / the person you DM with.', inputSchema: { type: 'object', properties: { space: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, since: { type: 'string', description: 'ISO time; only messages after this' } }, required: ['space'], additionalProperties: false } },
  { name: 'gchat_unread', description: 'Spaces and DMs with messages the user has not read yet, with the unread messages.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 } }, additionalProperties: false } },
  { name: 'gchat_search', description: 'Search recent messages for a phrase (case-insensitive), optionally within one space.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, space: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, required: ['query'], additionalProperties: false } },
  { name: 'gchat_send', description: 'Send a message to a space, group chat or DM as the user. Optional `thread` (a message id or thread id) replies in that thread. Only send what the user asked you to send.', inputSchema: { type: 'object', properties: { space: { type: 'string' }, text: { type: 'string' }, thread: { type: 'string' } }, required: ['space', 'text'], additionalProperties: false } },
  { name: 'gchat_dm', description: 'Send a direct message to a person by email (creates the DM if needed).', inputSchema: { type: 'object', properties: { email: { type: 'string' }, text: { type: 'string' } }, required: ['email', 'text'], additionalProperties: false } },
  { name: 'gcal_events', description: "The user's Google Calendar events (primary calendar) from now for the next `days` days (default 1 = today): title, start, end, meeting link, attendees count.", inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 14, default: 1 } }, additionalProperties: false } },
  { name: 'gmail_unread', description: 'Unread emails in the Gmail inbox (newest first): from, subject, snippet, date. Read-only.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, additionalProperties: false } },
  { name: 'gmail_search', description: "Search Gmail with Gmail's own query syntax (e.g. 'from:hamza newer_than:7d', 'subject:invoice'). Read-only.", inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 } }, required: ['query'], additionalProperties: false } },
  { name: 'gchat_members', description: 'List the members of a space.', inputSchema: { type: 'object', properties: { space: { type: 'string' } }, required: ['space'], additionalProperties: false } },
];
const INSTRUCTIONS = "Google tools act as the user: gchat_* (Chat), gcal_events (Calendar, read-only), gmail_* (Gmail, read-only). Read freely when asked about messages; send only messages the user explicitly asked for, with the wording they gave or approved.";

// --------------------------------------------------------------- API helpers
async function call(method, p, body) {
  const token = await oauth.accessToken(TOKEN_FILE);
  return oauth.request(API + '/v1/' + p, { method, headers: { Authorization: 'Bearer ' + token }, body });
}
const q = o => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString(); return s ? '?' + s : ''; };
async function paged(p, key, params, max) {
  const out = []; let pageToken = '';
  do { const r = await call('GET', p + q({ ...params, pageToken })); out.push(...(r[key] || [])); pageToken = r.nextPageToken || ''; } while (pageToken && out.length < max);
  return out.slice(0, max);
}

let spaceCache = { at: 0, list: [] }; const memberCache = new Map(); let selfId = null;
function myEmail() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).email || ''; } catch { return ''; } }
async function me(space) {
  // The caller's user id: membership lookup by email alias (documented) — needed to label DMs with the *other* person.
  if (selfId !== null) return selfId; const email = myEmail(); if (!email) return (selfId = '');
  try { selfId = ((await call('GET', `${space}/members/${encodeURIComponent(email)}`)).member || {}).name || ''; } catch { return ''; } // lookup failed: try again next time
  return selfId;
}
async function members(space) {
  if (memberCache.has(space)) return memberCache.get(space);
  const ms = await paged(space + '/members', 'memberships', { pageSize: 100 }, 200);
  const list = ms.map(m => ({ id: (m.member || {}).name || '', name: (m.member || {}).displayName || (m.member || {}).name || '', type: (m.member || {}).type || '', role: m.role || '' }));
  memberCache.set(space, list); return list;
}
async function spaces() {
  if (Date.now() - spaceCache.at < 60000 && spaceCache.list.length) return spaceCache.list;
  const raw = await paged('spaces', 'spaces', { pageSize: 100 }, 300);
  const list = [];
  for (const s of raw) {
    let label = s.displayName || '';
    if (!label && s.spaceType === 'DIRECT_MESSAGE') { try { const ms = await members(s.name); const self = await me(s.name); const other = ms.filter(m => m.type !== 'BOT' && m.id !== self).map(m => m.name).filter(Boolean); label = 'DM: ' + (other.length > 1 ? other.join(', ') : (other[0] || 'direct message')); } catch { label = 'direct message'; } }
    if (!label && s.spaceType === 'GROUP_CHAT') { try { label = 'Group: ' + (await members(s.name)).map(m => m.name).filter(Boolean).slice(0, 4).join(', '); } catch { label = 'group chat'; } }
    list.push({ id: s.name, name: label || s.name, type: s.spaceType || s.type || '', threaded: !!(s.spaceThreadingState && s.spaceThreadingState !== 'UNTHREADED_MESSAGES') });
  }
  spaceCache = { at: Date.now(), list }; return list;
}
async function resolveSpace(ref) {
  ref = String(ref || '').trim(); if (!ref) throw new Error('space is required');
  if (/^spaces\/[\w-]+$/.test(ref)) return ref;
  const all = await spaces(); const low = ref.toLowerCase();
  const hit = all.find(s => s.name.toLowerCase() === low) || all.find(s => s.name.toLowerCase().includes(low)) || all.find(s => s.name.toLowerCase().replace(/^(dm|group): /, '').split(', ').some(n => n.includes(low)));
  if (!hit) throw new Error(`No space or DM matching "${ref}". Call gchat_spaces to see the list.`);
  return hit.id;
}
async function senderName(space, id) { try { const m = (await members(space)).find(x => x.id === id); return m ? m.name : id; } catch { return id; } }
async function fmt(space, m) {
  const text = m.text || m.formattedText || (m.cards || m.cardsV2 ? '[card]' : '') || (m.attachment ? '[attachment]' : '');
  return { id: m.name, time: m.createTime, from: await senderName(space, (m.sender || {}).name || ''), from_id: (m.sender || {}).name || '', thread: (m.thread || {}).name || '', text, attachments: (m.attachment || []).map(a => a.contentName || a.name).filter(Boolean), mentions: (m.annotations || []).filter(a => a.type === 'USER_MENTION' && a.userMention && a.userMention.user).map(a => a.userMention.user.name) };
}
async function messages(space, limit, since) {
  const params = { pageSize: Math.min(limit, 100), orderBy: 'createTime desc' };
  if (since) { const d = new Date(since); if (isNaN(d)) throw new Error('since must be an ISO time'); params.filter = `createTime > "${d.toISOString()}"`; }
  const raw = await paged(space + '/messages', 'messages', params, limit);
  const out = []; for (const m of raw) out.push(await fmt(space, m)); return out.reverse();
}

// --------------------------------------------------------------- calendar / gmail (read-only)
const scopeHint = what => e => { if (e.status === 403 || /insufficient|scope|has not been used|disabled/i.test(e.message)) throw new Error(`${what} is not allowed yet: enable the ${what} API in your Google Cloud project, then Buddy → Connect → Google → Sign in again (${e.message})`); throw e; };
async function gmailList(query, limit) {
  const token = await oauth.accessToken(TOKEN_FILE); const H = { headers: { Authorization: 'Bearer ' + token } };
  const list = await oauth.request(`${GMAIL}/gmail/v1/users/me/messages` + q({ q: query, maxResults: Math.min(30, limit) }), H).catch(scopeHint('Gmail'));
  const out = [];
  for (const m of (list.messages || []).slice(0, limit)) {
    try { const d = await oauth.request(`${GMAIL}/gmail/v1/users/me/messages/${m.id}` + q({ format: 'metadata', metadataHeaders: 'From' }) + '&metadataHeaders=Subject&metadataHeaders=Date', H); const hd = n => ((d.payload && d.payload.headers) || []).find(x => x.name.toLowerCase() === n.toLowerCase())?.value || ''; out.push({ id: m.id, from: hd('From'), subject: hd('Subject'), date: hd('Date'), snippet: d.snippet || '' }); } catch { /* skip */ }
  }
  return { messages: out, total: list.resultSizeEstimate || out.length };
}

// --------------------------------------------------------------- tools
const handlers = {
  async gchat_spaces() { return { spaces: await spaces() }; },
  async gchat_messages(a) { const space = await resolveSpace(a.space); return { space, messages: await messages(space, a.limit || 20, a.since) }; },
  async gchat_unread(a) {
    const out = []; const all = (await spaces()).slice(0, 40);
    for (const s of all) {
      if (out.length >= (a.limit || 15)) break;
      try {
        const rs = await call('GET', `users/me/${s.id}/spaceReadState`); const last = rs.lastReadTime || '1970-01-01T00:00:00Z';
        const ms = await messages(s.id, 20, last); if (ms.length) out.push({ space: s.id, name: s.name, unread: ms.length, messages: ms });
      } catch { /* spaces without read state (e.g. some bots) are skipped */ }
    }
    return { spaces: out, note: out.length ? undefined : 'No unread messages.' };
  },
  async gchat_search(a) {
    const needle = String(a.query || '').toLowerCase().trim(); if (!needle) throw new Error('query is required');
    const targets = a.space ? [await resolveSpace(a.space)] : (await spaces()).slice(0, 25).map(s => s.id);
    const hits = [];
    for (const sp of targets) { try { for (const m of await messages(sp, a.space ? 100 : 40)) if ((m.text || '').toLowerCase().includes(needle)) hits.push({ space: sp, ...m }); } catch { /* skip */ } if (hits.length >= (a.limit || 20)) break; }
    return { hits: hits.slice(0, a.limit || 20) };
  },
  async gchat_send(a) {
    const space = await resolveSpace(a.space); const text = String(a.text || '').trim(); if (!text) throw new Error('text is required');
    const body = { text }; let suffix = '';
    if (a.thread) { const t = String(a.thread); body.thread = { name: /\/threads\//.test(t) ? t : t.replace(/\/messages\/([^/]+)$/, '/threads/$1') }; suffix = q({ messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' }); }
    const r = await call('POST', space + '/messages' + suffix, body);
    return { sent: true, id: r.name, space, time: r.createTime };
  },
  async gchat_dm(a) {
    const email = String(a.email || '').trim(); if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('A valid email is required');
    let space;
    try { space = (await call('GET', 'spaces:findDirectMessage' + q({ name: 'users/' + email }))).name; }
    catch { space = (await call('POST', 'spaces:setup', { space: { spaceType: 'DIRECT_MESSAGE' }, memberships: [{ member: { name: 'users/' + email, type: 'HUMAN' } }] })).name; }
    const r = await call('POST', space + '/messages', { text: String(a.text || '').trim() });
    spaceCache.at = 0; return { sent: true, id: r.name, space, to: email };
  },
  async gcal_events(a) {
    const token = await oauth.accessToken(TOKEN_FILE); const days = Math.max(1, Math.min(14, a.days || 1));
    const end = new Date(); end.setHours(23, 59, 59, 0); end.setDate(end.getDate() + days - 1);
    const r = await oauth.request(`${GAPI}/calendar/v3/calendars/primary/events` + q({ timeMin: new Date().toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 50 }), { headers: { Authorization: 'Bearer ' + token } }).catch(scopeHint('Calendar'));
    return { events: (r.items || []).filter(e => e.status !== 'cancelled').map(e => ({ title: e.summary || '(no title)', start: (e.start || {}).dateTime || (e.start || {}).date, end: (e.end || {}).dateTime || (e.end || {}).date, all_day: !(e.start || {}).dateTime, link: e.hangoutLink || '', location: e.location || '', attendees: (e.attendees || []).length })) };
  },
  async gmail_unread(a) { return gmailList('is:unread in:inbox', a.limit || 10); },
  async gmail_search(a) { const qq = String(a.query || '').trim(); if (!qq) throw new Error('query is required'); return gmailList(qq, a.limit || 10); },
  async gchat_members(a) { const space = await resolveSpace(a.space); return { space, members: await members(space) }; },
};
const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': { const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0]; return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'google-chat', version: VERSION }, instructions: INSTRUCTIONS }; }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'prompts/list': return { prompts: [] };
    case 'resources/list': return { resources: [] };
    case 'resources/templates/list': return { resourceTemplates: [] };
    case 'tools/call': {
      const name = String(params.name || ''); const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      if (!handlers[name]) return toolResult('Unknown tool: ' + name, true);
      try { return toolResult(JSON.stringify(await handlers[name](args))); } catch (e) { return toolResult('Google: ' + e.message, true); }
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
    if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return;
    try { write({ jsonrpc: '2.0', id: msg.id, result: await dispatch(String(msg.method || ''), msg.params && typeof msg.params === 'object' ? msg.params : {}) }); }
    catch (e) { write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.code ? e.message : 'Internal error: ' + e.message } }); }
  });
  rl.on('close', () => process.exit(0));
}
// in-process use (Buddy's Google Chat notifications): same helpers, Buddy's own token file
function useTokenFile(f) { if (f && f !== TOKEN_FILE) { TOKEN_FILE = f; spaceCache = { at: 0, list: [] }; memberCache.clear(); selfId = null; } }
const rawSpaces = () => paged('spaces', 'spaces', { pageSize: 100 }, 300);
async function selfUserId() { const all = await spaces(); for (const s of all.slice(0, 5)) { const id = await me(s.id); if (id) return id; } return ''; }
async function send(space, text, thread) { const body = { text: String(text || '').trim() }; if (!body.text) throw new Error('text is required'); let suffix = ''; if (thread) { body.thread = { name: thread }; suffix = q({ messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' }); } const r = await call('POST', space + '/messages' + suffix, body); return { sent: true, id: r.name, space }; }
module.exports = { main, dispatch, TOOLS, get TOKEN_FILE() { return TOKEN_FILE; }, api: { useTokenFile, rawSpaces, spaces, messages, members, me, selfUserId, send } };
if (require.main === module) main();
