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
  logger.info('=== Spotlook Player démarré ===');
  cache.initialiser();
  display.initialiser();

  await synchroniser();

  ws.connecter(async () => {
    logger.info('Mise à jour WS reçue — re-synchronisation…');
    await synchroniser();
    relancerBoucle();
  });

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
    if (itemsActifs.length > 0) await sync.synchroniserMedias(itemsActifs);
  } catch (err) {
    logger.error(`Erreur synchronisation : ${err.message}`);
  } finally {
    syncEnCours = false;
  }
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

  if (!itemsActifs.length) {
    display.afficherEcranAttente();
    timerItem = setTimeout(diffuserProchain, DELAI_ATTENTE_MS);
    return;
  }

  const item = itemsActifs[indexActuel % itemsActifs.length];
  contenuActuel = { scheduleId: item.scheduleId, mediaId: item.media?.id };

  logger.info(`Diffusion : ${item.media?.filename} — durée ${item.dureeS}s`);

  try { display.afficherMedia(item); }
  catch (err) { logger.error(`Erreur affichage : ${err.message}`); }

  indexActuel = (indexActuel + 1) % itemsActifs.length;
  timerItem = setTimeout(diffuserProchain, item.dureeS * 1000);
}

async function envoyerHeartbeat() {
  await sync.envoyerHeartbeat('online', contenuActuel);
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
