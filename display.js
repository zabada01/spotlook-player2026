const { spawn, spawnSync } = require('child_process');
const path   = require('path');
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

function afficherMedia(item) {
  const { type, filename, url } = item.media;

  tuerProcessusActuel();

  switch (type) {
    case 'image': afficherImage(filename); break;
    case 'video': afficherVideo(filename); break;
    case 'url':   afficherUrl(url);        break;
    case 'text':
      afficherUrl(`data:text/html,<html style="background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><p style="color:#fff;font-size:48px;font-family:sans-serif;text-align:center">${encodeURIComponent(url)}</p></html>`);
      break;
    default:
      logger.warn(`Type de média inconnu : ${type}`);
  }
}

function afficherEcranAttente() {
  tuerProcessusActuel();
  logger.info('Aucun contenu à diffuser — écran en attente');
  lancerProcessus(config.chromiumPath, [
    ...ARGS_CHROMIUM,
    'data:text/html,<html style="background:#1e293b;display:flex;align-items:center;justify-content:center;height:100vh"><p style="color:#64748b;font-size:32px;font-family:sans-serif">En attente de contenu…</p></html>',
  ]);
}

module.exports = { afficherMedia, afficherEcranAttente, afficherPanne, tuerProcessusActuel };
