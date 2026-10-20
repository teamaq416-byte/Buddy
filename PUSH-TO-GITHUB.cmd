@echo off
title Buddy - push to GitHub
cd /d "%~dp0"
echo.
echo  Buddy ko GitHub par bhej raha hoon...
echo.
where git >nul 2>nul
if errorlevel 1 (
  echo  Git install ho raha hai, 1-2 minute...
  winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
where git >nul 2>nul
if errorlevel 1 ( echo  Git install nahi ho saka. https://git-scm.com se install karke dobara chalao. & pause & exit /b 1 )
git remote remove origin >nul 2>nul
git remote add origin https://github.com/teamaq416-byte/Buddy.git
echo  Browser khulega - GitHub login kar dena.
git push -f origin main
if errorlevel 1 goto fail
for /f %%t in ('git tag --points-at HEAD') do git push -f origin %%t
echo.
echo  Ho gaya! GitHub par repo ka Actions tab dekho - release ban rahi hai.
start "" https://github.com/teamaq416-byte/Buddy/actions
pause
exit /b 0
:fail
echo.
echo  Push nahi hua. Is window ka screenshot bhej do.
pause
exit /b 1
