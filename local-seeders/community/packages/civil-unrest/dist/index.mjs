// src/index.ts
import { db } from "@worldwideview/seeder-sdk";
import { setLiveSnapshot } from "@worldwideview/seeder-sdk";
import { fetchWithTimeout, withRetry } from "@worldwideview/seeder-sdk";
var insertUnrest = db.prepare(
  "INSERT OR REPLACE INTO civil_unrest (id, payload, source_ts, fetched_at) VALUES (@id, @payload, @source_ts, @fetched_at)"
);
async function publish(items, source) {
  const fetchedAt = Date.now();
  for (const item of items) {
    insertUnrest.run({
      id: item.id,
      payload: JSON.stringify(item),
      source_ts: new Date(item.date).getTime() || fetchedAt,
      fetched_at: fetchedAt
    });
  }
  await setLiveSnapshot(
    "civil-unrest",
    { source, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), items, totalCount: items.length },
    86400
  );
  console.log(`[CivilUnrest] Published ${items.length} events (source=${source}).`);
}
var ACLED_TOKEN_URL = "https://acleddata.com/oauth/token";
var ACLED_READ_URL = "https://acleddata.com/api/acled/read";
var ACLED_EVENT_TYPES = ["Protests", "Riots"];
var ACLED_LOOKBACK_DAYS = 30;
var ACLED_LIMIT_PER_TYPE = 3e3;
var acledToken = null;
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
async function getAcledToken(email, password) {
  if (acledToken && Date.now() < acledToken.expiresAt - 60 * 60 * 1e3) {
    return acledToken.token;
  }
  const body = new URLSearchParams({
    username: email,
    password,
    grant_type: "password",
    client_id: "acled",
    scope: "authenticated"
  });
  const res = await fetchWithTimeout(ACLED_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  }, 2e4);
  const json = await res.json();
  if (!json.access_token) throw new Error("ACLED token response missing access_token");
  acledToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86400) * 1e3
  };
  return acledToken.token;
}
function mapAcledEvent(e) {
  const lat = Number(e.latitude);
  const lon = Number(e.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: `acled-${e.event_id_cnty}`,
    lat,
    lon,
    type: e.event_type,
    subType: e.sub_event_type || "",
    actor1: e.actor1 || "Unknown",
    actor2: e.actor2 || "N/A",
    fatalities: Number(e.fatalities) || 0,
    country: e.country || "Unknown",
    location: e.location || e.admin1 || e.country || "Unknown",
    date: e.event_date,
    source: "ACLED",
    notes: e.notes || "",
    // One curated event per marker (GDELT used clustered mention counts here).
    reportCount: 1
  };
}
async function seedFromAcled() {
  const email = process.env.ACLED_EMAIL;
  const password = process.env.ACLED_PASSWORD;
  if (!email || !password) {
    console.log("[CivilUnrest] ACLED_EMAIL/ACLED_PASSWORD not set \u2014 using GDELT fallback.");
    return false;
  }
  try {
    const token = await getAcledToken(email, password);
    const since = new Date(Date.now() - ACLED_LOOKBACK_DAYS * 86400 * 1e3);
    const window = `${isoDate(since)}|${isoDate(/* @__PURE__ */ new Date())}`;
    const all = [];
    for (const eventType of ACLED_EVENT_TYPES) {
      const url = `${ACLED_READ_URL}?_format=json&event_type=${encodeURIComponent(eventType)}&event_date=${encodeURIComponent(window)}&event_date_where=BETWEEN&limit=${ACLED_LIMIT_PER_TYPE}`;
      const res = await withRetry(() => fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
      }, 45e3), 2, 5e3);
      const json = await res.json();
      if (json.message) throw new Error(`ACLED read: ${json.message}`);
      const rows = json.data ?? json.results ?? [];
      if (!Array.isArray(rows)) throw new Error("ACLED read: unexpected response shape");
      all.push(...rows);
    }
    const items = all.map(mapAcledEvent).filter(Boolean);
    if (items.length === 0) {
      console.warn("[CivilUnrest] ACLED returned 0 events \u2014 using GDELT fallback.");
      return false;
    }
    await publish(items, "acled");
    return true;
  } catch (err) {
    console.warn(`[CivilUnrest] ACLED unavailable (${(err == null ? void 0 : err.message) ?? err}) \u2014 using GDELT fallback.`);
    return false;
  }
}
var GDELT_URL = "http://api.gdeltproject.org/api/v1/gkg_geojson?query=protest OR riot OR demonstration OR strike OR clash&maxrows=2500";
function classifyGdeltEventType(name) {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("riot")) return "Riots";
  if (lowerName.includes("clash")) return "Riots";
  if (lowerName.includes("strike")) return "Strikes";
  if (lowerName.includes("demonstration")) return "Demonstrations";
  return "Protests";
}
function classifyGdeltSubType(name, count) {
  const lowerName = name.toLowerCase();
  if (count > 50 || lowerName.includes("riot") || lowerName.includes("clash")) return "Violent demonstration";
  if (lowerName.includes("strike")) return "Labor strike";
  return "Peaceful protest";
}
async function seedFromGdelt() {
  var _a, _b, _c;
  console.log("[CivilUnrest] Fetching from GDELT API...");
  const res = await withRetry(() => fetchWithTimeout(GDELT_URL, { headers: { "User-Agent": "WWV-Data-Engine" } }, 25e3), 3, 5e3);
  if (!res.ok) {
    console.warn(`[CivilUnrest] Failed to fetch. HTTP ${res.status}`);
    return;
  }
  const json = await res.json();
  const features = json.features;
  if (!features || features.length === 0) {
    console.log("[CivilUnrest] No events returned from GDELT.");
    return;
  }
  const locationMap = /* @__PURE__ */ new Map();
  for (const feature of features) {
    const name = ((_a = feature.properties) == null ? void 0 : _a.name) || "";
    if (!name) continue;
    const coords = (_b = feature.geometry) == null ? void 0 : _b.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
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
        urls: [feature.properties.url]
      });
    }
  }
  const items = [];
  for (const [, loc] of locationMap) {
    if (loc.count < 3) continue;
    const country = ((_c = loc.name.split(",").pop()) == null ? void 0 : _c.trim()) || "Unknown";
    const eventType = classifyGdeltEventType(loc.name);
    items.push({
      id: `gdelt-${loc.lat.toFixed(2)}-${loc.lon.toFixed(2)}`,
      lat: loc.lat,
      lon: loc.lon,
      type: eventType,
      subType: classifyGdeltSubType(loc.name, loc.count),
      actor1: "General Public",
      actor2: "N/A",
      fatalities: 0,
      country,
      location: loc.name,
      date: loc.date,
      source: "GDELT",
      notes: `${loc.count} clustered reports. Worst Tone: ${loc.worstTone.toFixed(1)}`,
      reportCount: loc.count
    });
  }
  console.log(`[CivilUnrest] Clustered ${features.length} mentions into ${items.length} confirmed unrest events.`);
  await publish(items, "gdelt");
}
async function seedCivilUnrest() {
  const usedAcled = await seedFromAcled();
  if (!usedAcled) await seedFromGdelt();
}
var index_default = {
  name: "civil-unrest",
  cron: "*/30 * * * *",
  fn: seedCivilUnrest
};
export {
  index_default as default,
  seedCivilUnrest
};
