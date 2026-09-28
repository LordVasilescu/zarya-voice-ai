@REM (c) 2026 Mathew. All rights reserved.
@echo off
title ZARYA//CONSOLE
cd /d "%~dp0"
echo Starting ZARYA//CONSOLE...
start "" http://localhost:8788
node server.js
pause
