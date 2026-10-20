// Builds a portable Windows x64 folder (and zip) without needing Windows or wine:
// downloads the prebuilt Electron for win32, drops our app into resources/app,
// renames the exe and stamps the icon + version info with resedit (pure JS).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const OUT = path.join(ROOT, 'dist', 'Buddy-win-x64');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-electron-win-'));

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(s)) continue;
    e.isDirectory() ? copyDir(s, d, skip) : fs.copyFileSync(s, d);
  }
}

(async () => {
  console.log(`[1/4] Downloading Electron ${electronVersion} for win32-x64…`);
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', tmp, `electron@${electronVersion}`], {
    stdio: 'inherit', env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' },
  });
  const dist = path.join(tmp, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) throw new Error('electron.exe not found in ' + dist);

  console.log('[2/4] Assembling portable folder…');
  fs.rmSync(OUT, { recursive: true, force: true });
  copyDir(dist, OUT);
  fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'Buddy.exe'));
  fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });
  const appDir = path.join(OUT, 'resources', 'app');
  copyDir(ROOT, appDir, p => /node_modules|\/dist$|\/dist\/|\/tests$|\/scripts$|\.git/.test(p.replace(/\\/g, '/')));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, description: pkg.description, author: pkg.author, buddy: pkg.buddy }, null, 2));
  fs.writeFileSync(path.join(OUT, 'START BUDDY.cmd'), '@echo off\r\nstart "" "%~dp0Buddy.exe"\r\n');
  fs.writeFileSync(path.join(OUT, 'UNINSTALL.cmd'), ['@echo off', 'cd /d "%~dp0"', 'taskkill /f /im Buddy.exe >nul 2>nul && timeout /t 2 /nobreak >nul',
    `powershell -NoProfile -Command "foreach($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))){ Remove-Item -LiteralPath (Join-Path $d 'Buddy.lnk') -ErrorAction SilentlyContinue }"`,
    'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v Buddy /f >nul 2>nul',
    'echo This removes Buddy. Your data (Buddy-data) is kept - delete that folder yourself to remove it too.', 'pause',
    'for /d %%D in (*) do if /i not "%%~nxD"=="Buddy-data" rd /s /q "%%D"',
    'for %%F in (*) do if /i not "%%~nxF"=="UNINSTALL.cmd" del /q "%%F"',
    '(goto) 2>nul & del "%~f0"', ''].join('\r\n'));
  fs.writeFileSync(path.join(OUT, 'README.txt'), [
    'Buddy ' + pkg.version + ' (portable)', '',
    'Double-click Buddy.exe. Keep the folder together. Your data lives in Buddy-data next to the exe.',
    'Right-click Buddy (or the tray icon) for the menu. Win+Shift+B opens the chat.',
    'Pick Claude, Codex or Gemini in the chat. Buddy installs the CLI and opens the browser to sign in.', '',
  ].join('\r\n'));

  console.log('[3/4] Stamping icon and version info…');
  const ResEdit = require('resedit');
  const exePath = path.join(OUT, 'Buddy.exe');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'buddy.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [maj, min, pat] = pkg.version.split('.').map(n => parseInt(n, 10) || 0);
  vi.setFileVersion(maj, min, pat, 0, 1033); vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Buddy', FileDescription: 'Buddy — local AI companion', CompanyName: pkg.author, LegalCopyright: '© ' + pkg.author, OriginalFilename: 'Buddy.exe', InternalName: 'Buddy', FileVersion: pkg.version, ProductVersion: pkg.version });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  console.log('[4/4] Zipping…');
  const zip = path.join(ROOT, 'dist', `Buddy-${pkg.version}-win-x64-portable.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, 'Buddy-win-x64'], { cwd: path.join(ROOT, 'dist') });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Done →', zip, `(${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
})().catch(e => { console.error(e); process.exit(1); });
