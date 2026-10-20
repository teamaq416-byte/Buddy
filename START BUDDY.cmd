@echo off
cd /d "%~dp0"
if exist "%~dp0Buddy.exe" (
  start "" "%~dp0Buddy.exe"
  exit /b
)
rem Running from source: make sure Pillow is installed, then launch without a console.
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -c "import PIL" 2>nul || %PY% -m pip install --quiet pillow
where pyw >nul 2>nul && (start "" pyw -3 "%~dp0main.py") || (start "" pythonw "%~dp0main.py")
