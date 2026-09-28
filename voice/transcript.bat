@REM (c) 2026 Mathew. All rights reserved.
@echo off
REM Opens the Zarya live transcript viewer in its own window.
REM For an in-Cursor pane instead, split the terminal and run:
REM   powershell -ExecutionPolicy Bypass -File "%~dp0transcript.ps1"
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0transcript.ps1"
