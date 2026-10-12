@echo off
rem Windows launcher: sets up on first run, then starts the site.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
set PYEXE=
where py >nul 2>nul && set PYEXE=py -3
if "%PYEXE%"=="" (where python >nul 2>nul && set PYEXE=python)
if "%PYEXE%"=="" (echo Python 3.9+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
if not exist .venv\Scripts\python.exe (
  echo Creating Python environment...
  %PYEXE% -m venv .venv || (pause & exit /b 1)
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt || (pause & exit /b 1)
)
set HAVESF=
if exist engines\stockfish.exe set HAVESF=1
where stockfish >nul 2>nul && set HAVESF=1
if defined STOCKFISH_PATH set HAVESF=1
if not defined HAVESF (
  echo.
  echo Stockfish not found. Download the Windows build from https://stockfishchess.org/download/
  echo then put the .exe at  %~dp0engines\stockfish.exe  ^(create the engines folder^) and run this again.
  pause & exit /b 1
)
if "%PORT%"=="" set PORT=3000
start "" http://localhost:%PORT%
node server.js
