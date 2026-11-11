@echo off
title V Splitter - 4m 55s Clip Studio
cd /d "%~dp0"
echo Starting V Splitter on http://localhost:3456 ...
start "" "http://localhost:3456"
node server.js
pause
