'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { toCZML, czmlDocumentPacket }              = require('./czml');
const { EntityStore }                              = require('./store');
const { buildPosPacket, estimateVelocity,
        velocityToHPR, FGMPSender }               = require('./fgmp');

// ── Config (env vars) ─────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT     || '8080', 10);
const MODELS    = process.env.MODELS_DIR || path.join(__dirname, '3d');
const PUBLIC    = path.join(__dirname, 'public');

// FlightGear MP — set FG_HOST to enable; leave unset to disable
const FG_HOST   = process.env.FG_HOST   || null;
const FG_PORT   = parseInt(process.env.FG_PORT   || '5000', 10);
const FG_HZ     = parseFloat(process.env.FG_HZ   || '1');   // send rate (packets/sec)

// ── FG model map: callsign-prefix → FG aircraft path ────────────────────────
// Override by setting FG_MODEL_MAP env var to a JSON file path.
let FG_MODEL_MAP = {
  A318: 'Aircraft/A320neo/A320neo.xml',
  A319: 'Aircraft/A320neo/A320neo.xml',
  A320: 'Aircraft/A320neo/A320neo.xml',
  A321: 'Aircraft/A320neo/A320neo.xml',
  A332: 'Aircraft/A330/A330-200.xml',
  A333: 'Aircraft/A330/A330-300.xml',
  A359: 'Aircraft/A350/A350-900.xml',
  B735: 'Aircraft/737-800/737-800.xml',
  B737: 'Aircraft/737-800/737-800.xml',
  B738: 'Aircraft/737-800/737-800.xml',
  B744: 'Aircraft/747-400/747-400.xml',
  B77W: 'Aircraft/777/777-300ER.xml',
  B788: 'Aircraft/787-8/787-8.xml',
  B789: 'Aircraft/787-8/787-8.xml',
  C172: 'Aircraft/c172p/c172p.xml',
  _default: 'Aircraft/ufo/ufo.xml',
};
if (process.env.FG_MODEL_MAP) {
  try {
    Object.assign(FG_MODEL_MAP, JSON.parse(fs.readFileSync(process.env.FG_MODEL_MAP, 'utf8')));
    console.log('[fg] loaded model map from', process.env.FG_MODEL_MAP);
  } catch (e) {
    console.warn('[fg] could not load FG_MODEL_MAP:', e.message);
  }
}

function resolveFGModel(name, czmlModelHint) {
  const upper = name.toUpperCase();
  for (const [prefix, model] of Object.entries(FG_MODEL_MAP)) {
    if (!prefix.startsWith('_') && upper.startsWith(prefix)) return model;
  }
  if (czmlModelHint) {
    const stem = path.basename(czmlModelHint, path.extname(czmlModelHint)).toUpperCase();
    for (const [prefix, model] of Object.entries(FG_MODEL_MAP)) {
      if (!prefix.startsWith('_') && stem.includes(prefix)) return model;
    }
  }
  return FG_MODEL_MAP._default;
}

// ── State ─────────────────────────────────────────────────────────────────────
const store   = new EntityStore();
const clients = new Set();   // WebSocket browser clients

// Per-entity FG metadata (only allocated when FG is enabled)
// Map<entityId, { model: string, lastSent: number }>
const fgMeta  = new Map();

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.glb':  'model/gltf-binary',
  '.geojson': 'application/geo+json',
};

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/item') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        if (!item.name) { res.writeHead(400); res.end('{"error":"name required"}'); return; }
        store.upsert(item);
        broadcastCZML(item);
        if (fgSender) scheduleFG(item);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/item/')) {
    const id = decodeURIComponent(url.pathname.slice(6));
    store.remove(id);
    fgMeta.delete(id);
    broadcast({ command: 'czml', id, delete: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/items') {
    store.clear();
    fgMeta.clear();
    broadcast({ command: 'removeAllCZMLEntities' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store.all()));
    return;
  }

  if (url.pathname.startsWith('/3d/')) {
    serveFile(res, path.join(MODELS, url.pathname.slice(4))); return;
  }

  serveFile(res, path.join(PUBLIC, url.pathname === '/' ? 'map3d.html' : url.pathname));
});

function serveFile(res, filePath) {
  const safe = path.resolve(filePath);
  if (!safe.startsWith(path.resolve(PUBLIC)) && !safe.startsWith(path.resolve(MODELS))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(safe, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── WebSocket (browser ↔ Cesium) ──────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ command: 'czml', ...czmlDocumentPacket() }));
  for (const item of store.all()) {
    const pkt = toCZML(item);
    if (pkt) ws.send(JSON.stringify({ command: 'czml', ...pkt }));
  }
  ws.on('message', raw => {
    try { const ev = JSON.parse(raw); onBrowserEvent(ev); } catch (_) {}
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}
function broadcastCZML(item) {
  const pkt = toCZML(item);
  if (pkt) broadcast({ command: 'czml', ...pkt });
}
function onBrowserEvent(ev) {
  // Forward clock events, selection etc. — extend as needed
  if (ev.event === 'clock') {/* could drive FG time here */}
}

// ── FlightGear MP output ──────────────────────────────────────────────────────
const fgSender = FG_HOST ? new FGMPSender(FG_HOST, FG_PORT) : null;
const FG_INTERVAL_MS = fgSender ? Math.round(1000 / FG_HZ) : Infinity;

/** Send one entity to FG right now. */
function sendToFG(item) {
  if (!fgSender || !item || item.fixedPosition) return;
  if (!item.lat && !item.lon) return;   // no position yet

  // Ensure per-entity FG metadata exists
  if (!fgMeta.has(item.name)) {
    const model = resolveFGModel(item.name, item.model || '');
    fgMeta.set(item.name, { model, lastSent: 0 });
    console.log(`[fg] new entity "${item.name}" → ${model}`);
  }
  const meta = fgMeta.get(item.name);

  // Velocity from track history
  const track = item._autoTrack || [];
  const [vx, vy, vz] = estimateVelocity(track);
  const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);

  // Heading/pitch: explicit or derived from velocity
  let hdg   = item.heading || 0;
  let pitch = item.pitch   || 0;
  if (!item.useHeadingPitchRoll && speed >= 1) {
    [hdg, pitch] = velocityToHPR(vx, vy, vz, item.lat, item.lon);
  }

  const pkt = buildPosPacket({
    callsign: item.name.slice(0, 7),
    model:    meta.model,
    lat:  item.lat,
    lon:  item.lon,
    altM: item.alt || 0,
    hdg, pitch, roll: item.roll || 0,
    vel: [vx, vy, vz],
  });

  fgSender.send(pkt);
  meta.lastSent = Date.now();
}

/** Called on every POST /item — rate-limits FG send per entity. */
function scheduleFG(item) {
  const meta = fgMeta.get(item.name);
  const now  = Date.now();
  if (!meta || now - meta.lastSent >= FG_INTERVAL_MS) {
    sendToFG(item);
  }
}

/** Periodic heartbeat — re-sends all entities at FG_HZ even if no new data. */
if (fgSender) {
  setInterval(() => {
    const now = Date.now();
    for (const item of store.all()) {
      if (item.fixedPosition) continue;
      const meta = fgMeta.get(item.name);
      if (!meta || now - meta.lastSent >= FG_INTERVAL_MS) {
        sendToFG(item);
      }
    }
  }, FG_INTERVAL_MS).unref();
}

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`aerolink  http://localhost:${PORT}`);
  if (fgSender) {
    console.log(`FlightGear MP out  udp://${FG_HOST}:${FG_PORT}  @ ${FG_HZ} Hz`);
  } else {
    console.log('FlightGear MP out  disabled (set FG_HOST to enable)');
  }
});
