@echo off
rem Install this repo's skills + both mc-studio modes. Windows entry point.
rem
rem The real installer is install.mjs (one implementation, shared with install.sh).
rem This file only switches the console to UTF-8, checks for node, and forwards
rem every argument. Keep it ASCII-only on purpose: cmd.exe parses a batch file
rem byte-wise in the CURRENT code page, so non-ASCII text here can desync the
rem parser (a UTF-8 comment once got executed). Node prints the Chinese output.
chcp 65001 >nul 2>nul
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required. DSH itself runs on Node, so it is usually already
  echo   installed. If not, install an LTS build from https://nodejs.org and run
  echo   this script again in a NEW cmd window.
  echo.
  exit /b 2
)

node "%~dp0install.mjs" %*
set MCART_EXIT=%ERRORLEVEL%
endlocal & exit /b %MCART_EXIT%
