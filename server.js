// OSRS GE Helper - local server.
// Proxies the OSRS Wiki real-time prices API and the official hiscores (both block
// browser-side calls / require a User-Agent), caches responses, serves the UI, and
// persists your app state to data/state.json.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
// The wiki asks every client to send a descriptive User-Agent. Set OSRS_UA to add your
// own contact (e.g. a Discord handle) if you like.
const UA = process.env.OSRS_UA || 'osrs-ge-helper/1.0 (personal local GE trading tool)';
const PRICES = 'https://prices.runescape.wiki/api/v1/osrs';
const PUBLIC = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

// Cache lifetimes per endpoint (ms). The wiki updates latest ~every minute, 5m every 5 min.
const TTL = { latest: 30e3, '5m': 60e3, '1h': 5 * 60e3, '6h': 15 * 60e3, '24h': 15 * 60e3, mapping: 6 * 3600e3 };
const cache = new Map(); // key -> { time, body, pending }

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && hit.body && Date.now() - hit.time < ttl) return hit.body;
  if (hit && hit.pending) return hit.pending;
  const pending = fetcher()
    .then(body => { cache.set(key, { time: Date.now(), body }); return body; })
    .catch(err => {
      // Serve stale data rather than failing if we have any.
      if (hit && hit.body) { cache.set(key, hit); return hit.body; }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(hit || {}), pending });
  return pending;
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) { const e = new Error(`${res.status} from ${url}`); e.status = res.status; throw e; }
  return res.text();
}

const HISCORE_MODES = {
  normal: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  hardcore: 'hiscore_oldschool_hardcore_ironman',
  ultimate: 'hiscore_oldschool_ultimate',
};

async function hiscores(player) {
  const lookups = await Promise.all(Object.entries(HISCORE_MODES).map(async ([mode, m]) => {
    const url = `https://secure.runescape.com/m=${m}/index_lite.json?player=${encodeURIComponent(player)}`;
    try { return [mode, JSON.parse(await cached('hs:' + url, 10 * 60e3, () => getText(url)))]; }
    catch { return [mode, null]; }
  }));
  const found = Object.fromEntries(lookups);
  if (!found.normal) return null;
  // Iron accounts also appear on the main hiscores; the most specific board wins.
  const type = found.ultimate ? 'ultimate' : found.hardcore ? 'hardcore' : found.ironman ? 'ironman' : 'normal';
  return { ...found.normal, accountType: type };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) reject(new Error('Body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    let m;
    if ((m = p.match(/^\/api\/prices\/(latest|mapping|5m|1h|6h|24h)$/))) {
      const ep = m[1];
      return send(res, 200, await cached(ep, TTL[ep], () => getText(`${PRICES}/${ep}`)));
    }
    if (p === '/api/timeseries') {
      const id = parseInt(url.searchParams.get('id'), 10);
      const step = url.searchParams.get('timestep') || '5m';
      if (!id || !['5m', '1h', '6h', '24h'].includes(step)) return send(res, 400, '{"error":"bad params"}');
      const ttl = step === '5m' ? 60e3 : 5 * 60e3;
      return send(res, 200, await cached(`ts:${id}:${step}`, ttl, () => getText(`${PRICES}/timeseries?timestep=${step}&id=${id}`)));
    }
    if (p === '/api/hiscores') {
      const player = (url.searchParams.get('player') || '').trim();
      if (!player || player.length > 12) return send(res, 400, '{"error":"Enter a valid RuneScape name (max 12 chars)"}');
      const data = await hiscores(player);
      if (!data) return send(res, 404, '{"error":"Player not found on the hiscores"}');
      return send(res, 200, JSON.stringify(data));
    }
    if (p === '/api/state') {
      if (req.method === 'GET') {
        return fs.readFile(STATE_FILE, 'utf8', (err, data) => send(res, 200, err ? '{}' : data));
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body); // validate
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE + '.tmp', body);
        fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
        return send(res, 200, '{"ok":true}');
      }
    }
    if (p.startsWith('/api/')) return send(res, 404, '{"error":"unknown endpoint"}');
    serveStatic(req, res, decodeURIComponent(p));
  } catch (err) {
    console.error(err.message);
    send(res, err.status || 502, JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OSRS GE Helper running at http://localhost:${PORT}`);
});
