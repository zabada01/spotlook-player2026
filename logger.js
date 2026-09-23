const config = require('./config');
const NIVEAUX = { debug: 0, info: 1, warn: 2, error: 3 };
const niveau = NIVEAUX[config.logLevel] ?? 1;

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
  console.log(`[${ts}] ${tag} ${msg}`);
}

module.exports = {
  debug: (m) => log('debug', m),
  info:  (m) => log('info',  m),
  warn:  (m) => log('warn',  m),
  error: (m) => log('error', m),
};
