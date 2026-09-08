@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set NODE_NO_WARNINGS=1
call node scripts\diagnostico.mjs
echo.
pause
