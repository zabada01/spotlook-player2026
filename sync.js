const https  = require('https');
const http   = require('http');
const config = require('./config');
const cache  = require('./cache');
const logger = require('./logger');

function requete(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method:  options.method || 'GET',
      headers: {
        'Content-Type':   'application/json',
        'X-Screen-Token': config.screenToken,
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (!body.success) reject(new Error(body.error || 'Erreur serveur'));
          else resolve(body.data);
        } catch (e) {
          reject(new Error(`Réponse invalide : ${e.message}`));
        }
      });
    });

    req.setTimeout(options.timeout || 15_000, () => {
      req.destroy();
      reject(new Error('Timeout réseau'));
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function obtenirSchedule() {
  const data = await requete(`${config.serverUrl}/api/player/schedule`);
  cache.sauvegarderSchedule(data);
  logger.info(`Planning synchronisé — ${data.items?.length ?? 0} item(s)`);
  return data;
}

async function telechargerMedia(mediaId, filename) {
  return new Promise((resolve, reject) => {
    const url = `${config.serverUrl}/api/player/media/${mediaId}`;
    const lib = url.startsWith('https') ? https : http;
    const chunks = [];

    const req = lib.request(url, {
      headers: { 'X-Screen-Token': config.screenToken },
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} pour média ${mediaId}`));
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        cache.sauvegarderMedia(filename, buffer);
        logger.debug(`Média téléchargé : ${filename} (${(buffer.length / 1024).toFixed(1)} Ko)`);
        resolve();
      });
    });

    req.setTimeout(120_000, () => { req.destroy(); reject(new Error(`Timeout téléchargement ${filename}`)); });
    req.on('error', reject);
    req.end();
  });
}

async function envoyerHeartbeat(status = 'online', contenuActuel = null) {
  try {
    await requete(`${config.serverUrl}/api/player/heartbeat`, {
      method: 'POST',
      body: { status, contenuActuel },
    });
    logger.debug(`Heartbeat : ${status}`);
  } catch (err) {
    logger.warn(`Heartbeat échoué : ${err.message}`);
  }
}

// Seuls image/video correspondent à un fichier réellement stocké côté serveur —
// url/text ne sont que du texte/lien en base, rien à télécharger.
const TYPES_TELECHARGEABLES = new Set(['image', 'video']);

async function synchroniserMedias(items) {
  const itemsFichiers = items.filter((i) => TYPES_TELECHARGEABLES.has(i.media.type));

  const filenamesActifs = itemsFichiers.map((i) => i.media.filename);
  const nbNettoyes = cache.nettoyerMediasObsoletes(filenamesActifs);
  if (nbNettoyes > 0) logger.info(`Cache nettoyé : ${nbNettoyes} média(s) obsolète(s)`);

  let nbTelecharges = 0;
  for (const item of itemsFichiers) {
    const { id, filename } = item.media;
    if (!cache.mediaExiste(filename)) {
      logger.info(`Téléchargement : ${filename}`);
      await telechargerMedia(id, filename);
      nbTelecharges++;
    }
  }

  if (nbTelecharges > 0) logger.info(`${nbTelecharges} média(s) téléchargé(s)`);
  return nbTelecharges;
}

module.exports = { obtenirSchedule, telechargerMedia, envoyerHeartbeat, synchroniserMedias };
