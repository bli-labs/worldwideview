// src/index.ts
import { readFileSync } from "fs";
import { setLiveSnapshot, fetchWithTimeout } from "@worldwideview/seeder-sdk";
var TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
var STATES_URL = "https://opensky-network.org/api/states/all";
var TTL_SECONDS = 360;
function loadCredentials() {
  try {
    const raw = readFileSync(new URL("../credentials.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.clientId && parsed.clientSecret) return parsed;
  } catch {
  }
  const env = process.env.OPENSKY_CREDENTIALS;
  if (env) {
    const [clientId, clientSecret] = env.split(",")[0].split(":");
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return null;
}
var cachedToken = null;
async function getToken(creds) {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 6e4) {
    return cachedToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  });
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`OpenSky token endpoint returned ${res.status}`);
  const json = await res.json();
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 1800) * 1e3
  };
  return cachedToken.token;
}
async function seedAviation() {
  const creds = loadCredentials();
  if (!creds) {
    console.warn("[Aviation] No OpenSky credentials (credentials.json or OPENSKY_CREDENTIALS) \u2014 skipping poll.");
    return;
  }
  const token = await getToken(creds);
  let res;
  try {
    res = await fetchWithTimeout(STATES_URL, {
      headers: { Authorization: `Bearer ${token}` }
    }, 6e4);
  } catch (err) {
    if (!String(err == null ? void 0 : err.message).includes("HTTP 401")) throw err;
    cachedToken = null;
    const fresh = await getToken(creds);
    res = await fetchWithTimeout(STATES_URL, {
      headers: { Authorization: `Bearer ${fresh}` }
    }, 6e4);
  }
  const data = await res.json();
  const states = Array.isArray(data == null ? void 0 : data.states) ? data.states : [];
  const items = states.filter((s) => s[6] != null && s[5] != null).map((s) => {
    var _a;
    return {
      icao24: s[0],
      callsign: ((_a = s[1]) == null ? void 0 : _a.trim()) || null,
      origin_country: s[2],
      lat: s[6],
      lon: s[5],
      alt: s[13] ?? s[7] ?? 0,
      // geo altitude, falling back to baro (meters)
      hdg: s[10],
      spd: s[9],
      // m/s
      vertical_rate: s[11],
      on_ground: s[8],
      squawk: s[14],
      ts: s[3] ?? s[4]
      // unix seconds
    };
  });
  await setLiveSnapshot("aviation", items, TTL_SECONDS);
  console.log(`[Aviation] Published ${items.length} live aircraft from OpenSky (time=${data.time}).`);
}
seedAviation().catch((err) => console.warn("[Aviation] Initial poll failed:", (err == null ? void 0 : err.message) ?? err));
var index_default = {
  name: "aviation",
  // MUST equal the frontend plugin id (ADR-0002)
  cron: "*/2 * * * *",
  // every 2 minutes
  fn: seedAviation
};
export {
  index_default as default,
  seedAviation
};
