@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0WithMate.exe" "%~dp0resources\resources\skills\withmate-glossary\bin\withmate-glossary.mjs" %*
exit /b %ERRORLEVEL%
