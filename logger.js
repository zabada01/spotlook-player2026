const config = require('./config');
const NIVEAUX = { debug: 0, info: 1, warn: 2, error: 3 };
const niveau = NIVEAUX[config.logLevel] ?? 1;

function log(lvl, msg) {
  if (NIVEAUX[lvl] < niveau) return;
  const ts  = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = lvl.toUpperCase().padEnd(5);
  console.log(`[${ts}] ${tag} ${msg}`);
}

module.exports = {
  debug: (m) => log('debug', m),
  info:  (m) => log('info',  m),
  warn:  (m) => log('warn',  m),
  error: (m) => log('error', m),
};
