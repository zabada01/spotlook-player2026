const fs     = require('fs');
const path   = require('path');
const config = require('./config');
const NIVEAUX = { debug: 0, info: 1, warn: 2, error: 3 };
const niveau = NIVEAUX[config.logLevel] ?? 1;

// Fichier de log avec découpage automatique : au-delà de LOG_MAX_MO, player.log
// devient player.log.1 (le .1 devient .2, etc.) et on garde LOG_NB_ARCHIVES
// archives au plus — le log n'occupe jamais plus de (1 + archives) x LOG_MAX_MO.
const FICHIER_LOG  = path.join(__dirname, 'player.log');
const TAILLE_MAX   = (parseFloat(process.env.LOG_MAX_MO) || 10) * 1024 * 1024;
const NB_ARCHIVES  = parseInt(process.env.LOG_NB_ARCHIVES) || 5;
// Lancé à la main dans une console : les lignes s'affichent aussi à l'écran.
// Lancé par demarrer-boucle.bat (sortie redirigée) : fichier seul, pour ne pas
// les dupliquer dans player-crash.log.
const AFFICHER_CONSOLE = Boolean(process.stdout.isTTY);

let tailleActuelle = null;

function decouper() {
  for (let i = NB_ARCHIVES - 1; i >= 1; i--) {
    try { fs.renameSync(`${FICHIER_LOG}.${i}`, `${FICHIER_LOG}.${i + 1}`); } catch { /* archive absente */ }
  }
  fs.renameSync(FICHIER_LOG, `${FICHIER_LOG}.1`);
  tailleActuelle = 0;
}

function ecrireFichier(ligne) {
  try {
    if (tailleActuelle === null) {
      try { tailleActuelle = fs.statSync(FICHIER_LOG).size; } catch { tailleActuelle = 0; }
    }
    if (tailleActuelle >= TAILLE_MAX) decouper();
    fs.appendFileSync(FICHIER_LOG, ligne + '\n');
    tailleActuelle += Buffer.byteLength(ligne) + 1;
  } catch {
    // Disque plein, fichier verrouillé… : on ne bloque jamais la diffusion pour un log.
    tailleActuelle = null;
  }
}

// Horodatage en heure locale de la machine ("YYYY-MM-DD HH:MM:SS") — toISOString()
// donnait de l'UTC, soit 1 à 2h de décalage apparent avec l'horloge Windows.
function horodatageLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(lvl, msg) {
  if (NIVEAUX[lvl] < niveau) return;
  const ts  = horodatageLocal();
  const tag = lvl.toUpperCase().padEnd(5);
  const ligne = `[${ts}] ${tag} ${msg}`;
  ecrireFichier(ligne);
  if (AFFICHER_CONSOLE) console.log(ligne);
}

module.exports = {
  debug: (m) => log('debug', m),
  info:  (m) => log('info',  m),
  warn:  (m) => log('warn',  m),
  error: (m) => log('error', m),
};
