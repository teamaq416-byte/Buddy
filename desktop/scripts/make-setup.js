// Produces dist/Buddy-Setup.cmd: ONE file that installs Buddy on Windows.
// It embeds the app (base64 zip, ~1 MB), downloads the Electron runtime from GitHub,
// assembles %LOCALAPPDATA%\Buddy, stamps the exe, creates shortcuts and launches.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-setup-'));
const stage = path.join(tmp, 'app');

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(s)) continue;
    e.isDirectory() ? copyDir(s, d, skip) : fs.copyFileSync(s, d);
  }
}

// 1. stage the app payload (app + stamp tooling)
copyDir(path.join(ROOT, 'src'), path.join(stage, 'src'));
copyDir(path.join(ROOT, 'assets'), path.join(stage, 'assets'));
fs.mkdirSync(path.join(stage, 'scripts'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'stamp.mjs'), path.join(stage, 'scripts', 'stamp.mjs'));
for (const m of ['resedit', 'pe-library']) copyDir(path.join(ROOT, 'node_modules', m), path.join(stage, 'node_modules', m), p => /\.d\.ts$|\.map$|\/(esm|cjs\.map)$/.test(p));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, description: pkg.description, author: pkg.author, buddy: pkg.buddy }, null, 2));
const zip = path.join(tmp, 'app.zip');
execFileSync('zip', ['-qr', '-9', zip, '.'], { cwd: stage });
const payloadBytes = fs.statSync(zip).size;
// auto-update payload: the same app zip + a manifest (Buddy downloads these from the latest GitHub release)
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.copyFileSync(zip, path.join(ROOT, 'dist', 'Buddy-app.zip'));
fs.writeFileSync(path.join(ROOT, 'dist', 'update.json'), JSON.stringify({ version: pkg.version, electron: electronVersion, app: 'Buddy-app.zip', size: payloadBytes, sha256: require('crypto').createHash('sha256').update(fs.readFileSync(zip)).digest('hex') }, null, 2));
const b64 = fs.readFileSync(zip).toString('base64');
const lines = b64.match(/.{1,120}/g);

// 2. the installer script
const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/electron-v${electronVersion}-win32-x64.zip`;
const cmd = `@echo off
setlocal
title Buddy setup
set "VER=${electronVersion}"
set "APPVER=${pkg.version}"
set "TARGET=%LOCALAPPDATA%\\Buddy"
set "TMPD=%TEMP%\\buddy-setup"
set "SELF=%~f0"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
echo.
echo  ============================================
echo   Buddy %APPVER%  -  one-file setup
echo  ============================================
echo.
if not exist "%TMPD%" mkdir "%TMPD%"
if not exist "%TARGET%" mkdir "%TARGET%"
taskkill /f /im Buddy.exe >nul 2>nul && timeout /t 2 /nobreak >nul

echo  [1/5] Unpacking the app...
%PS% "$l = [IO.File]::ReadAllLines($env:SELF); $i = [Array]::IndexOf($l, '::PAYLOAD::'); $b = [Convert]::FromBase64String(($l[($i+1)..($l.Length-1)] -join '')); [IO.File]::WriteAllBytes((Join-Path $env:TMPD 'app.zip'), $b)" || goto :fail

echo  [2/5] Downloading the runtime (Electron %VER%, about 105 MB)...
rem a broken/partial download from an earlier try is thrown away instead of failing every run
if exist "%TMPD%\\electron-%VER%.zip" for %%A in ("%TMPD%\\electron-%VER%.zip") do if %%~zA LSS 50000000 del /q "%TMPD%\\electron-%VER%.zip"
if exist "%TMPD%\\electron-%VER%.zip" (
  echo        using cached download
) else (
  del /q "%TMPD%\\electron-%VER%.zip.part" >nul 2>nul
  %PS% "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile (Join-Path $env:TMPD 'electron-%VER%.zip.part')" || goto :faildl
  move /y "%TMPD%\\electron-%VER%.zip.part" "%TMPD%\\electron-%VER%.zip" >nul || goto :faildl
)
for %%A in ("%TMPD%\\electron-%VER%.zip") do if %%~zA LSS 50000000 goto :faildl

echo  [3/5] Installing to %TARGET% ...
for /d %%D in ("%TARGET%\\locales" "%TARGET%\\resources") do if exist "%%~D" rd /s /q "%%~D"
taskkill /f /im Buddy.exe >nul 2>nul
del /q "%TARGET%\\*.dll" "%TARGET%\\*.pak" "%TARGET%\\*.bin" "%TARGET%\\*.dat" "%TARGET%\\*.json" "%TARGET%\\*.exe" "%TARGET%\\LICENSE*" "%TARGET%\\version" >nul 2>nul
if exist "%TARGET%\\Buddy.exe" goto :locked
where tar >nul 2>nul && (tar -xf "%TMPD%\\electron-%VER%.zip" -C "%TARGET%") || (%PS% "Expand-Archive -LiteralPath (Join-Path $env:TMPD 'electron-%VER%.zip') -DestinationPath $env:TARGET -Force")
if not exist "%TARGET%\\electron.exe" goto :fail
%PS% "Expand-Archive -LiteralPath (Join-Path $env:TMPD 'app.zip') -DestinationPath (Join-Path $env:TARGET 'resources\\app') -Force" || goto :fail
del /q "%TARGET%\\resources\\default_app.asar" >nul 2>nul

echo  [4/5] Branding Buddy.exe...
set ELECTRON_RUN_AS_NODE=1
"%TARGET%\\electron.exe" "%TARGET%\\resources\\app\\scripts\\stamp.mjs" "%TARGET%\\electron.exe" "%TARGET%\\Buddy.exe" "%TARGET%\\resources\\app\\assets\\buddy.ico" "%APPVER%" >nul 2>nul
set ELECTRON_RUN_AS_NODE=
if exist "%TARGET%\\Buddy.exe" (del /q "%TARGET%\\electron.exe") else (move /y "%TARGET%\\electron.exe" "%TARGET%\\Buddy.exe" >nul)
%PS% "$s=New-Object -ComObject WScript.Shell; foreach($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))){ $l=$s.CreateShortcut((Join-Path $d 'Buddy.lnk')); $l.TargetPath=(Join-Path $env:TARGET 'Buddy.exe'); $l.WorkingDirectory=$env:TARGET; $l.IconLocation=(Join-Path $env:TARGET 'resources\\app\\assets\\buddy.ico'); $l.Description='Buddy - local AI companion'; $l.Save() }" >nul 2>nul
del /q "%TMPD%\\app.zip" >nul 2>nul

> "%TARGET%\\UNINSTALL.cmd" (
  echo @echo off
  echo taskkill /f /im Buddy.exe ^>nul 2^>nul ^&^& timeout /t 2 /nobreak ^>nul
  echo powershell -NoProfile -Command "foreach($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))){ Remove-Item -LiteralPath (Join-Path $d 'Buddy.lnk') -ErrorAction SilentlyContinue }"
  echo reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v Buddy /f ^>nul 2^>nul
  echo cd /d "%%~dp0"
  echo for /d %%%%D in ^(*^) do if /i not "%%%%~nxD"=="Buddy-data" rd /s /q "%%%%D"
  echo for %%%%F in ^(*^) do if /i not "%%%%~nxF"=="UNINSTALL.cmd" del /q "%%%%F"
  echo echo Buddy removed. Your tasks, memory and history are kept in "%%~dp0Buddy-data" - delete that folder to remove them too.
  echo pause
  echo ^(goto^) 2^>nul ^& del "%%~f0"
)
echo  [5/5] Starting Buddy...
start "" "%TARGET%\\Buddy.exe"
echo.
echo  Done. Buddy is installed in %TARGET%
echo  Shortcut: Desktop and Start menu.  Chat: Win+Shift+B.  Re-run this file to upgrade.
echo.
pause
exit /b 0

:locked
echo.
echo  Buddy.exe is still in use (a Claude/Codex/Gemini session may be using Buddy's tools).
echo  Close those terminals/apps, then run this file again.
pause
exit /b 1
:faildl
del /q "%TMPD%\\electron-%VER%.zip" "%TMPD%\\electron-%VER%.zip.part" >nul 2>nul
echo.
echo  Download failed. Check your internet connection and run this file again.
pause
exit /b 1
:fail
del /q "%TMPD%\\electron-%VER%.zip" >nul 2>nul
echo.
echo  Setup failed. Please send a screenshot of this window.
pause
exit /b 1

::PAYLOAD::
${lines.join('\r\n')}
`;
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'Buddy-Setup.cmd');
fs.writeFileSync(out, cmd.replace(/\r?\n/g, '\r\n'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', out, `(${(fs.statSync(out).size / 1024).toFixed(0)} KB, payload ${(payloadBytes / 1024).toFixed(0)} KB)`);
