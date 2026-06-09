const WebSocket = require('ws');
const config    = require('./config');
const logger    = require('./logger');

const DELAI_RECONNEXION_MS = 5_000;
const DELAI_MAX_MS         = 60_000;

let ws             = null;
let delaiActuel    = DELAI_RECONNEXION_MS;
let arreter        = false;
let onScheduleUpdate = null;

function connecter(onMiseAJour) {
  onScheduleUpdate = onMiseAJour;
  arreter = false;
  _connecter();
}

function _connecter() {
  if (arreter) return;

  const urlWs = config.serverUrl
    .replace(/^http/, 'ws')
    .concat(`/ws?token=${config.screenToken}`);

  logger.info(`WS — connexion à ${urlWs}`);
  ws = new WebSocket(urlWs);

  ws.on('open', () => {
    logger.info('WS — connecté');
    delaiActuel = DELAI_RECONNEXION_MS;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'schedule_updated':
          logger.info(`WS — schedule_updated : action=${msg.data?.action}`);
          if (typeof onScheduleUpdate === 'function') onScheduleUpdate(msg.data);
          break;
        case 'connecte':
          logger.info(`WS — écran reconnu : id=${msg.data?.ecranId}`);
          break;
        default:
          logger.debug(`WS — message inconnu : ${msg.type}`);
      }
    } catch {
      logger.warn('WS — message non-JSON ignoré');
    }
  });

  ws.on('close', (code, reason) => {
    logger.warn(`WS — déconnecté (code=${code}). Reconnexion dans ${delaiActuel / 1000}s…`);
    if (!arreter) setTimeout(_connecter, delaiActuel);
    delaiActuel = Math.min(delaiActuel * 2, DELAI_MAX_MS);
  });

  ws.on('error', (err) => {
    logger.warn(`WS — erreur : ${err.message}`);
  });
}

function deconnecter() {
  arreter = true;
  ws?.close();
}

module.exports = { connecter, deconnecter };
