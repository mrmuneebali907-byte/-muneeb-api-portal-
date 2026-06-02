/**
 * WhatsApp MD Bot - Main Entry Point
 */
// ── Pakistan Standard Time (UTC+5) — set BEFORE any Date/moment call ─────────
process.env.TZ = 'Asia/Karachi';

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || '/tmp/puppeteer_cache_disabled';

const { initializeTempSystem } = require('./utils/tempManager');
const { startCleanup } = require('./utils/cleanup');
initializeTempSystem();
startCleanup();
require('./alive.js');
const originalConsoleLog   = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn  = console.warn;
const originalConsoleInfo  = console.info;

const forbiddenPatternsConsole = [
  'closing session',
  'closing open session',
  'sessionentry',
  'prekey bundle',
  'pendingprekey',
  '_chains',
  'registrationid',
  'currentratchet',
  'chainkey',
  'ratchet',
  'signal protocol',
  'ephemeralkeypair',
  'indexinfo',
  'basekey',
  'remoteidentitykey',
  'rootkey'
];

// Cheap stringify (cap arg length so giant SessionEntry dumps don't burn CPU)
function _safeJoin(args) {
  let out = '';
  for (let i = 0; i < args.length && out.length < 4000; i++) {
    const a = args[i];
    out += ' ' + (typeof a === 'string' ? a : typeof a === 'object' ? Object.keys(a || {}).join(',') : String(a));
  }
  return out.toLowerCase();
}
function _filtered(orig) {
  return (...args) => {
    const message = _safeJoin(args);
    if (!forbiddenPatternsConsole.some(p => message.includes(p))) orig.apply(console, args);
  };
}
console.log   = _filtered(originalConsoleLog);
console.error = _filtered(originalConsoleError);
console.warn  = _filtered(originalConsoleWarn);
console.info  = _filtered(originalConsoleInfo); // libsignal logs SessionEntry dumps via console.info — block them

// Core dependencies only (heavy Baileys imports removed — managed by sessionManager)
const config = require('./config');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const os     = require('os');

// Remove Puppeteer cache bloat
function cleanupPuppeteerCache() {
  try {
    const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log('🧹 Puppeteer cache removed');
    }
  } catch (err) {
    console.error('⚠️ Failed to cleanup Puppeteer cache:', err.message);
  }
}

// Shared in-memory message store (lightweight — 20 msgs per chat max)
const store = {
  messages: new Map(),
  maxPerChat: 20,
  bind: (ev) => {
    ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;
        const jid = msg.key.remoteJid;
        if (!store.messages.has(jid)) store.messages.set(jid, new Map());
        const chat = store.messages.get(jid);
        chat.set(msg.key.id, msg);
        if (chat.size > store.maxPerChat) chat.delete(chat.keys().next().value);
      }
    });
  },
  loadMessage: async (jid, id) => store.messages.get(jid)?.get(id) || null
};

// NOTE: startBot() was removed — all session management is handled by
// panel/sessionManager.js (multi-session architecture). This file only
// boots the panel server and sets up process-level safety handlers.
// Startup
console.log('🚀 Starting WhatsApp MD Bot Panel...\n');
console.log(`📦 Bot Name: ${config.botName}`);
console.log(`⚡ Prefix: ${config.prefix}`);
const ownerNames = Array.isArray(config.ownerName) ? config.ownerName.join(',') : config.ownerName;
console.log(`👑 Owner: ${ownerNames}\n`);

// Proactively delete Puppeteer cache so it doesn't fill disk on panels
cleanupPuppeteerCache();

// ── Start the Web Panel (manages all WhatsApp sessions) ──────────────────────
const { startPanelServer } = require('./panel/server');
startPanelServer();

// ── If SESSION_ID env is set and no sessions exist yet, bootstrap session 1 ──
const sessionManager = require('./panel/sessionManager');
if (config.sessionID && config.sessionID.startsWith('MrMuneebAliBot!')) {
  const existingSessions = sessionManager.getSessions();
  if (existingSessions.length === 0) {
    try {
      console.log('📡 SESSION_ID detected - bootstrapping Session 1...');
      const session = sessionManager.createSession('Session 1', config.ownerNumber[0]);

      const [header, b64data] = config.sessionID.split('!');
      if (b64data) {
        const zlib = require('zlib');
        const fs = require('fs');
        const path = require('path');
        const cleanB64 = b64data.replace('...', '');
        const compressedData = Buffer.from(cleanB64, 'base64');
        const decompressedData = zlib.gunzipSync(compressedData);
        const sessionFile = path.join(session.sessionPath, 'creds.json');
        fs.writeFileSync(sessionFile, decompressedData, 'utf8');
        console.log('✅ Session credentials restored from SESSION_ID');
      }
    } catch (e) {
      console.error('⚠️ Error bootstrapping session from SESSION_ID:', e.message);
    }
  }
}

// ── Heartbeat file — written every 30 s so startup.js can detect frozen bot ──
// If the bot freezes (event loop blocked), this file stops being updated and
// the watchdog kills + restarts the child process automatically.
const HEARTBEAT_FILE = path.join(__dirname, 'tmp', '.bot-heartbeat');
try { if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true }); } catch (_) {}
setInterval(() => {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (_) {}
}, 30_000);

// ── Self-ping — keeps Replit/VPS container awake every 4 minutes ─────────────
// Free-tier hosts sleep the process after inactivity. This ping to our own
// HTTP server keeps the event loop active and the container alive.
const _http = require('http');
const SELF_PING_PORT = parseInt(process.env.PORT || '5000', 10);
setInterval(() => {
  const req = _http.get(
    { hostname: '127.0.0.1', port: SELF_PING_PORT, path: '/api/status', timeout: 8000 },
    (res) => res.resume()
  );
  req.on('error', () => {}); // ignore — if server is down, watchdog handles it
  req.end();
}, 4 * 60 * 1000).unref?.();

// ── Memory watchdog ──────────────────────────────────────────────────────────
// Self-restart (exit 42 → fast relaunch via startup.js) if RSS grows too large.
// Prevents OOM kills on free-tier hosting which would otherwise look like
// "bot dies after a few minutes".
const MEM_LIMIT_MB      = parseInt(process.env.MEM_LIMIT_MB     || '900', 10);
const MEM_GC_TRIGGER_MB = parseInt(process.env.MEM_GC_TRIGGER_MB || '650', 10);
const MEM_CHECK_EVERY_MS = 60_000;

setInterval(() => {
  try {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMB >= MEM_LIMIT_MB) {
      console.warn(`[MEM-WATCHDOG] RSS ${rssMB}MB ≥ limit ${MEM_LIMIT_MB}MB — self-restart (exit 42)`);
      setTimeout(() => process.exit(42), 500);
      return;
    }
    if (rssMB >= MEM_GC_TRIGGER_MB) {
      try { if (typeof store !== 'undefined' && store.messages?.size > 200) store.messages.clear(); } catch (_) {}
      if (typeof global.gc === 'function') {
        global.gc();
        const after = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[MEM-WATCHDOG] gc: ${rssMB}MB → ${after}MB`);
      }
    }
  } catch (_) {}
}, MEM_CHECK_EVERY_MS).unref?.();

// ── Process-level safety net ─────────────────────────────────────────────────
const { cleanupOldFiles } = require('./utils/cleanup');

process.on('uncaughtException', (err) => {
  if (err.code === 'ENOSPC' || err.errno === -28 || err.message?.includes('no space left on device')) {
    console.error('[PROC] ENOSPC — cleaning temp files and continuing');
    try { cleanupOldFiles(); } catch (_) {}
    return; // don't crash on disk-full
  }
  // Log but NEVER crash the process — the bot must keep running
  console.error('[PROC] uncaughtException (non-fatal):', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason || '');
  if (msg.includes('no space left') || reason?.code === 'ENOSPC') {
    console.error('[PROC] ENOSPC in promise — cleaning and continuing');
    try { cleanupOldFiles(); } catch (_) {}
    return;
  }
  if (msg.includes('rate-overlimit')) {
    console.warn('[PROC] rate-overlimit hit — slow down requests');
    return;
  }
  // Log and continue — never let a rejected promise kill the process
  console.error('[PROC] unhandledRejection (non-fatal):', msg);
});

// SIGTERM from OS or host → exit 42 so startup.js does a FAST restart
// (not exit 0, which previously told the watchdog "clean stop, don't restart")
process.on('SIGTERM', () => {
  console.log('[PROC] SIGTERM received — fast-restart via watchdog (exit 42)');
  setTimeout(() => process.exit(42), 300);
});
// Export store for use in commands
module.exports = { store };