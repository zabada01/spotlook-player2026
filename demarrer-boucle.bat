@echo off
rem Relance le player indefiniment - filet de securite en cas de crash ou de
rem coupure reseau prolongee. Les logs s'accumulent dans player.log.
cd /d %~dp0

:boucle
node player.js >> player.log 2>&1
timeout /t 5 /nobreak >nul
goto boucle
