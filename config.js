require('dotenv').config();
const os = require('os');
const { execFileSync } = require('child_process');
const { version: versionPackage } = require('./package.json');

// Version affichée dans le portail, calculée automatiquement depuis git (les
// players sont mis à jour par git pull) : majeur.mineur du package.json, et le
// dernier chiffre augmenté de 1 par commit modifiant le player depuis que ce
// numéro a été fixé. Ex. package.json 1.1.0 + 2 commits sur client-player -> 1.1.2.
// Pour une évolution majeure, changer le numéro du package.json (ex. 1.2.0) :
// le comptage repart de là.
function git(...args) {
  return execFileSync('git', args, {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
  }).toString().trim();
}

function versionPlayer() {
  try {
    // Dernier commit ayant modifié le numéro de version du package.json
    const base = git('log', '-1', '--format=%H', '-G"version"', '--', 'package.json');
    if (!base) return versionPackage;
    const nbCommits = Number(git('rev-list', '--count', `${base}..HEAD`, '--', '.'));
    const [majeur, mineur, correctif] = versionPackage.split('.').map(Number);
    return `${majeur}.${mineur}.${correctif + nbCommits}`;
  } catch {
    return versionPackage; // pas de git (copie du dossier sans dépôt) : numéro du package.json
  }
}

const playerVersion = versionPlayer();

function detecterPlateforme() {
  const env = (process.env.PLATFORM || 'auto').toLowerCase();
  if (env !== 'auto') return env;
  const plate = os.platform();
  if (plate === 'linux') {
    const cpuModel = os.cpus()[0]?.model || '';
    return cpuModel.toLowerCase().includes('arm') ? 'rpi' : 'linux';
  }
  if (plate === 'win32') return 'windows';
  return 'linux';
}

const plateforme = detecterPlateforme();

const CHEMINS_CHROMIUM = {
  rpi:     process.env.CHROMIUM_PATH || 'chromium-browser',
  linux:   process.env.CHROMIUM_PATH || 'google-chrome',
  windows: process.env.CHROMIUM_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

const CHEMINS_VLC = {
  rpi:     process.env.VLC_PATH || 'vlc',
  linux:   process.env.VLC_PATH || 'vlc',
  windows: process.env.VLC_PATH || 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
};

const config = {
  serverUrl:           (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, ''),
  screenToken:         process.env.SCREEN_TOKEN || '',
  playerVersion,
  cacheDir:            process.env.CACHE_DIR || '/cache/spotlook',
  plateforme,
  chromiumPath:        CHEMINS_CHROMIUM[plateforme],
  vlcPath:             CHEMINS_VLC[plateforme],
  logLevel:            process.env.LOG_LEVEL || 'info',
  chromiumDebugPort:   parseInt(process.env.CHROMIUM_DEBUG_PORT || '9333'),
  reconnectIntervalMs: parseInt(process.env.RECONNECT_INTERVAL_S || '60') * 1000,
  texte: {
    fond:       process.env.TEXT_BG_COLOR    || '#000000',
    couleur:    process.env.TEXT_COLOR       || '#ffffff',
    taillePx:   parseInt(process.env.TEXT_FONT_SIZE_PX || '64'),
  },
};

if (!config.screenToken) {
  console.error('[CONFIG] SCREEN_TOKEN est requis. Enregistrez cet écran via le portail admin.');
  process.exit(1);
}

module.exports = config;
