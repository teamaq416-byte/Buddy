@echo off
rem Run Buddy from source (needs Python 3.11+ with tkinter, and Pillow).
cd /d "%~dp0"
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -m pip install --quiet pillow
%PY% main.py
