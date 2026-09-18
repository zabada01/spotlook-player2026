<#
  Arrete le player Spotlook et les fenetres qu'il a ouvertes (Chrome via son
  profil dedie, VLC via le dossier de cache) sans toucher a un Chrome/VLC
  personnel eventuellement ouvert a cote.

  Necessaire car le lancement silencieux (lancer-silencieux.vbs) est du
  fire-and-forget : Stop-ScheduledTask n'a rien a arreter, le process qu'il
  suit (wscript.exe) s'est deja termine des le lancement de la boucle.

  Usage : .\arreter.ps1
#>

$cibles = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like '*player.js*' -or
  $_.CommandLine -like '*demarrer-boucle.bat*' -or
  ($_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*spotlook-chrome-profile*') -or
  ($_.Name -eq 'vlc.exe'    -and $_.CommandLine -like '*spotlook-cache*')
}

if (-not $cibles) {
  Write-Host "Aucun processus du player Spotlook trouve."
  exit 0
}

foreach ($p in $cibles) {
  Write-Host "Arret : $($p.Name) (PID $($p.ProcessId))"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Termine."
