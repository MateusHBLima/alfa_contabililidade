@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
echo.
echo ==================================================
echo   Planee Fiscal - publicar na Cloudflare
echo ==================================================
echo.
if not exist node_modules (
  echo Instalando dependencias...
  call npm install || goto :erro
)
set NODE_NO_WARNINGS=1
call node scripts\publicar.mjs || goto :erro
echo.
pause
goto :fim
:erro
echo.
echo *** Parou aqui. Leia a mensagem acima - ela diz o que fazer. ***
echo *** Rodar de novo continua de onde parou. ***
pause
:fim
