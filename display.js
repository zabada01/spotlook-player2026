const { spawn, spawnSync, execFileSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const config = require('./config');
const cache  = require('./cache');
const logger = require('./logger');

let processusActuel = null;

// Profil Chrome dédié au player — isole le player du Chrome normal de l'utilisateur
// et garantit que --kiosk s'applique à chaque lancement (pas de réutilisation d'instance)
const CHROME_PROFILE_DIR = path.join(__dirname, 'chrome-profile');

const ARGS_CHROMIUM_BASE = [
  '--noerrdialogs',
  '--disable-infobars',
  '--disable-session-crashed-bubble',
  '--disable-features=TranslateUI',
  '--kiosk',
  '--always-on-top',
];

const ARGS_VLC_BASE = [
  '--fullscreen',
  '--video-on-top',
  '--no-osd',
  '--no-video-title-show',
  '--no-repeat',
  '--play-and-exit',
];

function tuerProcessusActuel() {
  if (processusActuel) {
    try {
      if (config.plateforme === 'windows' && processusActuel.pid) {
        // taskkill /T tue le processus ET tous ses enfants (Chrome crée des sous-processus)
        spawnSync('taskkill', ['/F', '/PID', String(processusActuel.pid), '/T'], { stdio: 'ignore' });
      } else {
        processusActuel.kill('SIGKILL');
      }
    } catch { /* ignore */ }
    processusActuel = null;
  }
}

function lancerProcessus(commande, args) {
  tuerProcessusActuel();
  logger.debug(`Lancement : ${commande} ${args.join(' ')}`);

  const proc = spawn(commande, args, {
    stdio: 'ignore',
    detached: false,
  });

  proc.on('error', (err) => logger.warn(`Erreur processus affichage : ${err.message}`));
  processusActuel = proc;
  return proc;
}

// Cas particulier : Node tourne dans WSL mais pointe vers un binaire Windows (chemin en
// .exe) — ni VLC ni Chromium ne comprennent les chemins Linux, il faut les traduire.
function estExecutableWindows(chemin) {
  return chemin.toLowerCase().endsWith('.exe');
}

function traduireCheminWindows(cheminWsl) {
  try {
    return execFileSync('wslpath', ['-w', cheminWsl]).toString().trim();
  } catch {
    return null; // pas dans WSL / wslpath indisponible
  }
}

function cheminPourVlc(fichier) {
  if (!estExecutableWindows(config.vlcPath)) return fichier;
  return traduireCheminWindows(fichier) || fichier;
}

// Chrome tournant côté Windows refuse un --user-data-dir en chemin Linux (ou UNC) — il
// lui faut un vrai chemin Windows local, sous peine de retomber sur le profil par défaut
// de l'utilisateur (et donc de rouvrir un onglet dans sa fenêtre Chrome existante au lieu
// de lancer une instance kiosque dédiée).
let dossierProfilChromiumCache = null;
function dossierProfilChromium() {
  if (dossierProfilChromiumCache) return dossierProfilChromiumCache;

  if (!estExecutableWindows(config.chromiumPath)) {
    dossierProfilChromiumCache = CHROME_PROFILE_DIR;
    return dossierProfilChromiumCache;
  }

  try {
    const tempWindows = execFileSync('cmd.exe', ['/c', 'echo %TEMP%']).toString().trim();
    dossierProfilChromiumCache = `${tempWindows}\\spotlook-chrome-profile`;
  } catch {
    logger.warn('Impossible de résoudre un répertoire de profil Windows pour Chromium — repli sur le chemin local');
    dossierProfilChromiumCache = CHROME_PROFILE_DIR;
  }
  return dossierProfilChromiumCache;
}

function argsChromium() {
  return [...ARGS_CHROMIUM_BASE, `--user-data-dir=${dossierProfilChromium()}`];
}

// Construit une URL file:// utilisable par le navigateur ciblé, en tenant compte du
// format Windows/UNC (file:///C:/... ou file://serveur/partage/...) si nécessaire.
function urlFichierPourChromium(fichier) {
  if (!estExecutableWindows(config.chromiumPath)) return `file://${fichier}`;

  const cheminWindows = traduireCheminWindows(fichier);
  if (!cheminWindows) return `file://${fichier}`;

  const barres = cheminWindows.replace(/\\/g, '/');
  return barres.startsWith('//') ? `file:${barres}` : `file:///${barres}`;
}

function afficherImage(filename) {
  const fichier = cache.cheminMedia(filename);
  lancerProcessus(config.chromiumPath, [...argsChromium(), urlFichierPourChromium(fichier)]);
}

function afficherVideo(filename) {
  const fichier = cheminPourVlc(cache.cheminMedia(filename));
  const argsVlc = config.plateforme === 'windows'
    ? [...ARGS_VLC_BASE, '--qt-fullscreen-screennumber=0', fichier]
    : [...ARGS_VLC_BASE, fichier];
  lancerProcessus(config.vlcPath, argsVlc);
}

function afficherUrl(url) {
  lancerProcessus(config.chromiumPath, [...argsChromium(), url]);
}

function afficherPanne() {
  tuerProcessusActuel();
  const urlPanne = urlFichierPourChromium(path.join(__dirname, 'panne.htm'));
  logger.warn(`Affichage page de panne : ${urlPanne}`);
  lancerProcessus(config.chromiumPath, [...argsChromium(), urlPanne]);
}

function afficherTexte(texte) {
  const escaped = texte
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const { fond, couleur, taillePx } = config.texte;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:${fond};display:flex;align-items:center;justify-content:center}
p{color:${couleur};font-size:${taillePx}px;font-family:sans-serif;text-align:center;padding:60px;line-height:1.4;max-width:1400px}
</style></head><body><p>${escaped}</p></body></html>`;
  const tmpFile = path.join(os.tmpdir(), 'spotlook-text.html');
  fs.writeFileSync(tmpFile, html, 'utf8');
  lancerProcessus(config.chromiumPath, [...argsChromium(), urlFichierPourChromium(tmpFile)]);
}

function afficherMedia(item) {
  const { type, filename, url } = item.media;

  tuerProcessusActuel();

  switch (type) {
    case 'image': afficherImage(filename); break;
    case 'video': afficherVideo(filename); break;
    case 'url':   afficherUrl(url);        break;
    case 'text':  afficherTexte(url);      break;
    default:
      logger.warn(`Type de média inconnu : ${type}`);
  }
}

function afficherEcranAttente() {
  tuerProcessusActuel();
  logger.info('Aucun contenu à diffuser — écran en attente');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center}
p{color:#64748b;font-size:32px;font-family:sans-serif}
</style></head><body><p>En attente de contenu…</p></body></html>`;
  const tmpFile = path.join(os.tmpdir(), 'spotlook-attente.html');
  fs.writeFileSync(tmpFile, html, 'utf8');
  lancerProcessus(config.chromiumPath, [...argsChromium(), urlFichierPourChromium(tmpFile)]);
}

module.exports = { afficherMedia, afficherEcranAttente, afficherPanne, tuerProcessusActuel };
