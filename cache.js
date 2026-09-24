const fs   = require('fs');
const path = require('path');
const config = require('./config');

const FICHIER_SCHEDULE = path.join(config.cacheDir, 'schedule.json');
const DOSSIER_MEDIAS   = path.join(config.cacheDir, 'media');
const TTL_SCHEDULE_MS  = 24 * 3600 * 1000; // 24h

function initialiser() {
  fs.mkdirSync(config.cacheDir,  { recursive: true });
  fs.mkdirSync(DOSSIER_MEDIAS,   { recursive: true });
}

// ── Schedule ─────────────────────────────────────────────

function sauvegarderSchedule(data) {
  fs.writeFileSync(FICHIER_SCHEDULE, JSON.stringify({ ...data, _cachedAt: Date.now() }, null, 2));
}

function chargerSchedule() {
  try {
    const contenu = fs.readFileSync(FICHIER_SCHEDULE, 'utf8');
    return JSON.parse(contenu);
  } catch {
    return null;
  }
}

function scheduleValide() {
  const s = chargerSchedule();
  if (!s || !s._cachedAt) return false;
  return (Date.now() - s._cachedAt) < TTL_SCHEDULE_MS;
}

// ── Médias ───────────────────────────────────────────────

function cheminMedia(filename) {
  return path.join(DOSSIER_MEDIAS, filename);
}

function mediaExiste(filename) {
  try {
    fs.accessSync(cheminMedia(filename));
    return true;
  } catch {
    return false;
  }
}

// Téléchargement en cours : écrit dans "<fichier>.part", renommé seulement une
// fois complet — un fichier présent sous son vrai nom est donc toujours entier
// (même après une coupure réseau ou de courant en plein téléchargement).
const SUFFIXE_PARTIEL = '.part';

function cheminPartiel(filename) {
  return cheminMedia(filename) + SUFFIXE_PARTIEL;
}

// Octets déjà reçus lors d'une tentative précédente (0 si aucune).
function taillePartielle(filename) {
  try {
    return fs.statSync(cheminPartiel(filename)).size;
  } catch {
    return 0;
  }
}

function supprimerPartiel(filename) {
  fs.rmSync(cheminPartiel(filename), { force: true });
}

function finaliserMedia(filename) {
  fs.rmSync(cheminMedia(filename), { force: true });
  fs.renameSync(cheminPartiel(filename), cheminMedia(filename));
}

function listerMediasCaches() {
  try {
    return fs.readdirSync(DOSSIER_MEDIAS);
  } catch {
    return [];
  }
}

function nettoyerMediasObsoletes(filenamesActifs) {
  const actifs = new Set(filenamesActifs);
  const caches = listerMediasCaches();
  let nb = 0;
  for (const f of caches) {
    // Un ".part" d'un média toujours planifié est conservé : le téléchargement
    // reprendra là où il s'était arrêté.
    const nomComplet = f.endsWith(SUFFIXE_PARTIEL) ? f.slice(0, -SUFFIXE_PARTIEL.length) : f;
    if (!actifs.has(nomComplet)) {
      try { fs.unlinkSync(cheminMedia(f)); nb++; } catch { /* ignore */ }
    }
  }
  return nb;
}

module.exports = {
  initialiser,
  sauvegarderSchedule, chargerSchedule, scheduleValide,
  cheminMedia, mediaExiste,
  cheminPartiel, taillePartielle, supprimerPartiel, finaliserMedia,
  listerMediasCaches, nettoyerMediasObsoletes,
};
