@echo off
rem Double-cliquer sur ce fichier pour arreter le player Spotlook
rem (node, Chrome et VLC lances par lui) sans avoir a ouvrir PowerShell.
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arreter.ps1"
echo.
pause
