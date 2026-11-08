@echo off
REM Double-click this file. It pushes the code to GitHub and the env vars to
REM Vercel, then redeploys. No terminal commands needed.
setlocal
cd /d "%~dp0"

echo.
echo === 1/2 pushing code to GitHub
git push origin main
if errorlevel 1 (
  echo.
  echo Git push failed. Check that you are logged in to GitHub, then run this
  echo file again.
  pause
  exit /b 1
)

echo.
echo === 2/2 pushing env vars to Vercel and redeploying
powershell -ExecutionPolicy Bypass -File "%~dp0push-env.ps1"
if errorlevel 1 (
  echo.
  echo Env push failed. See the message above.
  pause
  exit /b 1
)

echo.
echo Done. Site: https://imagine-studio-vercel.vercel.app
pause
