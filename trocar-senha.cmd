@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set NODE_NO_WARNINGS=1
echo.
echo  Trocar a senha de um usuario do Planee Fiscal (producao)
echo.
set /p EMAIL=E-mail do usuario: 
call node scripts\trocar-senha.mjs %EMAIL%
echo.
pause
