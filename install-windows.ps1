<#
  Installe le client de diffusion Spotlook sur une machine Windows native.
  A executer depuis une invite PowerShell, dans le dossier client-player
  (de preference en administrateur, pour l'installation des dependances
  via winget et la creation de la tache planifiee).

  Usage : .\install-windows.ps1

  Note : ce fichier est volontairement en ASCII pur (sans accents) car
  PowerShell 5.1 lit les scripts sans BOM en Windows-1252 par defaut,
  ce qui casse le parsing des caracteres accentues.
#>

$ErrorActionPreference = 'Stop'
$dossier = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dossier

function EcrireEtape($texte) {
  Write-Host ""
  Write-Host "==> $texte" -ForegroundColor Cyan
}

function CommandeExiste($nom) {
  return [bool](Get-Command $nom -ErrorAction SilentlyContinue)
}

function ProposerInstallViaWinget($id, $nomAffiche) {
  if (-not (CommandeExiste 'winget')) {
    Write-Warning "winget indisponible sur cette machine - installe $nomAffiche manuellement puis relance ce script."
    return $false
  }
  $reponse = Read-Host "$nomAffiche n'est pas detecte. L'installer maintenant via winget ? (o/N)"
  if ($reponse -notmatch '^[oOyY]') { return $false }
  winget install --id $id -e --accept-source-agreements --accept-package-agreements
  return $true
}

# --- 1. Node.js ------------------------------------------------------------
EcrireEtape "Verification de Node.js"
if (-not (CommandeExiste 'node')) {
  ProposerInstallViaWinget 'OpenJS.NodeJS.LTS' 'Node.js' | Out-Null
  Write-Host "Ferme et rouvre cette invite PowerShell pour que 'node' soit reconnu, puis relance ce script." -ForegroundColor Yellow
  exit 0
}
Write-Host "Node.js detecte : $(node --version)"

# --- 2. Chrome ---------------------------------------------------------------
EcrireEtape "Verification de Google Chrome"
$cheminChrome = "$Env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $cheminChrome)) {
  ProposerInstallViaWinget 'Google.Chrome' 'Google Chrome' | Out-Null
}

# --- 3. VLC ------------------------------------------------------------------
EcrireEtape "Verification de VLC"
$cheminVlc = "$Env:ProgramFiles\VideoLAN\VLC\vlc.exe"
if (-not (Test-Path $cheminVlc)) {
  ProposerInstallViaWinget 'VideoLAN.VLC' 'VLC' | Out-Null
}

# --- 4. Dependances npm --------------------------------------------------------
EcrireEtape "Installation des dependances npm"
npm install --omit=dev

# --- 5. Configuration (.env) --------------------------------------------------
EcrireEtape "Configuration"
$fichierEnv = Join-Path $dossier '.env'
if (Test-Path $fichierEnv) {
  Write-Host "Un fichier .env existe deja - conserve tel quel."
} else {
  $serveur = Read-Host "URL du serveur Spotlook (ex: http://192.168.1.10:3000)"
  $token   = Read-Host "Token de cet ecran (Portail > Ecrans > Enregistrer un ecran)"

  @"
SERVER_URL=$serveur
SCREEN_TOKEN=$token
CACHE_DIR=C:\spotlook-cache
PLATFORM=windows
LOG_LEVEL=info
"@ | Set-Content -Path $fichierEnv -Encoding UTF8

  Write-Host "Fichier .env cree."
}

# --- 6. Tache planifiee (lancement automatique a l'ouverture de session) -----
EcrireEtape "Configuration du lancement automatique"

$nomTache = 'SpotlookPlayer'
$vbsPath  = Join-Path $dossier 'lancer-silencieux.vbs'

if (Get-ScheduledTask -TaskName $nomTache -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $nomTache -Confirm:$false
}

$action      = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
$declencheur = New-ScheduledTaskTrigger -AtLogOn
$parametres  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $nomTache -Action $action -Trigger $declencheur `
  -Settings $parametres -Description "Lance le player Spotlook a l'ouverture de session" | Out-Null

Write-Host "Tache planifiee '$nomTache' creee." -ForegroundColor Green
Write-Host "Le relancement automatique en cas de crash est gere par demarrer-boucle.bat (boucle avec 5s de delai)."

# --- 7. Lancement immediat ----------------------------------------------------
$reponse = Read-Host "`nLancer le player maintenant ? (o/N)"
if ($reponse -match '^[oOyY]') {
  Start-ScheduledTask -TaskName $nomTache
  Write-Host "Player lance - les logs s'ecrivent dans player.log" -ForegroundColor Green
}

Write-Host ""
Write-Host "Installation terminee." -ForegroundColor Green
Write-Host "Pour un vrai kiosque (demarrage sans intervention), configure la connexion"
Write-Host "automatique de session Windows : netplwiz, puis decoche la case de mot de passe."
Write-Host ""
Write-Host "Pour arreter le player : Stop-ScheduledTask -TaskName $nomTache, puis fermer"
Write-Host "les processus node.exe / chrome.exe / vlc.exe restants (Gestionnaire des taches)."
Write-Host "Pour desinstaller la tache planifiee : Unregister-ScheduledTask -TaskName $nomTache"
