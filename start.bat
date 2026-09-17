@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado no PATH.
  echo Instale o Node 18 ou mais novo: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo Instalando dependencias do Node...
  call npm install
  if errorlevel 1 (
    echo Falha no npm install.
    pause
    exit /b 1
  )
)

if not exist "tools\TtsTool.exe" (
  echo Compilando TtsTool ^(vozes do Windows^)...
  set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  set "SPEECH=C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll"
  "%CSC%" /nologo /t:exe /optimize+ /out:"tools\TtsTool.exe" /r:"%SPEECH%" "tools\TtsTool.cs"
  if errorlevel 1 (
    echo Falha ao compilar o TtsTool.
    pause
    exit /b 1
  )
)

echo.
echo Avatar Voxel  -  http://127.0.0.1:8787
echo Feche esta janela para encerrar o servidor.
echo.
start "" "http://127.0.0.1:8787"
node server.js
pause
