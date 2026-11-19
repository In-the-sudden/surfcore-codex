@echo off
cd /d "%~dp0"
set SURFCORE_PANEL_PORT=0
node plugin/src/cli.mjs panel
pause
