@echo off
title Buddy uninstaller
set "TARGET=%LOCALAPPDATA%\Buddy"
taskkill /f /im Buddy.exe >nul 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v Buddy /f >nul 2>nul
del /q "%USERPROFILE%\Desktop\Buddy.lnk" >nul 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Buddy.lnk" >nul 2>nul
echo Your tasks/settings live in "%TARGET%\Buddy-data".
set /p KEEP=Keep that data? [Y/n]: 
if /i "%KEEP%"=="n" (rd /s /q "%TARGET%") else (
  for /d %%D in ("%TARGET%\*") do if /i not "%%~nxD"=="Buddy-data" rd /s /q "%%D"
  del /q "%TARGET%\*.*" >nul 2>nul
)
echo Buddy removed. MCP entries in Claude/Codex configs were left untouched (remove the "buddy" server there if you wish).
pause
