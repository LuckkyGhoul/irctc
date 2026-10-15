@echo off
echo ========================================================
echo Starting IRCTC Train Booking System Backend Server...
echo ========================================================
cd /d "%~dp0"
set NODE_PATH=%~dp0extra_files\node_modules;%~dp0node_modules;%NODE_PATH%
node src/server.js
pause
