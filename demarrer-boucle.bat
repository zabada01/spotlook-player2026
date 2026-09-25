@echo off
rem Relance le player indefiniment - filet de securite en cas de crash ou de
rem coupure reseau prolongee. Le player ecrit lui-meme ses logs dans player.log
rem (decoupe automatiquement, cf. logger.js) ; seuls les messages de plantage
rem arrivent ici, dans player-crash.log (limite a 1 Mo, une archive).
cd /d %~dp0

rem Laisse Windows finir de demarrer (pilote graphique, ecran branche en HDMI,
rem etc.) avant le tout premier lancement - un lancement immediat au reboot
rem peut faire planter VLC/Chrome si le sous-systeme graphique n'est pas
rem encore pret. Ce delai n'a lieu qu'une fois, pas a chaque tour de boucle.
timeout /t 20 /nobreak >nul

:boucle
if exist player-crash.log for %%F in (player-crash.log) do if %%~zF GTR 1048576 move /y player-crash.log player-crash.log.1 >nul
node player.js >> player-crash.log 2>&1
timeout /t 5 /nobreak >nul
goto boucle
