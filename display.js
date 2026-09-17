const { spawn, spawnSync } = require('child_process');
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

const ARGS_CHROMIUM = [
  '--noerrdialogs',
  '--disable-infobars',
  '--disable-session-crashed-bubble',
  '--disable-features=TranslateUI',
  '--kiosk',
  '--always-on-top',
  `--user-data-dir=${CHROME_PROFILE_DIR}`,
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

function afficherImage(filename) {
  const fichier = cache.cheminMedia(filename);
  lancerProcessus(config.chromiumPath, [...ARGS_CHROMIUM, `file://${fichier}`]);
}

function afficherVideo(filename) {
  const fichier = cache.cheminMedia(filename);
  const argsVlc = config.plateforme === 'windows'
    ? [...ARGS_VLC_BASE, '--qt-fullscreen-screennumber=0', fichier]
    : [...ARGS_VLC_BASE, fichier];
  lancerProcessus(config.vlcPath, argsVlc);
}

function afficherUrl(url) {
  lancerProcessus(config.chromiumPath, [...ARGS_CHROMIUM, url]);
}

function afficherPanne() {
  tuerProcessusActuel();
  const urlPanne = `file://${path.join(__dirname, 'panne.htm')}`;
  logger.warn(`Affichage page de panne : ${urlPanne}`);
  lancerProcessus(config.chromiumPath, [...ARGS_CHROMIUM, urlPanne]);
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
  lancerProcessus(config.chromiumPath, [...ARGS_CHROMIUM, `file://${tmpFile}`]);
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
  lancerProcessus(config.chromiumPath, [...ARGS_CHROMIUM, `file://${tmpFile}`]);
}

module.exports = { afficherMedia, afficherEcranAttente, afficherPanne, tuerProcessusActuel };
