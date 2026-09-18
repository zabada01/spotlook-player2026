require('dotenv').config();
const os = require('os');
const { version: playerVersion } = require('./package.json');

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
