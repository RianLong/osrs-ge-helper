// Cloudflare Worker: looks up an OSRS player on the official hiscores for the hosted
// GE Helper site (the hiscores don't allow direct calls from web pages).
// Usage: GET https://<your-worker>.workers.dev/?player=NAME
// Returns the hiscores JSON plus accountType: normal | ironman | hardcore | ultimate.

const MODES = {
  normal: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  hardcore: 'hiscore_oldschool_hardcore_ironman',
  ultimate: 'hiscore_oldschool_ultimate',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });
}

async function lookup(mode, player) {
  const url = `https://secure.runescape.com/m=${MODES[mode]}/index_lite.json?player=${encodeURIComponent(player)}`;
  // Cache each board for 10 minutes at Cloudflare's edge so repeat lookups are instant.
  const res = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const player = (new URL(request.url).searchParams.get('player') || '').trim();
    if (!player || player.length > 12) return reply(400, { error: 'Enter a valid RuneScape name (max 12 chars)' });

    const entries = await Promise.all(Object.keys(MODES).map(async m => [m, await lookup(m, player)]));
    const found = Object.fromEntries(entries);
    if (!found.normal) return reply(404, { error: 'Player not found on the hiscores' });
    // Iron accounts also appear on the main hiscores; the most specific board wins.
    const accountType = found.ultimate ? 'ultimate' : found.hardcore ? 'hardcore' : found.ironman ? 'ironman' : 'normal';
    return reply(200, { ...found.normal, accountType });
  },
};
