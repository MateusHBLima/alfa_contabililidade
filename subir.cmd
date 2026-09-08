@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
echo.
echo ============================================
echo   Planee Fiscal - subindo na sua maquina
echo ============================================
echo.
if not exist node_modules (
  echo Instalando dependencias... isso demora alguns minutos na primeira vez.
  call npm install || goto :erro
)
call node scripts\preparar-local.mjs || goto :erro
echo.
echo Abrindo http://localhost:8787 no navegador...
start "" http://localhost:8787
echo.
echo Deixe esta janela aberta. Ctrl+C encerra o servidor.
echo.
call npx wrangler dev --port 8787 --local
goto :fim
:erro
echo.
echo *** Algo falhou acima. Copie a mensagem e me mande. ***
pause
:fim
