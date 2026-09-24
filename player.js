/**
 * Spotlook Player — Boucle de diffusion principale
 *
 * Flux :
 *  1. Initialise le cache local
 *  2. Synchronise le planning depuis l'API (ou charge le cache si hors-ligne)
 *  3. Télécharge les médias manquants
 *  4. Diffuse les items en boucle selon leur durée
 *  5. Écoute les notifications WS pour déclencher une re-sync immédiate
 *  6. Envoie un heartbeat toutes les 60s
 */

require('dotenv').config();
const cache   = require('./cache');
const sync    = require('./sync');
const display = require('./display');
const ws      = require('./ws');
const logger  = require('./logger');
const config  = require('./config');
const { spawn } = require('child_process');

const INTERVALLE_HEARTBEAT_MS = 60_000;
const INTERVALLE_SYNC_MS      = 5 * 60_000;
const DELAI_ATTENTE_MS        = 30_000;

let itemsActifs      = [];
let enVeilleActuel   = false;
let indexActuel      = 0;
let timerItem        = null;
let syncEnCours      = false;
let contenuActuel    = null;
let serveurJoignable = true;
let timerRetry       = null;

async function demarrer() {
  logger.info(`=== Spotlook Player ${config.playerVersion} démarré ===`);
  cache.initialiser();
  display.initialiser();

  await synchroniser();

  ws.connecter(async () => {
    logger.info('Mise à jour WS reçue — re-synchronisation…');
    await synchroniser();
    relancerBoucle();
    // Heartbeat immédiat : le témoin "Contenus" du portail reflète tout de
    // suite le nouveau planning (téléchargements lancés par synchroniser()).
    await envoyerHeartbeat();
  }, { redemarrer: redemarrerPC });

  setInterval(envoyerHeartbeat, INTERVALLE_HEARTBEAT_MS);

  setInterval(async () => {
    if (!syncEnCours) { await synchroniser(); relancerBoucle(); }
  }, INTERVALLE_SYNC_MS);

  relancerBoucle();
}

async function synchroniser() {
  if (syncEnCours) return;
  syncEnCours = true;
  try {
    let data;
    try {
      data = await sync.obtenirSchedule();

      if (!serveurJoignable) {
        logger.info('Serveur à nouveau joignable — reprise normale');
        serveurJoignable = true;
        arreterRetry();
      }
    } catch (err) {
      logger.warn(`Serveur inaccessible : ${err.message}`);

      if (cache.scheduleValide()) {
        logger.info('Mode hors-ligne — utilisation du cache local');
        data = cache.chargerSchedule();
      } else {
        if (serveurJoignable) {
          logger.warn('Aucun cache valide — affichage page de panne');
          serveurJoignable = false;
          display.afficherPanne();
        }
        demarrerRetry();
        itemsActifs = [];
        enVeilleActuel = false;
        return;
      }
    }

    itemsActifs = data?.items || [];
    enVeilleActuel = data?.enVeille || false;
    // En arrière-plan : ne bloque pas les synchronisations suivantes (planning,
    // heures de veille) pendant le téléchargement d'une grosse vidéo.
    if (itemsActifs.length > 0) sync.lancerTelechargements(itemsActifs);
  } catch (err) {
    logger.error(`Erreur synchronisation : ${err.message}`);
  } finally {
    syncEnCours = false;
  }
}

// Redémarrage du PC demandé depuis le portail (Écrans > Redémarrer). Windows
// uniquement : "shutdown /r" ne demande pas de droits administrateur pour
// l'utilisateur connecté. Au redémarrage, la tâche planifiée relance le player
// (ouverture de session automatique requise, cf. install-windows.ps1).
let redemarrageEnCours = false;

function redemarrerPC() {
  if (redemarrageEnCours) return;
  if (config.plateforme !== 'windows') {
    logger.warn(`Redémarrage à distance non pris en charge sur cette plateforme (${config.plateforme}) — ignoré`);
    return;
  }
  redemarrageEnCours = true;
  logger.warn('Redémarrage du PC dans 10 secondes…');
  const proc = spawn('shutdown', ['/r', '/t', '10', '/f', '/c', 'Redémarrage demandé depuis le portail Spotlook'], {
    stdio: 'ignore', windowsHide: true,
  });
  proc.on('error', (err) => {
    redemarrageEnCours = false;
    logger.error(`Échec du redémarrage : ${err.message}`);
  });
  proc.on('exit', (code) => {
    if (code !== 0) {
      redemarrageEnCours = false;
      logger.error(`Échec du redémarrage : shutdown a retourné le code ${code}`);
    }
  });
}

function demarrerRetry() {
  if (timerRetry) return;
  logger.info(`Reconnexion automatique toutes les ${config.reconnectIntervalMs / 1000}s`);
  timerRetry = setInterval(async () => {
    logger.info('Tentative de reconnexion au serveur…');
    await synchroniser();
    if (serveurJoignable) relancerBoucle();
  }, config.reconnectIntervalMs);
}

function arreterRetry() {
  if (timerRetry) {
    clearInterval(timerRetry);
    timerRetry = null;
  }
}

function relancerBoucle() {
  if (timerItem) clearTimeout(timerItem);
  indexActuel = 0;
  diffuserProchain();
}

function diffuserProchain() {
  if (enVeilleActuel) {
    display.afficherVeille();
    contenuActuel = null;
    timerItem = setTimeout(diffuserProchain, DELAI_ATTENTE_MS);
    return;
  }

  // Seuls les médias entièrement téléchargés sont diffusés ; ceux en cours de
  // téléchargement s'ajoutent à la rotation dès qu'ils sont prêts.
  const diffusables = itemsActifs.filter(sync.estDiffusable);
  if (!diffusables.length) {
    if (itemsActifs.length) logger.debug('Médias du planning en cours de téléchargement — écran d\'attente');
    display.afficherEcranAttente();
    timerItem = setTimeout(diffuserProchain, DELAI_ATTENTE_MS);
    return;
  }

  const item = diffusables[indexActuel % diffusables.length];
  contenuActuel = { scheduleId: item.scheduleId, mediaId: item.media?.id };

  logger.info(`Diffusion : ${item.media?.filename} — durée ${item.dureeS}s`);

  try { display.afficherMedia(item); }
  catch (err) { logger.error(`Erreur affichage : ${err.message}`); }

  indexActuel = (indexActuel + 1) % diffusables.length;
  timerItem = setTimeout(diffuserProchain, item.dureeS * 1000);
}

async function envoyerHeartbeat() {
  await sync.envoyerHeartbeat('online', contenuActuel, sync.etatContenus(itemsActifs));
}

process.on('SIGINT',  arreter);
process.on('SIGTERM', arreter);

function arreter() {
  logger.info('Arrêt du player…');
  if (timerItem) clearTimeout(timerItem);
  ws.deconnecter();
  display.tuerProcessusActuel();
  sync.envoyerHeartbeat('offline').finally(() => process.exit(0));
}

demarrer().catch((err) => {
  logger.error(`Erreur fatale : ${err.message}`);
  process.exit(1);
});
