// End-to-end: launches the real Electron app (needs a display; use xvfb-run on Linux),
// drives island + panel, chats through a fake Gemini CLI (stream-json), round-trips the MCP bridge.
// Usage: node tests/e2e.js [OUTDIR]
'use strict';
process.env.BUDDY_NO_AUTOINSTALL = '1'; process.env.BUDDY_ONLY_PROVIDERS = 'gemini'; // the fake CLI is the only AI in tests
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'; // fake legacy Gemini CLI (stream-json) drives the UI tests
const { _electron: electron } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'buddy-e2e');
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-data-'));
process.env.FAKE_IMG = path.join(ROOT, 'assets', 'buddy-256.png');
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fake Gemini CLI on PATH (tests/fake-gemini) ----------------------------------
process.env.PATH = path.join(__dirname, 'fake-gemini') + path.delimiter + process.env.PATH;

function rpc(proc, id, method, params) {
  return new Promise(resolve => { const onLine = buf => { for (const line of buf.toString().split('\n')) { if (!line.trim()) continue; const m = JSON.parse(line); if (m.id === id) { proc.stdout.off('data', onLine); resolve(m); } } }; proc.stdout.on('data', onLine); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'); });
}

(async () => {
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ settings: { provider: 'gemini', boss_name: 'Bolt' } }));

  const app = await electron.launch({ args: [ROOT, '--no-sandbox'], env: { ...process.env, BUDDY_DATA_DIR: DATA, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const wins = async () => { const all = app.windows(); const island = all.find(w => w.url().includes('island.html')); const panel = all.find(w => w.url().includes('panel.html')); return { island, panel }; };
  let island, panel;
  for (let i = 0; i < 50 && !(island && panel); i++) { ({ island, panel } = await wins()); if (!(island && panel)) await sleep(200); }
  assert(island && panel, 'both windows created');
  island.on('console', m => { if (m.type() === 'error') console.log('[island]', m.text()); });
  panel.on('console', m => { if (m.type() === 'error') console.log('[panel]', m.text()); });
  await island.waitForFunction(() => window.__island && window.__island.info);
  await sleep(600);
  await island.screenshot({ path: path.join(OUT, 'e01_island_collapsed.png') });

  // hover → expand
  await island.mouse.move(280, 20); await sleep(700);
  assert(await island.evaluate(() => document.querySelector('#notch').classList.contains('open')), 'island expands on hover');
  await island.screenshot({ path: path.join(OUT, 'e02_island_expanded.png') });

  // inline chat
  await island.click('#input'); await island.keyboard.type('what is 2+2');
  await island.screenshot({ path: path.join(OUT, 'e03_island_typing.png') });
  await island.keyboard.press('Enter');
  await island.waitForFunction(() => window.__island.replyLive, null, { timeout: 5000 });
  await sleep(500); await island.screenshot({ path: path.join(OUT, 'e04_island_streaming.png') });
  await island.waitForFunction(() => !window.__island.replyLive && window.__island.reply.includes('2+2'), null, { timeout: 15000 });
  await sleep(300); await island.screenshot({ path: path.join(OUT, 'e05_island_reply.png') });
  assert(await island.evaluate(() => document.querySelector('#notch').classList.contains('reply')), 'reply shown inline');

  // Do mode toggle
  await island.click('#mode'); await sleep(400);
  assert(await island.evaluate(() => window.__island.info.agent_mode === true), 'Do mode toggled');
  await island.click('#mode'); await sleep(300);

  // MCP bridge via the app binary running as node
  const bridge = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge', 'buddy-mcp.js')], { env: { ...process.env, BUDDY_DATA_DIR: DATA, BUDDY_AGENT: 'claude' } });
  const init = await rpc(bridge, 1, 'initialize', { protocolVersion: '2025-03-26' });
  assert(init.result.protocolVersion === '2025-03-26' && /buddy_status/.test(init.result.instructions), 'bridge initialize');
  const tools = await rpc(bridge, 2, 'tools/list'); assert(tools.result.tools.length === 18 && ['buddy_schedule', 'buddy_open', 'buddy_system', 'buddy_knowledge', 'buddy_background'].every(n => tools.result.tools.some(t => t.name === n)), 'tool list (incl. schedule, PC control, knowledge, background)');
  const st = await rpc(bridge, 3, 'tools/call', { name: 'buddy_status', arguments: { state: 'working', message: 'Refactoring invoice totals', agent: 'codex' } });
  assert(st.result.isError === false, 'status call ok');
  for (const [tool, detail] of [['Read', 'src/invoice.ts'], ['Edit', 'src/invoice.ts'], ['Bash', 'npm test -- invoice']]) await rpc(bridge, 4, 'tools/call', { name: 'buddy_step', arguments: { tool, detail } });
  await rpc(bridge, 5, 'tools/call', { name: 'buddy_task', arguments: { text: 'Write release notes' } });
  await rpc(bridge, 6, 'tools/call', { name: 'buddy_remind', arguments: { seconds: 3600, message: 'Stretch' } });
  const bad = await rpc(bridge, 7, 'tools/call', { name: 'buddy_read_file', arguments: { path: path.join(DATA, 'state.json') } });
  assert(bad.result.isError === true, 'unattached file rejected');
  await sleep(1500);
  const info = await island.evaluate(() => window.__island.info);
  assert(info.headline[0] === 'claude' && info.headline[1] === 'working', 'identity from env, not from args: ' + JSON.stringify(info.headline));
  assert(info.feeds.claude.steps.length === 3 && info.linked.claude === true, 'steps + heartbeat visible');
  await island.mouse.move(280, 60); await sleep(400);
  assert(await island.evaluate(() => document.querySelector('#face').classList.contains('running')), 'Bash step → running face: ' + await island.evaluate(() => document.querySelector('#face').className));
  await rpc(bridge, 40, 'tools/call', { name: 'buddy_step', arguments: { tool: 'Read', detail: 'README.md' } }); await sleep(1300);
  assert(await island.evaluate(() => document.querySelector('#face').classList.contains('reading')), 'Read step → reading face');
  await island.screenshot({ path: path.join(OUT, 'e19_reading_face.png') });
  await rpc(bridge, 41, 'tools/call', { name: 'buddy_step', arguments: { tool: 'Edit', detail: 'README.md' } }); await sleep(1300);
  assert(await island.evaluate(() => document.querySelector('#face').classList.contains('typing')), 'Edit step → typing face');
  await rpc(bridge, 42, 'tools/call', { name: 'buddy_status', arguments: { state: 'done', message: 'All good' } }); await sleep(300);
  await island.mouse.move(280, 60); await sleep(500);
  await island.screenshot({ path: path.join(OUT, 'e06_island_agent_working.png') });
  await rpc(bridge, 8, 'tools/call', { name: 'buddy_status', arguments: { state: 'done', message: '48 tests passed' } });
  await sleep(700); await island.screenshot({ path: path.join(OUT, 'e07_island_done_toast.png') });
  // permission policy round-trip: safe calls are auto-allowed; risky ones show Accept/Reject on the island; Accept allows that one call only
  const auto = await rpc(bridge, 49, 'tools/call', { name: 'buddy_permission', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } });
  assert(JSON.parse(auto.result.content[0].text).behavior === 'allow', 'local tests auto-allowed');
  const permP = rpc(bridge, 50, 'tools/call', { name: 'buddy_permission', arguments: { tool_name: 'Bash', input: { command: 'git push origin main' }, tool_use_id: 'tu1' } });
  await sleep(800); await island.mouse.move(280, 60); await sleep(300);
  assert(await island.evaluate(() => document.querySelector('#perm').classList.contains('show') && /Git push/.test(document.querySelector('#perm').textContent) && /Accept/.test(document.querySelector('#perm').textContent)), 'approval card shown on island with action + target');
  await island.screenshot({ path: path.join(OUT, 'e20_permission.png') });
  await island.click('#perm button[data-a="accept"]');
  const permR = await permP; const permObj = JSON.parse(permR.result.content[0].text);
  assert(permObj.behavior === 'allow' && permObj.updatedInput.command === 'git push origin main', 'accept flows back: ' + permR.result.content[0].text);
  const again = rpc(bridge, 51, 'tools/call', { name: 'buddy_permission', arguments: { tool_name: 'Bash', input: { command: 'git push origin main' } } });
  await sleep(800); assert(await island.evaluate(() => document.querySelector('#perm').classList.contains('show')), 'same action asks again (accept is one-time)');
  await island.click('#perm button[data-a="deny"]'); assert(JSON.parse((await again).result.content[0].text).behavior === 'deny', 'reject flows back');
  const permD = rpc(bridge, 52, 'tools/call', { name: 'buddy_permission', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' } } });
  await sleep(800); await island.mouse.move(280, 60); await sleep(300); await island.click('#perm button[data-a="deny"]');
  assert(JSON.parse((await permD).result.content[0].text).behavior === 'deny', 'delete → reject flows back');
  assert(!(await island.evaluate(() => document.querySelector('#perm').classList.contains('show'))), 'permission box hidden after answer');
  bridge.stdin.end();

  // panel
  await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('panel.html')); p.show(); });
  await panel.waitForFunction(() => document.querySelectorAll('.msg').length > 0);
  await sleep(400); await panel.screenshot({ path: path.join(OUT, 'e08_panel_history.png') });
  await panel.fill('#input', 'hello from the panel'); await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => [...document.querySelectorAll('.msg.ai .body')].some(b => b.textContent.includes('hello from the panel')), null, { timeout: 15000 });
  await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e09_panel_reply.png') });
  await panel.click('#cont'); await panel.waitForSelector('#contmenu .cmi[data-id=terminal]'); assert(await panel.isVisible('#contmenu .cmi[data-id=web], #contmenu .cmi[data-id=app]'), 'Continue menu: terminal + app/website');
  await sleep(200); await panel.screenshot({ path: path.join(OUT, 'e09b_panel_continue.png') }); await panel.click('#name'); await sleep(150);
  await panel.click('.nav button[data-view=tasks]'); await panel.waitForSelector('.task'); await panel.screenshot({ path: path.join(OUT, 'e10_panel_tasks.png') });
  await panel.click('.nav button[data-view=connect]'); await panel.waitForSelector('.cardc'); await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e11_panel_connect.png') });
  await panel.click('.nav button[data-view=settings]'); await panel.waitForSelector('#s_save'); await panel.screenshot({ path: path.join(OUT, 'e12_panel_settings.png') });
  await panel.fill('#s_boss', 'Bolt Khan'); await panel.click('#s_save'); await sleep(1600);
  assert(await island.evaluate(() => document.querySelector('#role').textContent) === 'for Bolt Khan', 'Settings → Save changes your name (island shows it)');
  await panel.click('.nav button[data-view=settings]'); await panel.waitForSelector('#s_save'); assert(await panel.inputValue('#s_boss') === 'Bolt Khan', 'name stays saved');
  await panel.evaluate(() => { document.querySelector('#view-settings').style.scrollBehavior = 'auto'; document.querySelector('#view-settings').scrollTop = 99999; }); await sleep(200); await panel.screenshot({ path: path.join(OUT, 'e12b_panel_settings_end.png') });
  await panel.click('.nav button[data-view=connect]'); await panel.waitForSelector('.cardc'); await sleep(300); await panel.evaluate(() => { const v = document.querySelector('#view-connect'); v.style.scrollBehavior = 'auto'; v.scrollTop = 99999; }); await sleep(200); await panel.screenshot({ path: path.join(OUT, 'e11b_panel_connect_end.png') });

  // sleep after idle, startle on mouse move
  await island.mouse.move(5, 300); await sleep(300);
  await island.evaluate(() => { window.__island.lastActivity = Date.now() - 120000; window.__island.lastCursor = Date.now() - 120000; });
  await island.waitForFunction(() => !!document.querySelector('.face.sleep'), null, { timeout: 4000 }).catch(() => {});
  assert(await island.evaluate(() => document.querySelector('#face').classList.contains('sleep') || document.querySelector('.face.mini').classList.contains('sleep')), 'buddy falls asleep when idle');
  await island.screenshot({ path: path.join(OUT, 'e17_sleep.png') });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('island.html')); w.webContents.send('buddy:event', 'cursor', { x: 900, y: 500 }); });
  await sleep(150);
  assert(await island.evaluate(() => !!document.querySelector('.face.startle')), 'startle on wake');
  await island.screenshot({ path: path.join(OUT, 'e18_startle.png') });
  await sleep(900);
  assert(await island.evaluate(() => !document.querySelector('.face.sleep')), 'awake after cursor moves');

  // pet mode
  await app.evaluate(async ({ BrowserWindow, ipcMain }) => { /* use the public api through the island window */ });
  await island.evaluate(() => window.buddyBridge.call('set_display', ['pet']));
  await sleep(900); await island.screenshot({ path: path.join(OUT, 'e13_pet.png') });
  assert(await island.evaluate(() => document.body.classList.contains('pet')), 'pet mode');
  assert(await island.evaluate(() => document.querySelector('#pface').offsetWidth > 40), 'pet face visible');
  // eyes follow the cursor (cursor event from main)
  await island.evaluate(() => window.buddyBridge && document.dispatchEvent(new Event('noop')));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('island.html')); w.webContents.send('buddy:event', 'cursor', { x: -2000, y: 300 }); });
  await sleep(200);
  const exLeft = await island.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#pface')).getPropertyValue('--ex')));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('island.html')); w.webContents.send('buddy:event', 'cursor', { x: 4000, y: 300 }); });
  await sleep(200);
  const exRight = await island.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#pface')).getPropertyValue('--ex')));
  assert(exLeft < -10 && exRight > 10, `eyes track cursor: ${exLeft} / ${exRight}`);
  assert(exLeft < -10 && exRight > 10, `eyes track cursor: ${exLeft} / ${exRight}`);
  // pet bubble: click face → bubble with input, send, reply streams in bubble
  await island.click('#pface', { force: true }); await sleep(400);
  assert(await island.evaluate(() => document.querySelector('#bubble').classList.contains('show')), 'pet bubble opens');
  await island.fill('#pinput', 'pet question make an image'); await island.keyboard.press('Enter');
  await island.waitForFunction(() => !window.__island.replyLive && window.__island.reply.includes('pet question'), null, { timeout: 15000 });
  await sleep(300); await island.screenshot({ path: path.join(OUT, 'e14_pet_bubble_reply.png') });
  assert(await island.evaluate(() => document.querySelector('#btext').textContent.includes('pet question')), 'reply shown in pet bubble');
  // frosted backdrop + top fade: a long thread over a busy "desktop" picture
  for (let k = 0; k < 6; k++) { await island.fill('#pinput', `thread line ${k} with a longer message so the thread grows past the space it has`); await island.keyboard.press('Enter'); await island.waitForFunction(() => !window.__island.replyLive, null, { timeout: 15000 }); }
  { const desk = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'desktop.jpg')).toString('base64');
    await island.evaluate(u => window.__backdrop({ url: u, display: { x: 0, y: 0, width: 1280, height: 800 } }), desk); await sleep(600);
    await island.evaluate(() => { const b = document.querySelector('#btext'); b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); }); await sleep(150);
    await island.screenshot({ path: path.join(OUT, 'e14b_pet_glass.png') });
    // reaction sheet: each expression is set and rendered on the pet
    { const faceBox = () => island.evaluate(() => { const r = document.querySelector('#pface').getBoundingClientRect(); return { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 44), width: r.width + 80, height: r.height + 70 }; });
      for (const ex of ['ponder', 'speak', 'happy', 'remind', 'error', 'listen']) { await island.evaluate(e => window.__react(e, 4000), ex); await sleep(ex === 'remind' ? 450 : 900); const box = await faceBox();
        assert(await island.evaluate(e => document.querySelector('#pface').classList.contains(e), ex), 'pet shows the ' + ex + ' reaction'); await island.screenshot({ path: path.join(OUT, `e14c_pet_${ex}.png`), clip: box }); }
      await island.evaluate(() => window.__react('idle', 10)); await sleep(200); }
    const g = await island.evaluate(() => ({ over: document.querySelector('#btext').classList.contains('over'), glassy: document.querySelector('#pet').classList.contains('glassy'), pos: document.querySelector('#pet .btext .m.ai').style.getPropertyValue('--gpos'), panel: !!document.querySelector('#bbg'), mask: getComputedStyle(document.querySelector('#btext')).webkitMaskImage }));
    assert(g.over && /gradient/.test(g.mask), 'long pet thread fades out at the top: ' + JSON.stringify(g));
    assert(g.glassy && /px/.test(g.pos) && !g.panel, 'each pet bubble gets its own glass, no panel behind the chat: ' + JSON.stringify(g)); }
    { const r = await island.evaluate(() => { const c = document.querySelector('#pet .composer').getBoundingClientRect(), b = document.querySelector('#pet .btext').getBoundingClientRect(), last = [...document.querySelectorAll('#pet .btext .m')].pop().getBoundingClientRect(); return { cr: c.right, cl: c.left, w: innerWidth, bl: b.left, ct: c.top, lb: last.bottom }; });
      assert(r.cr <= r.w && Math.abs(r.cl - r.bl) < 2 && r.ct >= r.lb - 1, 'glassy pet composer stays inside the window and under the messages: ' + JSON.stringify(r)); }
  await island.waitForFunction(() => { const i = document.querySelector('#btext .rimgs img'); return i && i.naturalWidth > 0; }, null, { timeout: 5000 });
  await island.screenshot({ path: path.join(OUT, 'e15_pet_bubble_image.png') });
  { const r = await island.evaluate(() => { const c = q => { const b = document.querySelector(q).getBoundingClientRect(); return +(b.left + b.width / 2).toFixed(1); }; return { face: c('#pface'), shadow: c('#pshadow i'), fw: c('#pet .fw'), pbody: c('#pet .pbody'), tf: document.querySelector('#pface').style.transform }; });
    const d = Math.abs(r.face - r.shadow); assert(d < 1.5, 'ground shadow centred under the pet: ' + JSON.stringify(r)); }
  // chat closed → the bot's reply pops up as a Messenger-style card with a quick-reply box; replying there continues the chat
  { await island.evaluate(() => { window.__island.petOpen = false; }); await sleep(300);
    await island.evaluate(() => window.buddyBridge.call('send', ['quick hello']));
    await island.waitForFunction(() => document.querySelector('#pnote').classList.contains('show') && /quick hello/.test(document.querySelector('#pntext').textContent), null, { timeout: 15000 });
    await sleep(500); await island.screenshot({ path: path.join(OUT, 'e15d_pet_reply_card.png') });
    await island.evaluate(() => { const i = document.querySelector('#pninput'); i.value = 'and again'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await island.waitForFunction(() => /and again/.test(document.querySelector('#pntext').textContent) && document.querySelector('#pnote').classList.contains('show'), null, { timeout: 15000 });
    assert(true, 'reply card shows the answer and the quick reply continues the chat');
    // Google Chat message → same card with the sender, space and a reply box
    await island.waitForFunction(() => !window.__island.info.busy, null, { timeout: 15000 }); await sleep(300);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('island.html')); w.webContents.send('buddy:event', 'gchat.message', { id: 'spaces/DM1/messages/m1', space: 'spaces/DM1', space_name: 'DM: Sara', direct: true, mention: false, from: 'Sara', text: 'Build ready? AppLovin wants it today', thread: 'spaces/DM1/threads/t1' }); });
    await island.waitForFunction(() => document.querySelector('#pnote').classList.contains('gchat') && /Sara/.test(document.querySelector('#pnname').textContent) && /AppLovin/.test(document.querySelector('#pntext').textContent), null, { timeout: 4000 });
    assert(/Reply to Sara/.test(await island.getAttribute('#pninput', 'placeholder')), 'Google Chat message shows on the pet with a reply box'); await sleep(400); await island.screenshot({ path: path.join(OUT, 'e15e_pet_gchat.png') });
    await island.click('#pnx'); await sleep(200);
    await island.evaluate(() => document.querySelector('#pntext').click()); await sleep(400);
    assert(await island.evaluate(() => !document.querySelector('#pnote').classList.contains('show') && window.__island.petOpen), 'tapping the card opens the full pet chat'); }
  // pet lock: dragging does nothing while locked
  { await island.evaluate(() => window.buddyBridge.call('save_settings', [{ pet_lock: true }])); await sleep(1300);
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('island')).getPosition());
    const f = await island.evaluate(() => { const r = document.querySelector('#pface').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await island.mouse.move(f.x, f.y); await island.mouse.down(); await island.mouse.move(f.x - 80, f.y - 60, { steps: 6 }); await island.mouse.up(); await sleep(400);
    const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('island')).getPosition());
    assert(before[0] === after[0] && before[1] === after[1], 'locked pet does not move when dragged');
    await island.evaluate(() => window.buddyBridge.call('save_settings', [{ pet_lock: false }])); await sleep(1300); }
  // AI image reply: shown as a picture with a save button, file path hidden from the text
  { const html = await island.evaluate(() => { const b = [...document.querySelectorAll('#btext .m.ai')].find(m => m.querySelector('.rimg')); return b ? { hasDl: !!b.querySelector('.rimg .dl'), text: b.textContent } : null; });
    assert(html && html.hasDl && !/buddy-256\.png/.test(html.text), 'AI image shows as a picture with a save button, no file path: ' + JSON.stringify(html)); }
  // paste an image into the pet chat (Ctrl+V of a screenshot) → saved, attached, shown as a chip with a thumbnail
  await app.evaluate(({ clipboard, nativeImage }, img) => clipboard.writeImage(nativeImage.createFromPath(img)), process.env.FAKE_IMG);
  const pasted = await island.evaluate(() => window.buddyBridge.call('paste_clipboard', []));
  assert(Array.isArray(pasted) && pasted.length === 1 && /paste-.*\.png$/.test(pasted[0]) && fs.existsSync(pasted[0]), 'clipboard image saved + attached: ' + JSON.stringify(pasted));
  await island.waitForFunction(() => document.querySelectorAll('#pfiles .f img').length > 0, null, { timeout: 4000 });
  assert(await island.evaluate(() => !!document.querySelector('#pclip') && document.querySelector('#pfiles .f span').textContent.startsWith('paste-')), 'pet shows the pasted image chip + attach button');
  await island.screenshot({ path: path.join(OUT, 'e15b_pet_pasted_image.png') });
  // WhatsApp-style send: caption + picture go out together, the picture shows inside the user's bubble, the tray empties
  assert(await island.evaluate(() => document.querySelector('#pinput').placeholder) === 'Add a caption…', 'caption placeholder while a picture is waiting');
  await island.evaluate(() => { const i = document.querySelector('#pinput'); i.value = 'review this'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await island.waitForFunction(() => [...document.querySelectorAll('#btext .m.user')].some(m => m.querySelector('.uimgs img') && /review this/.test(m.textContent)), null, { timeout: 8000 });
  await island.waitForFunction(() => !document.querySelector('#pfiles .f.pic'), null, { timeout: 4000 });
  await island.waitForFunction(() => !(window.__island.info && window.__island.info.busy), null, { timeout: 15000 }); await sleep(600);
  await island.screenshot({ path: path.join(OUT, 'e15c_pet_image_sent.png') });
  assert(true, 'pasted image sent inside the chat bubble, tray cleared');
  // second click closes; cursor movement / notifications never reopen the chat
  await island.click('#pface', { force: true }); await sleep(300);
  assert(!(await island.evaluate(() => document.querySelector('#bubble').classList.contains('show'))), 'second click hides pet chat');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('island.html')); w.webContents.send('buddy:event', 'cursor', { x: 10, y: 10 }); w.webContents.send('buddy:event', 'say', { text: 'Claude finished' }); });
  await sleep(400);
  assert(!(await island.evaluate(() => document.querySelector('#bubble').classList.contains('show'))) && await island.evaluate(() => document.querySelector('#ptoast').classList.contains('show')), 'mouse move / notification: chat stays closed, small pill shows');
  // working animation state is reflected on the body while busy
  await island.evaluate(() => window.buddyBridge.call('send', ['one more image']));
  await island.waitForFunction(() => document.body.classList.contains('working'), null, { timeout: 5000 });
  await island.waitForFunction(() => !window.__island.replyLive, null, { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('panel.html')); p.show(); });
  await panel.waitForFunction(() => { const i = document.querySelector('.msg.ai .imgs img'); return i && i.naturalWidth > 0; }, null, { timeout: 8000 });
  await panel.click('.nav button[data-view=chat]'); await sleep(300);
  await panel.screenshot({ path: path.join(OUT, 'e16_panel_image.png') });
  await panel.click('#pick'); await sleep(200); assert(await panel.isVisible('#seg button[data-p]'), 'provider menu opens'); await panel.screenshot({ path: path.join(OUT, 'e17_panel_picker.png') });
  await panel.click('#name'); assert(!(await panel.isVisible('#seg button[data-p]')), 'provider menu closes on outside click');
  await panel.click('#mode'); await sleep(250); assert((await panel.textContent('#foot')).includes('Can edit'), 'Do mode explained under the box'); await panel.screenshot({ path: path.join(OUT, 'e18_panel_do.png') });
  await panel.click('#mode'); await sleep(250);

  // Planner: reminders and scheduled AI tasks
  const nowMinute = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  await panel.click('.nav button[data-view=tasks]'); await panel.waitForSelector('#ptabs'); assert(await panel.isVisible('.task'), 'Planner opens on Tasks');
  await panel.click('#ptabs button[data-t=reminders]'); await panel.waitForSelector('#rm_text');
  await panel.fill('#rm_text', 'Stretch your legs'); await panel.click('.qchips .chip'); assert(/T/.test(await panel.inputValue('#rm_at')), 'quick time fills the picker');
  await panel.fill('#rm_at', nowMinute()); await panel.selectOption('#rm_rep', ''); await panel.click('#rm_add');
  await panel.waitForFunction(() => [...document.querySelectorAll('.msg.sys')].some(m => m.textContent.includes('Reminder: Stretch your legs')), null, { timeout: 8000 });
  await island.waitForFunction(() => !!document.querySelector('.prop.bell.show') || document.querySelector('#pface').classList.contains('remind') || document.querySelector('#face').classList.contains('remind'), null, { timeout: 4000 });
  assert(true, 'reminder fires: chat note + pet rings the bell');
  await panel.fill('#rm_text', 'Daily standup'); await panel.fill('#rm_at', (() => { const d = new Date(Date.now() + 3600e3); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; })()); await panel.selectOption('#rm_rep', 'daily'); await panel.click('#rm_add');
  await panel.waitForFunction(() => [...document.querySelectorAll('#rm_list .pitem')].some(i => i.textContent.includes('Daily standup') && i.textContent.includes('Every day')), null, { timeout: 4000 });
  assert(true, 'repeating reminder listed with its repeat badge');
  await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e20_panel_reminders.png') });
  await panel.click('#ptabs button[data-t=schedules]'); await panel.waitForSelector('#sc_prompt');
  await panel.fill('#sc_prompt', 'scheduled hello from planner'); await panel.fill('#sc_at', nowMinute()); await panel.selectOption('#sc_rep', ''); await panel.click('#sc_add');
  await panel.waitForFunction(() => [...document.querySelectorAll('.msg.ai .body')].some(b => b.textContent.includes('scheduled hello from planner')), null, { timeout: 15000 });
  await panel.waitForFunction(() => !!document.querySelector('#sc_list small.last.ok'), null, { timeout: 8000 });
  assert(true, 'schedule runs by itself, answer lands in chat, last run marked OK');
  await panel.fill('#sc_prompt', 'Every weekday: summarise my new messages'); await panel.fill('#sc_at', (() => { const d = new Date(Date.now() + 86400e3); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`; })()); await panel.selectOption('#sc_rep', 'weekdays'); await panel.click('#sc_mode button[data-m=do]'); await panel.click('#sc_add');
  await panel.waitForFunction(() => [...document.querySelectorAll('#sc_list .pitem')].some(i => i.textContent.includes('Weekdays') && i.textContent.includes('Do')), null, { timeout: 4000 });
  await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e21_panel_schedules.png') });
  // Workflows + Activity
  await panel.click('#ptabs button[data-t=workflows]'); await panel.waitForSelector('[data-tpl=briefing]'); await panel.click('[data-tpl=briefing]');
  await panel.waitForFunction(() => [...document.querySelectorAll('#pl-body .pitem')].some(i => i.textContent.includes('Morning briefing')), null, { timeout: 4000 });
  await panel.click('#wf_new'); await panel.fill('#wf_name', 'Ship check'); await panel.fill('.wstep .ws_text', 'say ship check ok'); await panel.click('#wf_save');
  await panel.waitForFunction(() => [...document.querySelectorAll('#pl-body .pitem')].some(i => i.textContent.includes('Ship check')), null, { timeout: 4000 });
  assert(true, 'workflow from template + one built by hand'); await sleep(250); await panel.screenshot({ path: path.join(OUT, 'e22_panel_workflows.png') });
  await panel.click('#ptabs button[data-t=activity]'); await panel.waitForSelector('#bg_new'); await panel.click('#bg_new summary'); await panel.fill('#bg_prompt', 'background research task'); await panel.click('#bg_go');
  await panel.waitForFunction(() => [...document.querySelectorAll('#jobs_list .job.done')].some(i => i.textContent.includes('background research task')), null, { timeout: 15000 }).catch(async e => { console.log('JOBS:', await panel.evaluate(() => document.querySelector('#pl-body').innerText.slice(0, 800))); await panel.screenshot({ path: path.join(OUT, 'fail_activity.png') }); throw e; });
  assert(true, 'background task runs and lands in Activity'); await panel.click('#jobs_list .job.done .pt'); await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e23_panel_activity.png') });
  // Settings: assistant, voice, watchers
  await panel.click('.nav button[data-view=settings]'); await panel.waitForSelector('#v_dict'); await panel.click('#w_gh summary'); await panel.evaluate(() => document.querySelector('#v_dict').closest('.set-group').previousElementSibling.scrollIntoView()); await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e24_panel_assistant_settings.png') });
  await panel.waitForFunction(() => document.querySelectorAll('#c_list [data-cli]').length === 3, null, { timeout: 15000 });
  assert(await panel.evaluate(() => /Claude Code/.test(document.querySelector('#c_list').innerText) && /Codex/.test(document.querySelector('#c_list').innerText)), 'Settings → AI tools lists Claude Code, Codex and Gemini with versions');
  await panel.evaluate(() => document.querySelector('#c_list').scrollIntoView({ block: 'center' })); await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e27_panel_ai_tools.png') });
  await panel.click('input.sw[data-k=voice_replies]'); await sleep(500); assert(await island.evaluate(() => window.__island.info.voice_replies === true), 'voice replies toggle saves instantly');
  await panel.click('input.sw[data-k=voice_replies]'); await sleep(300);
  // quick action window on the clipboard text
  await app.evaluate(({ clipboard }) => clipboard.writeText('this are a quick test'));
  await panel.evaluate(() => window.buddyBridge.call('quick_open', []));
  let quick; for (let i = 0; i < 40 && !quick; i++) { quick = app.windows().find(w => w.url().includes('quick.html')); if (!quick) await sleep(150); }
  assert(quick, 'quick action window opens'); await quick.waitForFunction(() => window.__quick && window.__quick.text.includes('quick test'), null, { timeout: 5000 });
  await quick.click('[data-a=fix]'); await quick.waitForFunction(() => !window.__quick.live && window.__quick.out.includes('quick test'), null, { timeout: 15000 });
  assert(!(await quick.isDisabled('#copy')), 'quick action result ready to copy'); await sleep(200); await quick.screenshot({ path: path.join(OUT, 'e25_quick_action.png') });
  await quick.click('#copy'); assert((await app.evaluate(({ clipboard }) => clipboard.readText())).includes('quick test'), 'Copy puts the result on the clipboard');
  await quick.keyboard.press('Escape'); await sleep(200);
  // chat search
  await panel.click('.nav button[data-view=chat]'); await sleep(200); await panel.click('#searchbtn'); await panel.fill('#cs_q', 'hello from the panel');
  await panel.waitForFunction(() => document.querySelectorAll('#cs_r .csi').length > 0, null, { timeout: 4000 }); assert(true, 'chat search finds earlier messages');
  await sleep(200); await panel.screenshot({ path: path.join(OUT, 'e26_panel_search.png') }); await panel.keyboard.press('Escape');
  await panel.click('.nav button[data-view=chat]'); await sleep(200);
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  assert(state.chat.filter(m => m.role === 'assistant').length === 14, 'fourteen replies persisted (incl. the scheduled run)');
  assert(state.chat.some(m => m.role === 'user' && Array.isArray(m.images) && m.images.length === 1 && m.text === 'review this'), 'image message saved with its picture');
  assert(state.tasks.length === 1 && state.reminders.length === 2 && state.schedules.length === 2, 'task + reminders + schedules persisted');
  await panel.click('.nav button[data-view=settings]'); await panel.waitForSelector('#s_clear'); await panel.click('#s_clear'); await panel.waitForSelector('.idea'); await sleep(300); await panel.screenshot({ path: path.join(OUT, 'e19_panel_empty.png') });
  await app.close();
  console.log('E2E OK →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
