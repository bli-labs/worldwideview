// civil-unrest — real-world unrest events.
//
// PRIMARY: ACLED (acleddata.com) — curated protest/riot events with actors,
// fatalities, and locations. Auth is OAuth2 password grant (ACLED_EMAIL /
// ACLED_PASSWORD env), tokens last 24h. NOTE: the account must have API access
// activated in myACLED; until then the read endpoint returns "Access denied"
// and we fall back automatically.
//
// FALLBACK: GDELT GKG mention clustering (the previous implementation) — no
// credentials required.
//
// Both paths publish the same item shape consumed by the first-party
// civil-unrest frontend plugin:
// { id, lat, lon, type, subType, actor1, actor2, fatalities, country,
//   location, date, source, notes, reportCount }

import { db } from '@worldwideview/seeder-sdk';
import { setLiveSnapshot } from '@worldwideview/seeder-sdk';
import { fetchWithTimeout, withRetry } from '@worldwideview/seeder-sdk';

// ─── Shared ──────────────────────────────────────────────────────────────────

const insertUnrest = db.prepare(
  'INSERT OR REPLACE INTO civil_unrest (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)'
);

async function publish(items: any[], source: string) {
  const fetchedAt = Date.now();
  for (const item of items) {
    insertUnrest.run({
      id: item.id,
      payload: JSON.stringify(item),
      source_ts: new Date(item.date).getTime() || fetchedAt,
      fetched_at: fetchedAt,
    });
  }
  await setLiveSnapshot(
    'civil-unrest',
    { source, fetchedAt: new Date().toISOString(), items, totalCount: items.length },
    86400,
  );
  console.log(`[CivilUnrest] Published ${items.length} events (source=${source}).`);
}

// ─── ACLED (primary) ─────────────────────────────────────────────────────────

const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_READ_URL = 'https://acleddata.com/api/acled/read';
const ACLED_EVENT_TYPES = ['Protests', 'Riots'];
const ACLED_LOOKBACK_DAYS = 30;
const ACLED_LIMIT_PER_TYPE = 3000;

let acledToken: { token: string; expiresAt: number } | null = null;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getAcledToken(email: string, password: string): Promise<string> {
  if (acledToken && Date.now() < acledToken.expiresAt - 60 * 60 * 1000) {
    return acledToken.token;
  }
  const body = new URLSearchParams({
    username: email,
    password,
    grant_type: 'password',
    client_id: 'acled',
    scope: 'authenticated',
  });
  const res = await fetchWithTimeout(ACLED_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, 20000);
  const json = await res.json();
  if (!json.access_token) throw new Error('ACLED token response missing access_token');
  acledToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86400) * 1000,
  };
  return acledToken.token;
}

function mapAcledEvent(e: any) {
  const lat = Number(e.latitude);
  const lon = Number(e.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: `acled-${e.event_id_cnty}`,
    lat,
    lon,
    type: e.event_type,
    subType: e.sub_event_type || '',
    actor1: e.actor1 || 'Unknown',
    actor2: e.actor2 || 'N/A',
    fatalities: Number(e.fatalities) || 0,
    country: e.country || 'Unknown',
    location: e.location || e.admin1 || e.country || 'Unknown',
    date: e.event_date,
    source: 'ACLED',
    notes: e.notes || '',
    // One curated event per marker (GDELT used clustered mention counts here).
    reportCount: 1,
  };
}

async function seedFromAcled(): Promise<boolean> {
  const email = process.env.ACLED_EMAIL;
  const password = process.env.ACLED_PASSWORD;
  if (!email || !password) {
    console.log('[CivilUnrest] ACLED_EMAIL/ACLED_PASSWORD not set — using GDELT fallback.');
    return false;
  }

  try {
    const token = await getAcledToken(email, password);
    const since = new Date(Date.now() - ACLED_LOOKBACK_DAYS * 86400 * 1000);
    const window = `${isoDate(since)}|${isoDate(new Date())}`;

    const all: any[] = [];
    for (const eventType of ACLED_EVENT_TYPES) {
      const url =
        `${ACLED_READ_URL}?_format=json` +
        `&event_type=${encodeURIComponent(eventType)}` +
        `&event_date=${encodeURIComponent(window)}&event_date_where=BETWEEN` +
        `&limit=${ACLED_LIMIT_PER_TYPE}`;
      const res = await withRetry(() => fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, 45000), 2, 5000);
      const json = await res.json();
      if (json.message) throw new Error(`ACLED read: ${json.message}`);
      const rows = json.data ?? json.results ?? [];
      if (!Array.isArray(rows)) throw new Error('ACLED read: unexpected response shape');
      all.push(...rows);
    }

    const items = all.map(mapAcledEvent).filter(Boolean);
    if (items.length === 0) {
      console.warn('[CivilUnrest] ACLED returned 0 events — using GDELT fallback.');
      return false;
    }
    await publish(items, 'acled');
    return true;
  } catch (err: any) {
    console.warn(`[CivilUnrest] ACLED unavailable (${err?.message ?? err}) — using GDELT fallback.`);
    return false;
  }
}

// ─── GDELT (fallback — previous implementation) ──────────────────────────────

interface GdeltFeature {
  type: string;
  geometry: { type: string, coordinates: number[] };
  properties: {
    urlpubtimedate: string;
    name: string;
    domain: string;
    url: string;
    urltone: number;
  };
}

const GDELT_URL = 'http://api.gdeltproject.org/api/v1/gkg_geojson?query=protest OR riot OR demonstration OR strike OR clash&maxrows=2500';

function classifyGdeltEventType(name: string) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'Riots';
  if (lowerName.includes('clash')) return 'Riots';
  if (lowerName.includes('strike')) return 'Strikes';
  if (lowerName.includes('demonstration')) return 'Demonstrations';
  return 'Protests';
}

function classifyGdeltSubType(name: string, count: number) {
  const lowerName = name.toLowerCase();
  if (count > 50 || lowerName.includes('riot') || lowerName.includes('clash')) return 'Violent demonstration';
  if (lowerName.includes('strike')) return 'Labor strike';
  return 'Peaceful protest';
}

async function seedFromGdelt() {
  console.log('[CivilUnrest] Fetching from GDELT API...');

  const res = await withRetry(() => fetchWithTimeout(GDELT_URL, { headers: { 'User-Agent': 'WWV-Data-Engine' } }, 25000), 3, 5000);
  if (!res.ok) {
    console.warn(`[CivilUnrest] Failed to fetch. HTTP ${res.status}`);
    return;
  }

  const json = await res.json();
  const features = json.features as GdeltFeature[];

  if (!features || features.length === 0) {
    console.log('[CivilUnrest] No events returned from GDELT.');
    return;
  }

  // Aggregate by location
  const locationMap = new Map<string, any>();
  for (const feature of features) {
    const name = feature.properties?.name || '';
    if (!name) continue;

    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    // Grid snap to ~11km clustering
    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
    const existing = locationMap.get(key);
    if (existing) {
      existing.count++;
      existing.urls.push(feature.properties.url);
      if (feature.properties.urltone < existing.worstTone) {
        existing.worstTone = feature.properties.urltone;
      }
    } else {
      locationMap.set(key, {
        name,
        lat,
        lon,
        count: 1,
        worstTone: feature.properties.urltone ?? 0,
        date: feature.properties.urlpubtimedate,
        urls: [feature.properties.url],
      });
    }
  }

  const items: any[] = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 3) continue; // Filter noise

    const country = loc.name.split(',').pop()?.trim() || 'Unknown';
    const eventType = classifyGdeltEventType(loc.name);

    items.push({
      id: `gdelt-${loc.lat.toFixed(2)}-${loc.lon.toFixed(2)}`,
      lat: loc.lat,
      lon: loc.lon,
      type: eventType,
      subType: classifyGdeltSubType(loc.name, loc.count),
      actor1: 'General Public',
      actor2: 'N/A',
      fatalities: 0,
      country,
      location: loc.name,
      date: loc.date,
      source: 'GDELT',
      notes: `${loc.count} clustered reports. Worst Tone: ${loc.worstTone.toFixed(1)}`,
      reportCount: loc.count,
    });
  }

  console.log(`[CivilUnrest] Clustered ${features.length} mentions into ${items.length} confirmed unrest events.`);
  await publish(items, 'gdelt');
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function seedCivilUnrest() {
  const usedAcled = await seedFromAcled();
  if (!usedAcled) await seedFromGdelt();
}

export default {
  name: 'civil-unrest',
  cron: '*/30 * * * *',
  fn: seedCivilUnrest,
};
