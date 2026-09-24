const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const { pipeline } = require('stream');
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

// Pas de durée maximale pour un téléchargement (grosses vidéos sur réseau lent) :
// on abandonne seulement si plus aucune donnée n'arrive pendant ce délai.
const DELAI_INACTIVITE_MS  = 120_000;
const INTERVALLE_PROGRES_MS = 60_000;

const enMo = (octets) => `${(octets / 1024 / 1024).toFixed(1)} Mo`;

// Taille totale du fichier : "Content-Range: bytes 1000-4999/5000" en reprise
// (206), sinon Content-Length (200). null si le serveur ne l'indique pas.
function tailleTotale(res) {
  const plage = /\/(\d+)$/.exec(res.headers['content-range'] || '');
  if (plage) return Number(plage[1]);
  const longueur = Number(res.headers['content-length']);
  return Number.isFinite(longueur) && longueur > 0 ? longueur : null;
}

// Télécharge un média dans "<fichier>.part" puis le renomme une fois complet.
// Si une tentative précédente a été interrompue, reprend là où elle s'était
// arrêtée (requête Range). Rejette sur toute coupure — la partie déjà reçue est
// conservée pour la prochaine tentative.
function telechargerMedia(mediaId, filename, onProgres = () => {}) {
  return new Promise((resolve, reject) => {
    const url = `${config.serverUrl}/api/player/media/${mediaId}`;
    const lib = url.startsWith('https') ? https : http;
    const dejaRecu = cache.taillePartielle(filename);

    const headers = { 'X-Screen-Token': config.screenToken };
    if (dejaRecu > 0) headers.Range = `bytes=${dejaRecu}-`;

    const req = lib.request(url, { headers }, (res) => {
      if (res.statusCode === 416) {
        // Partie locale incohérente avec le fichier du serveur : on repartira de zéro.
        res.resume();
        cache.supprimerPartiel(filename);
        return reject(new Error(`Reprise impossible pour ${filename} — nouveau téléchargement au prochain essai`));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} pour média ${mediaId}`));
      }

      // 206 = le serveur reprend à la position demandée ; 200 = fichier complet
      // depuis le début (on écrase alors l'éventuelle partie existante).
      const reprise = res.statusCode === 206;
      const debut = reprise ? dejaRecu : 0;
      const total = tailleTotale(res);
      let recu = debut;
      let dernierProgres = Date.now();

      if (reprise) logger.info(`Reprise du téléchargement ${filename} à ${enMo(debut)}${total ? ` / ${enMo(total)}` : ''}`);
      onProgres(recu, total);

      res.on('data', (morceau) => {
        recu += morceau.length;
        onProgres(recu, total);
        if (Date.now() - dernierProgres >= INTERVALLE_PROGRES_MS) {
          dernierProgres = Date.now();
          const pourcent = total ? ` (${Math.floor((recu / total) * 100)} %)` : '';
          logger.info(`Téléchargement ${filename} : ${enMo(recu)}${total ? ` / ${enMo(total)}` : ''}${pourcent}`);
        }
      });

      const fichier = fs.createWriteStream(cache.cheminPartiel(filename), { flags: reprise ? 'a' : 'w' });
      pipeline(res, fichier, (err) => {
        if (err) {
          return reject(new Error(`Téléchargement de ${filename} interrompu à ${enMo(recu)} (${err.message}) — reprise au prochain essai`));
        }
        if (total && recu !== total) {
          return reject(new Error(`Téléchargement de ${filename} incomplet (${enMo(recu)} / ${enMo(total)}) — reprise au prochain essai`));
        }
        try {
          cache.finaliserMedia(filename);
        } catch (e) {
          return reject(new Error(`Impossible de finaliser ${filename} : ${e.message}`));
        }
        logger.info(`Média téléchargé : ${filename} (${enMo(recu)})`);
        resolve();
      });
    });

    req.setTimeout(DELAI_INACTIVITE_MS, () => {
      req.destroy(new Error(`aucune donnée reçue depuis ${DELAI_INACTIVITE_MS / 1000}s`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function envoyerHeartbeat(status = 'online', contenuActuel = null, contenus = undefined) {
  try {
    await requete(`${config.serverUrl}/api/player/heartbeat`, {
      method: 'POST',
      body: { status, contenuActuel, contenus, playerVersion: config.playerVersion },
    });
    logger.debug(`Heartbeat : ${status}`);
  } catch (err) {
    logger.warn(`Heartbeat échoué : ${err.message}`);
  }
}

// Seuls image/video correspondent à un fichier réellement stocké côté serveur —
// url/text ne sont que du texte/lien en base, rien à télécharger.
const TYPES_TELECHARGEABLES = new Set(['image', 'video']);

// Un item est diffusable si son média ne nécessite pas de fichier, ou si ce
// fichier est entièrement présent dans le cache.
function estDiffusable(item) {
  return !TYPES_TELECHARGEABLES.has(item.media?.type) || cache.mediaExiste(item.media.filename);
}

let telechargementsEnCours = false;
let itemsEnAttente = null;

// État remonté au portail (colonne "Contenus" de la vue Écrans) à chaque heartbeat
let telechargementActuel = null;   // { filename, recu, total }
const echecs = new Set();          // filenames dont le dernier essai a échoué

// Télécharge en arrière-plan les médias manquants, un par un. Ne bloque pas la
// synchronisation du planning (une grosse vidéo sur réseau lent peut prendre
// des heures) : les items deviennent diffusables au fil des téléchargements.
// Un appel pendant qu'un lot est en cours est mémorisé et traité ensuite.
function lancerTelechargements(items) {
  itemsEnAttente = items;
  if (telechargementsEnCours) return;

  telechargementsEnCours = true;
  (async () => {
    try {
      while (itemsEnAttente) {
        const lot = itemsEnAttente;
        itemsEnAttente = null;
        await telechargerLot(lot);
      }
    } finally {
      telechargementsEnCours = false;
    }
  })().catch((err) => logger.error(`Erreur téléchargements : ${err.message}`));
}

async function telechargerLot(items) {
  const itemsFichiers = items.filter((i) => TYPES_TELECHARGEABLES.has(i.media?.type));

  const filenamesActifs = itemsFichiers.map((i) => i.media.filename);
  const nbNettoyes = cache.nettoyerMediasObsoletes(filenamesActifs);
  if (nbNettoyes > 0) logger.info(`Cache nettoyé : ${nbNettoyes} média(s) obsolète(s)`);

  const manquants = [...new Map(
    itemsFichiers.filter((i) => !cache.mediaExiste(i.media.filename)).map((i) => [i.media.filename, i.media])
  ).values()];
  if (!manquants.length) return;

  logger.info(`${manquants.length} média(s) à télécharger`);
  let nbEchecs = 0;
  for (const { id, filename } of manquants) {
    logger.info(`Téléchargement : ${filename}`);
    telechargementActuel = { filename, recu: 0, total: null };
    try {
      await telechargerMedia(id, filename, (recu, total) => { telechargementActuel = { filename, recu, total }; });
      echecs.delete(filename);
    } catch (err) {
      // On continue avec les autres : celui-ci sera retenté à la prochaine synchronisation.
      nbEchecs++;
      echecs.add(filename);
      logger.warn(err.message);
    } finally {
      telechargementActuel = null;
    }
  }
  if (nbEchecs) logger.warn(`${nbEchecs} média(s) non téléchargé(s) — nouvel essai à la prochaine synchronisation`);
}

// Bilan des médias à télécharger du planning en cours, pour le portail :
// { total, prets, enCours: { nom, pourcent } | null, echecs: [{ nom }] }.
function etatContenus(items) {
  const fichiers = [...new Map(
    items.filter((i) => TYPES_TELECHARGEABLES.has(i.media?.type)).map((i) => [i.media.filename, i.media])
  ).values()];
  const nom = (m) => String(m.nom || m.filename).slice(0, 255);
  const pret = (m) => cache.mediaExiste(m.filename);

  const actuel = telechargementActuel && fichiers.find((m) => m.filename === telechargementActuel.filename);
  const { recu, total } = telechargementActuel || {};
  return {
    total: fichiers.length,
    prets: fichiers.filter(pret).length,
    enCours: actuel ? { nom: nom(actuel), pourcent: total ? Math.min(100, Math.floor((recu / total) * 100)) : null } : null,
    echecs: fichiers
      .filter((m) => !pret(m) && echecs.has(m.filename) && m !== actuel)
      .slice(0, 50)
      .map((m) => ({ nom: nom(m) })),
  };
}

module.exports = { obtenirSchedule, telechargerMedia, envoyerHeartbeat, lancerTelechargements, estDiffusable, etatContenus };
