@echo off
rem Relance le player indefiniment - filet de securite en cas de crash ou de
rem coupure reseau prolongee. Les logs s'accumulent dans player.log.
cd /d %~dp0

rem Laisse Windows finir de demarrer (pilote graphique, ecran branche en HDMI,
rem etc.) avant le tout premier lancement - un lancement immediat au reboot
rem peut faire planter VLC/Chrome si le sous-systeme graphique n'est pas
rem encore pret. Ce delai n'a lieu qu'une fois, pas a chaque tour de boucle.
timeout /t 20 /nobreak >nul

:boucle
node player.js >> player.log 2>&1
timeout /t 5 /nobreak >nul
goto boucle
