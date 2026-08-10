@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0WithMate.exe" "%~dp0resources\resources\cli\withmate-session\withmate-session.mjs" %*
exit /b %ERRORLEVEL%
