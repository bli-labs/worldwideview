// =============================================================================
// aviation — live civilian air traffic from the OpenSky Network REST API.
//
// Local replacement for WWV's private cloud aviation seeder. Authenticates via
// OAuth2 client-credentials (tokens last 30 min, refreshed proactively) and
// polls /api/states/all every 2 minutes (4 credits/call ≈ 2,880/day, inside
// the 4,000/day authenticated allowance).
//
// PAYLOAD CONTRACT: the @worldwideview/wwv-plugin-aviation frontend bundle's
// mapWebsocketPayload() expects the BARE array of flight objects
// ({icao24, callsign, lat, lon, alt, hdg, spd, ...}) — NOT the usual
// {items: [...]} wrapper — so this seeder publishes the array directly via
// setLiveSnapshot (cron+fn shape; interval+fetch would auto-wrap and break it).
// =============================================================================

import { readFileSync } from 'fs';
import { setLiveSnapshot, fetchWithTimeout } from '@worldwideview/seeder-sdk';

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';
const TTL_SECONDS = 360; // ~3x the 2-minute cadence

interface Credentials { clientId: string; clientSecret: string }

function loadCredentials(): Credentials | null {
  // 1. credentials.json next to the package (gitignored via /local-seeders/)
  try {
    const raw = readFileSync(new URL('../credentials.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.clientId && parsed.clientSecret) return parsed;
  } catch { /* fall through */ }
  // 2. OPENSKY_CREDENTIALS env var ("clientId:clientSecret", first pair wins)
  const env = process.env.OPENSKY_CREDENTIALS;
  if (env) {
    const [clientId, clientSecret] = env.split(',')[0].split(':');
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return null;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(creds: Credentials): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OpenSky token endpoint returned ${res.status}`);
  const json = await res.json();
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000,
  };
  return cachedToken.token;
}

// OpenSky state vector indices — https://openskynetwork.github.io/opensky-api/rest.html
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
// 10 true_track, 11 vertical_rate, 13 geo_altitude, 14 squawk
type StateVector = [
  string, string | null, string, number | null, number,
  number | null, number | null, number | null, boolean, number | null,
  number | null, number | null, number[] | null, number | null, string | null,
  boolean, number,
];

export async function seedAviation() {
  const creds = loadCredentials();
  if (!creds) {
    console.warn('[Aviation] No OpenSky credentials (credentials.json or OPENSKY_CREDENTIALS) — skipping poll.');
    return;
  }

  // fetchWithTimeout(url, options, timeoutMs) throws on any non-OK status.
  // The global states/all payload is ~10MB, so give it a generous 60s window.
  const token = await getToken(creds);
  let res;
  try {
    res = await fetchWithTimeout(STATES_URL, {
      headers: { Authorization: `Bearer ${token}` },
    }, 60_000);
  } catch (err: any) {
    if (!String(err?.message).includes('HTTP 401')) throw err;
    // Token revoked early — refresh once and retry
    cachedToken = null;
    const fresh = await getToken(creds);
    res = await fetchWithTimeout(STATES_URL, {
      headers: { Authorization: `Bearer ${fresh}` },
    }, 60_000);
  }

  const data = await res.json();
  const states: StateVector[] = Array.isArray(data?.states) ? data.states : [];

  const items = states
    .filter((s) => s[6] != null && s[5] != null)
    .map((s) => ({
      icao24: s[0],
      callsign: s[1]?.trim() || null,
      origin_country: s[2],
      lat: s[6],
      lon: s[5],
      alt: s[13] ?? s[7] ?? 0,      // geo altitude, falling back to baro (meters)
      hdg: s[10],
      spd: s[9],                     // m/s
      vertical_rate: s[11],
      on_ground: s[8],
      squawk: s[14],
      ts: s[3] ?? s[4],              // unix seconds
    }));

  // Bare array on purpose — see PAYLOAD CONTRACT above.
  await setLiveSnapshot('aviation', items, TTL_SECONDS);
  console.log(`[Aviation] Published ${items.length} live aircraft from OpenSky (time=${data.time}).`);
}

// Prime the cache immediately on engine start; cron sustains it afterwards.
seedAviation().catch((err) => console.warn('[Aviation] Initial poll failed:', err?.message ?? err));

export default {
  name: 'aviation', // MUST equal the frontend plugin id (ADR-0002)
  cron: '*/2 * * * *', // every 2 minutes
  fn: seedAviation,
};
