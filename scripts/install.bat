@echo off
REM Convenience wrapper: invoke the PowerShell installer with the right
REM execution policy so users can double-click instead of opening a terminal.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
