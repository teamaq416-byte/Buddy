#!/usr/bin/env node
// Fake Gemini CLI for tests: speaks the headless stream-json protocol (init / message deltas / tool_use / result).
const args = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => stdin += d);
process.stdin.on('end', async () => {
  const p = args.indexOf('-p'); const prompt = (stdin ? stdin + '\n' : '') + (p >= 0 ? args[p + 1] : '');
  const q = ((stdin.trim() || prompt.trim()).split('\n').filter(l => l.trim()).pop() || '').slice(0, 80); const resumed = args.includes('--resume');
  const out = o => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n');
  out({ type: 'init', session_id: 'sess-' + Date.now(), model: 'gemini-2.5-pro' });
  out({ type: 'message', role: 'user', content: prompt.slice(0, 50) });
  if (/image/i.test(q)) { out({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: { file_path: 'coin.png' } }); await sleep(60); out({ type: 'tool_result', tool_id: 't1', status: 'success' }); }
  const extra = /image/i.test(q) ? ` Here is the coin image: ${process.env.FAKE_IMG} Enjoy.` : '';
  const words = (`Hey! I'm Buddy. You sent "${q}" ${resumed ? 'in a resumed session' : 'and I can see the context'}. Streaming word by word.` + extra).split(' ');
  for (let i = 0; i < words.length; i++) { out({ type: 'message', role: 'assistant', content: words[i] + (i < words.length - 1 ? ' ' : ''), delta: true }); await sleep(25); }
  out({ type: 'result', status: 'success', stats: {} });
});
