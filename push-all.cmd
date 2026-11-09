@echo off
REM Double-click to publish code. Configure server variables in Vercel only.
setlocal
cd /d "%~dp0"

echo.
echo Publishing Imagine to GitHub and Vercel...
git push origin main
if errorlevel 1 (
  echo.
  echo Git push failed. Check GitHub login, then try again.
  pause
  exit /b 1
)

echo.
echo Done. Vercel will deploy automatically.
echo Site: https://imagine-studio-vercel.vercel.app
pause
