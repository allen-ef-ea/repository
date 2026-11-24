@echo off
cd /d "%~dp0"
set "PORT=8765"

where python >nul 2>nul
if errorlevel 1 goto nopython

start "basepay-server" /min python -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 >nul
start "" "http://127.0.0.1:%PORT%/"
exit

:nopython
echo.
echo   Python not found in PATH.
echo   The tool also works offline: opening index.html directly in a browser.
echo.
start "" "index.html"
