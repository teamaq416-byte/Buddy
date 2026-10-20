@echo off
setlocal EnableDelayedExpansion
title Buddy installer
cd /d "%~dp0"
echo.
echo  ============================================
echo   Buddy 1.0  -  one-click install
echo  ============================================
echo.

rem ---------------------------------------------------------------- 1. Python
call :find_python
if not defined PY (
  echo  [1/5] Python not found - installing Python 3.12 for the current user...
  where winget >nul 2>nul
  if !errorlevel! equ 0 (
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements >nul 2>nul
  )
  call :find_python
  if not defined PY (
    echo        winget unavailable, downloading from python.org...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile \"$env:TEMP\buddy-python.exe\"" || goto :nopython
    "%TEMP%\buddy-python.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_tcltk=1 Include_pip=1 Include_launcher=1 || goto :nopython
    del /q "%TEMP%\buddy-python.exe" >nul 2>nul
    call :find_python
  )
  if not defined PY goto :nopython
)
echo  [1/5] Python: %PY%

rem ---------------------------------------------------------------- 2. Deps
echo  [2/5] Installing dependencies (Pillow, PyInstaller)...
%PY% -m pip install --quiet --upgrade pip >nul 2>nul
%PY% -m pip install --quiet --upgrade pillow || (
  echo        pip failed - retrying with --user...
  %PY% -m pip install --quiet --user --upgrade pillow || goto :fail_deps
)
%PY% -m pip install --quiet --upgrade pyinstaller >nul 2>nul
%PY% -m pip install --quiet --upgrade pywebview >nul 2>nul
%PY% -c "import tkinter, PIL" 2>nul || goto :fail_deps
set "WEBOPTS="
%PY% -c "import webview, clr" >nul 2>nul && set "WEBOPTS=--collect-all webview --hidden-import clr"
if defined WEBOPTS (echo        web panel: WebView2 ready) else (echo        web panel unavailable - Buddy will use the classic panel)

rem ---------------------------------------------------------------- 3. Build
set "TARGET=%LOCALAPPDATA%\Buddy"
echo  [3/5] Building Buddy.exe (about a minute)...
if exist build rd /s /q build >nul 2>nul
if exist dist rd /s /q dist >nul 2>nul
mkdir build >nul 2>nul
set "BUILT="
%PY% -m PyInstaller --noconfirm --clean --onefile --console --name BuddyBridge --distpath build\bridge --workpath build\work-bridge --specpath build buddy\mcp_bridge.py >build\bridge.log 2>&1
if exist build\bridge\BuddyBridge.exe (
  %PY% -m PyInstaller --noconfirm --clean --onedir --windowed --name Buddy --icon assets\buddy.ico --add-data "build\bridge\BuddyBridge.exe;bridge" --add-data "assets;assets" --add-data "buddy\web;buddy\web" %WEBOPTS% --distpath dist --workpath build\work --specpath build main.py >build\app.log 2>&1
  if exist dist\Buddy\Buddy.exe set "BUILT=1"
)

rem ---------------------------------------------------------------- 4. Install
echo  [4/5] Installing to %TARGET% ...
if exist "%TARGET%\Buddy.exe" (
  taskkill /f /im Buddy.exe >nul 2>nul
  timeout /t 1 /nobreak >nul
)
if not exist "%TARGET%" mkdir "%TARGET%"
if defined BUILT (
  rem keep Buddy-data (tasks, settings) across upgrades
  for /d %%D in ("%TARGET%\_internal") do rd /s /q "%%D" >nul 2>nul
  xcopy /e /i /y /q dist\Buddy "%TARGET%" >nul
  set "LAUNCH=%TARGET%\Buddy.exe"
  set "LAUNCH_ARGS="
) else (
  echo        exe build skipped/failed - installing the source version instead ^(same features^).
  xcopy /e /i /y /q buddy "%TARGET%\buddy" >nul
  xcopy /e /i /y /q assets "%TARGET%\assets" >nul
  copy /y main.py "%TARGET%\" >nul
  copy /y README.md "%TARGET%\" >nul
  for /f "delims=" %%P in ('%PY% -c "import sys,os;p=sys.executable;w=os.path.join(os.path.dirname(p),'pythonw.exe');print(w if os.path.exists(w) else p)"') do set "LAUNCH=%%P"
  set "LAUNCH_ARGS=%TARGET%\main.py"
)

rem Shortcuts (Desktop + Start menu)
if not exist "%TARGET%\assets" mkdir "%TARGET%\assets"
copy /y assets\buddy.ico "%TARGET%\assets\" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File tools\shortcut.ps1 -Target "%LAUNCH%" -Arguments "%LAUNCH_ARGS%" -WorkDir "%TARGET%" -Icon "%TARGET%\assets\buddy.ico" >nul 2>nul

rem ---------------------------------------------------------------- 5. Launch
echo  [5/5] Starting Buddy...
if defined LAUNCH_ARGS (
  start "" "%LAUNCH%" "%LAUNCH_ARGS%"
) else (
  start "" "%LAUNCH%"
)
echo.
echo  Done. Buddy is installed in %TARGET%
echo  A "Buddy" shortcut is on your Desktop and in the Start menu.
echo  Turn on "Start with Windows" inside Buddy ^> Settings if you want it always on.
echo.
pause
exit /b 0

rem ---------------------------------------------------------------- helpers
:find_python
set "PY="
for %%C in ("py -3.13" "py -3.12" "py -3.11" "py -3" "python" "python3") do (
  if not defined PY (
    %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul && set "PY=%%~C"
  )
)
if not defined PY (
  for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if not defined PY if exist "%%D\python.exe" (
      "%%D\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul && set "PY=%%D\python.exe"
    )
  )
)
exit /b 0

:nopython
echo.
echo  Could not install Python automatically.
echo  Install Python 3.12 from https://www.python.org/downloads/ (tick "Add to PATH"), then run INSTALL.cmd again.
pause
exit /b 1

:fail_deps
echo.
echo  Could not install Pillow (needs internet for pip). Check your connection and run INSTALL.cmd again.
pause
exit /b 1
