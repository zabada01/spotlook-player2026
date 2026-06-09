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

function sauvegarderMedia(filename, buffer) {
  fs.writeFileSync(cheminMedia(filename), buffer);
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
    if (!actifs.has(f)) {
      try { fs.unlinkSync(cheminMedia(f)); nb++; } catch { /* ignore */ }
    }
  }
  return nb;
}

module.exports = {
  initialiser,
  sauvegarderSchedule, chargerSchedule, scheduleValide,
  cheminMedia, mediaExiste, sauvegarderMedia,
  listerMediasCaches, nettoyerMediasObsoletes,
};
