@echo off
setlocal
cd /d "%~dp0"
echo === Buddy build ===
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -c "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ required'" || goto :fail
%PY% -m pip install --upgrade --quiet pillow pyinstaller || goto :fail
%PY% -m pip install --upgrade --quiet pywebview >nul 2>nul
set "WEBOPTS="
%PY% -c "import webview, clr" >nul 2>nul && set "WEBOPTS=--collect-all webview --hidden-import clr"

echo [1/3] Building the MCP bridge (single-file, console app for stdio)...
%PY% -m PyInstaller --noconfirm --clean --onefile --console --name BuddyBridge ^
  --distpath build\bridge --workpath build\work-bridge --specpath build ^
  buddy\mcp_bridge.py || goto :fail

echo [2/3] Building Buddy.exe...
%PY% -m PyInstaller --noconfirm --clean --onedir --windowed --name Buddy --icon assets\buddy.ico ^
  --add-data "build\bridge\BuddyBridge.exe;bridge" --add-data "assets;assets" --add-data "buddy\web;buddy\web" %WEBOPTS% ^
  --distpath dist --workpath build\work --specpath build ^
  main.py || goto :fail

echo [3/3] Packaging portable folder...
copy /y "START BUDDY.cmd" "dist\Buddy\" >nul
copy /y README.md "dist\Buddy\README.md" >nul
echo.
echo Done: dist\Buddy\Buddy.exe   (keep Buddy.exe beside its _internal folder)
exit /b 0

:fail
echo.
echo Build failed. See messages above.
exit /b 1
