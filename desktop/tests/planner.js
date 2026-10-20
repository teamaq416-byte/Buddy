'use strict';
// Reminders (one-time + repeating) and scheduled AI tasks: state rules, next-run maths, MCP tools.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } console.log('ok  ' + m); };
const { State, nextAt } = require('../src/state');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-plan-'));
const st = new State(DATA); const now = () => Date.now() / 1000;
const events = []; st.on('reminders', p => events.push(['r', p.reminders.length])); st.on('schedules', p => events.push(['s', p.schedules.length]));

// next-run maths (local time)
const mon9 = new Date(2026, 9, 12, 9, 0, 0).getTime() / 1000; // Mon 12 Oct 2026 09:00
const fri9 = new Date(2026, 9, 16, 9, 0, 0).getTime() / 1000;
assert(new Date(nextAt(mon9, 'daily', mon9) * 1000).getDate() === 13 && new Date(nextAt(mon9, 'daily', mon9) * 1000).getHours() === 9, 'daily → next day, same clock time');
assert(new Date(nextAt(fri9, 'weekdays', fri9) * 1000).getDay() === 1, 'weekdays → Friday rolls to Monday');
assert(nextAt(mon9, 'weekly', mon9) - mon9 > 6.9 * 86400, 'weekly → +7 days');
assert(nextAt(mon9, 'hourly', mon9) - mon9 === 3600, 'hourly → +1 h');
assert(nextAt(mon9, 'daily', mon9 + 10 * 86400 + 5) > mon9 + 10 * 86400, 'catches up past missed runs, always in the future');

// reminders
let threw = ''; try { st.addReminderAt(now() + 60, '   '); } catch (e) { threw = e.message; } assert(/remind you about/.test(threw), 'empty reminder rejected');
threw = ''; try { st.addReminderAt(now() - 3600, 'late'); } catch (e) { threw = e.message; } assert(/already passed/.test(threw), 'past one-time reminder rejected');
const once = st.addReminderAt(now() - 1, 'Stand up'); const rep = st.addReminderAt(now() - 1, 'Drink water', 'hourly');
assert(rep.at > now(), 'repeating reminder in the past is moved to its next run');
const later = st.addReminderAt(now() + 3600, 'Call Sara', 'daily');
assert(st.listReminders()[0].id === once.id, 'list sorted by time');
const due = st.dueReminders();
assert(due.length === 1 && due[0].id === once.id && !st.reminders.some(r => r.id === once.id), 'due one-time reminder fires once and is removed');
assert(st.reminders.some(r => r.id === later.id) && st.reminders.some(r => r.id === rep.id), 'future + repeating reminders stay');
const t0 = later.at; later.at = now() - 2; st.dueReminders(); assert(st.reminders.find(r => r.id === later.id).at > now() && st.reminders.find(r => r.id === later.id).at >= t0, 'repeating reminder reschedules instead of disappearing');
assert(st.removeReminder(rep.id) && !st.reminders.some(r => r.id === rep.id), 'reminder can be deleted');
assert(events.some(e => e[0] === 'r'), 'reminders changes are broadcast');

// schedules
threw = ''; try { st.addSchedule({ prompt: '', at: now() + 60 }); } catch (e) { threw = e.message; } assert(/what the AI should do/.test(threw), 'empty schedule rejected');
const s1 = st.addSchedule({ prompt: 'Summarise new Google Chat messages\nonly the Ads space', at: now() - 1, mode: 'do', provider: 'codex' });
const s2 = st.addSchedule({ prompt: 'Weekly report', at: now() - 1, repeat: 'weekly' });
assert(s1.title === 'Summarise new Google Chat messages' && s1.mode === 'do' && s1.provider === 'codex' && s1.enabled, 'schedule keeps title, mode and AI');
assert(s2.at > now(), 'repeating schedule set in the past starts at its next run');
const ds = st.dueSchedules();
assert(ds.length === 1 && ds[0].id === s1.id && !st.schedules.find(s => s.id === s1.id).enabled, 'one-time schedule fires once, then switches off');
assert(st.dueSchedules().length === 0, 'it does not fire twice');
st.markScheduleRun(s1.id, true, 'All quiet'); assert(st.schedules.find(s => s.id === s1.id).last.ok && st.schedules.find(s => s.id === s1.id).last.summary === 'All quiet', 'last run recorded');
st.updateSchedule(s2.id, { enabled: false }); assert(!st.listSchedules().find(s => s.id === s2.id).enabled, 'schedule can be paused');
st.updateSchedule(s2.id, { enabled: true, mode: 'do' }); assert(st.schedules.find(s => s.id === s2.id).enabled && st.schedules.find(s => s.id === s2.id).mode === 'do', 'and resumed / edited');
assert(st.removeSchedule(s1.id) && st.schedules.length === 1, 'schedule can be deleted');

// persisted
const st2 = new State(DATA); assert(st2.schedules.length === 1 && st2.reminders.length === st.reminders.length, 'reminders and schedules survive a restart');

// MCP tools
const r = st.execute('buddy_remind', { seconds: 600, message: 'Stretch', repeat: 'daily' }); assert(r.scheduled && r.repeat === 'daily', 'buddy_remind accepts repeat');
const sc = st.execute('buddy_schedule', { prompt: 'Check the build', seconds: 120, repeat: 'weekdays', mode: 'ask' }); assert(sc.scheduled && sc.repeat === 'weekdays' && /T/.test(sc.next_run), 'buddy_schedule creates a schedule');
const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge', 'buddy-mcp.js'), 'utf8'); assert(/name: 'buddy_schedule'/.test(bridge), 'bridge exposes buddy_schedule');
console.log('planner tests passed');
