// Copies the shared panel UI from the Python edition and injects the Electron bridge shim.
const fs = require('fs'); const path = require('path');
const src = path.join(__dirname, '..', '..', 'buddy', 'web', 'panel.html');
const dst = path.join(__dirname, '..', 'src', 'renderer', 'panel.html');
const shim = `<script>
// Electron shim: expose the same window.pywebview.api surface the panel was written against.
(() => { const b = window.buddyBridge; if (!b) return;
  window.pywebview = { api: new Proxy({}, { get: (_, m) => (...a) => b.call(m, a) }) };
  b.onEvent((k, p) => window.buddy && window.buddy.on(k, p));
  // Native file drop → attach
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); const paths = [...e.dataTransfer.files].map(f => b.pathFor(f)).filter(Boolean); if (paths.length) b.call('attach_paths', [paths]); });
  // Ctrl+V of an image (screenshot / copied picture) or files copied in Explorer → attach
  document.addEventListener('paste', e => { const cd = e.clipboardData; if (!cd) return; const files = [...(cd.files || [])]; const paths = files.map(f => b.pathFor(f)).filter(Boolean);
    if (paths.length) { e.preventDefault(); b.call('attach_paths', [paths]); return; }
    if (files.length || [...(cd.items || [])].some(it => it.kind === 'file')) { e.preventDefault(); b.call('paste_clipboard', []); } });
})();
</script>`;
let html = fs.readFileSync(src, 'utf8');
html = html.replace('<title>Buddy</title>', '<title>Buddy</title>\n' + shim);
// drag region for the frameless window header (Electron honours -webkit-app-region)
html = html.replace('.drag{-webkit-app-region:drag}', '.drag{-webkit-app-region:drag}.nav,.nav button,.face{-webkit-app-region:no-drag}');
fs.writeFileSync(dst, html);
console.log('panel synced →', dst);
