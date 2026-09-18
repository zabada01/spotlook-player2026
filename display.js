const { spawn, spawnSync, execFileSync } = require('child_process');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const WebSocket = require('ws');
const config = require('./config');
const cache  = require('./cache');
const logger = require('./logger');

// ── Cycle de vie des processus ──────────────────────────────────────────
// Chromium reste ouvert en continu (une seule fenêtre kiosque) et on navigue
// dedans via CDP (Chrome DevTools Protocol) au lieu de le relancer à chaque
// média — ça évite le clignotement/saut de fenêtre entre deux contenus non-vidéo.
// VLC, lui, reste ponctuel : lancé par vidéo, il s'affiche par-dessus
// (--always-on-top) sans jamais toucher à Chromium en dessous.
//
// Exception : quand Node tourne dans WSL et pilote un Chrome Windows (VLC/Chromium
// en .exe), Chrome refuse d'exposer son port de debug ailleurs qu'en 127.0.0.1 —
// injoignable depuis WSL. Dans ce seul cas on retombe sur l'ancien comportement
// (relance à chaque média) : pas de régression fonctionnelle, juste un peu de
// clignotement propre à ce montage de test, absent sur les vraies cibles (RPi,
// Windows natif) où CDP fonctionne normalement.

let descripteurChromium = null;
let descripteurVlc      = null;
let cdpWs          = null;
let cdpCibleId     = null;
let cdpProchainId  = 1;
const cdpEnAttente = new Map(); // id -> { resolve, reject }

// Profil Chromium dédié au player — isole le player du navigateur normal de
// l'utilisateur et garantit que --kiosk s'applique (pas de réutilisation de profil)
const CHROME_PROFILE_DIR = path.join(__dirname, 'chrome-profile');

const ARGS_CHROMIUM_BASE = [
  '--noerrdialogs',
  '--disable-infobars',
  '--disable-session-crashed-bubble',
  '--disable-features=TranslateUI',
  '--kiosk',
  '--always-on-top',
  '--hide-scrollbars',
];

const ARGS_VLC_BASE = [
  '--fullscreen',
  '--video-on-top',
  '--no-osd',
  '--no-video-title-show',
  '--no-repeat',
  '--play-and-exit',
];

// ── Traduction de chemins WSL → Windows ─────────────────────────────────
// Cas particulier : Node tourne dans WSL mais pointe vers un binaire Windows
// (chemin en .exe) — ni VLC ni Chromium ne comprennent les chemins Linux.

function estExecutableWindows(chemin) {
  return chemin.toLowerCase().endsWith('.exe');
}

// Vrai uniquement dans le cas particulier décrit plus haut : Node dans WSL pilotant
// un Chromium Windows — nécessite le mode de repli (relance) pour l'affichage.
function estWslVersChromiumWindows() {
  return os.platform() === 'linux' && estExecutableWindows(config.chromiumPath);
}

// Sous WSL, spawn() d'un binaire Windows via l'interop ne renvoie que le PID du
// wrapper /init côté Linux — inutilisable pour un kill ultérieur (taskkill.exe attend
// un vrai PID Windows). On passe alors par PowerShell (Start-Process -PassThru) pour
// récupérer ce vrai PID.
function lancerViaPowershell(chemin, args) {
  const cheminWindows = traduireCheminWindows(chemin) || chemin;
  const argsFormat = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const script = `$p = Start-Process -FilePath '${cheminWindows.replace(/'/g, "''")}' -ArgumentList @(${argsFormat}) -PassThru; Write-Output $p.Id`;
  const sortie = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).toString().trim();
  const pid = parseInt(sortie, 10);
  if (!Number.isFinite(pid)) throw new Error(`PID Windows introuvable (sortie : "${sortie}")`);
  return pid;
}

function tuerPidWindows(pid) {
  if (!pid) return;
  try { spawnSync('taskkill.exe', ['/F', '/PID', String(pid), '/T'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

// Lance `chemin` avec `args` et retourne un descripteur { pid, tuer() } uniforme, quel
// que soit le mode de lancement sous-jacent (spawn direct, ou PowerShell pour le cas
// WSL → binaire Windows, seul moyen d'obtenir un PID exploitable pour le kill).
function lancerExecutable(chemin, args, { onExit } = {}) {
  if (os.platform() === 'linux' && estExecutableWindows(chemin)) {
    try {
      const pid = lancerViaPowershell(chemin, args);
      return { pid, tuer: () => tuerPidWindows(pid) };
    } catch (err) {
      logger.warn(`Erreur lancement (PowerShell) ${chemin} : ${err.message}`);
      return { pid: null, tuer: () => {} };
    }
  }

  const proc = spawn(chemin, args, { stdio: 'ignore', detached: false });
  proc.on('error', (err) => logger.warn(`Erreur processus ${chemin} : ${err.message}`));
  if (onExit) proc.on('exit', onExit);

  const utiliserTaskkill = estExecutableWindows(chemin) || config.plateforme === 'windows';
  return {
    pid: proc.pid,
    tuer: () => {
      try {
        if (utiliserTaskkill && proc.pid) spawnSync('taskkill.exe', ['/F', '/PID', String(proc.pid), '/T'], { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* ignore */ }
    },
  };
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

// Construit une URL file:// utilisable par le navigateur ciblé, en tenant compte du
// format Windows/UNC (file:///C:/... ou file://serveur/partage/...) si nécessaire.
function urlFichierPourChromium(fichier) {
  if (!estExecutableWindows(config.chromiumPath)) return `file://${fichier}`;

  const cheminWindows = traduireCheminWindows(fichier);
  if (!cheminWindows) return `file://${fichier}`;

  const barres = cheminWindows.replace(/\\/g, '/');
  return barres.startsWith('//') ? `file:${barres}` : `file:///${barres}`;
}

// Chrome tournant côté Windows refuse un --user-data-dir en chemin Linux (ou UNC) — il
// lui faut un vrai chemin Windows local, sous peine de retomber sur le profil par défaut
// de l'utilisateur.
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

// ── VLC (ponctuel, par vidéo) ────────────────────────────────────────────

function tuerVlc() {
  descripteurVlc?.tuer();
  descripteurVlc = null;
}

function afficherVideo(filename) {
  tuerVlc();
  const fichier = cheminPourVlc(cache.cheminMedia(filename));
  const argsVlc = config.plateforme === 'windows'
    ? [...ARGS_VLC_BASE, '--qt-fullscreen-screennumber=0', fichier]
    : [...ARGS_VLC_BASE, fichier];

  logger.debug(`Lancement : ${config.vlcPath} ${argsVlc.join(' ')}`);
  descripteurVlc = lancerExecutable(config.vlcPath, argsVlc);
}

// ── Chromium — mode A : fenêtre persistante pilotée via CDP ─────────────
// (RPi natif, Windows natif — CDP joignable en 127.0.0.1 sans restriction)

function lancerChromiumPersistant() {
  const args = [
    ...ARGS_CHROMIUM_BASE,
    `--user-data-dir=${dossierProfilChromium()}`,
    `--remote-debugging-port=${config.chromiumDebugPort}`,
    'about:blank',
  ];

  logger.debug(`Lancement Chromium (persistant) : ${config.chromiumPath} ${args.join(' ')}`);
  descripteurChromium = lancerExecutable(config.chromiumPath, args, {
    onExit: (code) => {
      logger.warn(`Chromium terminé (code=${code}) — relance dans 2s…`);
      descripteurChromium = null;
      fermerCdp();
      setTimeout(garantirChromiumDemarre, 2000);
    },
  });
}

function garantirChromiumDemarre() {
  if (!descripteurChromium) lancerChromiumPersistant();
}

function fermerCdp() {
  try { cdpWs?.close(); } catch { /* ignore */ }
  cdpWs = null;
  cdpCibleId = null;
  cdpEnAttente.forEach(({ reject }) => reject(new Error('Connexion CDP fermée')));
  cdpEnAttente.clear();
}

// Interroge l'endpoint HTTP de debug de Chromium pour récupérer l'URL du WebSocket CDP
// de son onglet — avec quelques tentatives, le temps que Chromium démarre.
function recupererCibleCdp(tentativesRestantes = 20) {
  return new Promise((resolve, reject) => {
    const essayer = (restantes) => {
      const req = http.get(
        { host: '127.0.0.1', port: config.chromiumDebugPort, path: '/json/list', timeout: 1000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const cibles = JSON.parse(Buffer.concat(chunks).toString());
              const page = cibles.find((c) => c.type === 'page');
              if (!page) throw new Error('Aucun onglet trouvé');
              resolve(page);
            } catch (err) {
              retenter(restantes, err);
            }
          });
        }
      );
      req.on('error', (err) => retenter(restantes, err));
      req.on('timeout', () => { req.destroy(); retenter(restantes, new Error('Timeout')); });
    };

    const retenter = (restantes, err) => {
      if (restantes <= 0) return reject(err);
      setTimeout(() => essayer(restantes - 1), 300);
    };

    essayer(tentativesRestantes);
  });
}

function connecterCdp() {
  if (cdpWs && cdpWs.readyState === WebSocket.OPEN) return Promise.resolve(cdpWs);

  return recupererCibleCdp().then((cible) => new Promise((resolve, reject) => {
    cdpCibleId = cible.id;
    const socket = new WebSocket(cible.webSocketDebuggerUrl);

    socket.on('open', () => { cdpWs = socket; resolve(socket); });
    socket.on('error', (err) => reject(err));
    socket.on('close', () => { if (cdpWs === socket) cdpWs = null; });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        const attente = cdpEnAttente.get(msg.id);
        if (attente) {
          cdpEnAttente.delete(msg.id);
          if (msg.error) attente.reject(new Error(msg.error.message));
          else attente.resolve(msg.result);
        }
      } catch { /* ignore messages non-JSON */ }
    });
  }));
}

function cdpEnvoyer(method, params = {}) {
  return connecterCdp().then((socket) => new Promise((resolve, reject) => {
    const id = cdpProchainId++;
    cdpEnAttente.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));

    setTimeout(() => {
      if (cdpEnAttente.has(id)) {
        cdpEnAttente.delete(id);
        reject(new Error(`Timeout CDP sur ${method}`));
      }
    }, 5000);
  }));
}

async function naviguerChromiumPersistant(url) {
  garantirChromiumDemarre();
  try {
    await cdpEnvoyer('Page.navigate', { url });
    if (cdpCibleId) await cdpEnvoyer('Target.activateTarget', { targetId: cdpCibleId });
  } catch (err) {
    logger.warn(`Erreur navigation Chromium (${url}) : ${err.message}`);
  }
}

// ── Chromium — mode B : relance à chaque média ───────────────────────────
// (repli WSL → Chrome Windows, cf. note en tête de fichier)

function afficherChromiumParRelance(url) {
  descripteurChromium?.tuer();
  const args = [...ARGS_CHROMIUM_BASE, `--user-data-dir=${dossierProfilChromium()}`, url];

  logger.debug(`Lancement : ${config.chromiumPath} ${args.join(' ')}`);
  descripteurChromium = lancerExecutable(config.chromiumPath, args);
}

// ── Dispatch selon le mode ────────────────────────────────────────────────

async function afficherDansChromium(url) {
  if (estWslVersChromiumWindows()) {
    afficherChromiumParRelance(url);
  } else {
    await naviguerChromiumPersistant(url);
  }
}

// ── Rendu des différents types de médias ─────────────────────────────────

function afficherImage(filename) {
  const fichier = cache.cheminMedia(filename);
  return afficherDansChromium(urlFichierPourChromium(fichier));
}

function afficherUrl(url) {
  return afficherDansChromium(url);
}

function afficherPanne() {
  tuerVlc();
  const urlPanne = urlFichierPourChromium(path.join(__dirname, 'panne.htm'));
  logger.warn(`Affichage page de panne : ${urlPanne}`);
  return afficherDansChromium(urlPanne);
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
  return afficherDansChromium(urlFichierPourChromium(tmpFile));
}

async function afficherMedia(item) {
  const { type, filename, url } = item.media;

  try {
    if (type === 'video') {
      afficherVideo(filename);
      return;
    }

    // Un média non-vidéo prend le relai : on referme VLC s'il était affiché,
    // Chromium (déjà ouvert en dessous, ou relancé selon le mode) reprend la main.
    tuerVlc();

    switch (type) {
      case 'image': await afficherImage(filename); break;
      case 'url':   await afficherUrl(url);        break;
      case 'text':  await afficherTexte(url);       break;
      default:
        logger.warn(`Type de média inconnu : ${type}`);
    }
  } catch (err) {
    logger.error(`Erreur affichage média : ${err.message}`);
  }
}

async function afficherEcranAttente() {
  tuerVlc();
  logger.info('Aucun contenu à diffuser — écran en attente');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center}
p{color:#64748b;font-size:32px;font-family:sans-serif}
</style></head><body><p>En attente de contenu…</p></body></html>`;
  const tmpFile = path.join(os.tmpdir(), 'spotlook-attente.html');
  fs.writeFileSync(tmpFile, html, 'utf8');
  try {
    await afficherDansChromium(urlFichierPourChromium(tmpFile));
  } catch (err) {
    logger.error(`Erreur affichage écran d'attente : ${err.message}`);
  }
}

// Prépare Chromium dès le démarrage du player (mode persistant uniquement — en mode
// relance il n'y a rien à préchauffer, chaque média relance son propre process).
function initialiser() {
  if (!estWslVersChromiumWindows()) garantirChromiumDemarre();
}

// Arrêt propre des processus (VLC ponctuel + Chromium) — utilisé à l'arrêt du player.
function tuerProcessusActuel() {
  tuerVlc();
  fermerCdp();
  descripteurChromium?.tuer();
  descripteurChromium = null;
}

module.exports = { initialiser, afficherMedia, afficherEcranAttente, afficherPanne, tuerProcessusActuel };
