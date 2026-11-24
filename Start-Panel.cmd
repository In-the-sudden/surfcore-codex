@echo off
cd /d "%~dp0"
node plugin/src/cli.mjs panel-open
if errorlevel 1 pause
