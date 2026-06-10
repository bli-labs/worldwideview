// src/index.ts
import { readFileSync } from "fs";
var KNOTS_TO_MS = 0.514444;
var FT_TO_M = 0.3048;
var M_PER_DEG_LAT = 111320;
var LOOP_MS = 2 * 60 * 60 * 1e3;
var MIN_AIRBORNE_SPEED_KTS = 50;
var snapshot = JSON.parse(
  readFileSync(new URL("../snapshot.json", import.meta.url), "utf8")
);
var simStart = Date.now();
function simulate(f, elapsedMs) {
  if (f.gspeed < MIN_AIRBORNE_SPEED_KTS || f.track == null) {
    return { lat: f.lat, lon: f.lon };
  }
  const distM = f.gspeed * KNOTS_TO_MS * (elapsedMs / 1e3);
  const rad = f.track * Math.PI / 180;
  const dLat = distM * Math.cos(rad) / M_PER_DEG_LAT;
  const latRad = f.lat * Math.PI / 180;
  const dLon = distM * Math.sin(rad) / (M_PER_DEG_LAT * Math.cos(latRad));
  let lat = f.lat + dLat;
  let lon = f.lon + dLon;
  if (lat > 89.5) lat = 89.5;
  if (lat < -89.5) lat = -89.5;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat, lon };
}
var index_default = {
  name: "fr24-flights",
  // MUST equal the frontend plugin id (ADR-0002)
  interval: 3e4,
  fetch: async () => {
    const elapsed = (Date.now() - simStart) % LOOP_MS;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return snapshot.flights.map((f) => {
      var _a, _b;
      const pos = simulate(f, elapsed);
      return {
        id: f.fr24_id,
        pluginId: "fr24-flights",
        latitude: pos.lat,
        longitude: pos.lon,
        altitude: f.alt > 0 ? f.alt * FT_TO_M : 0,
        heading: f.track ?? 0,
        speed: f.gspeed,
        timestamp: now,
        label: ((_a = f.callsign) == null ? void 0 : _a.trim()) || f.fr24_id,
        properties: {
          callsign: ((_b = f.callsign) == null ? void 0 : _b.trim()) || null,
          hex: f.hex,
          squawk: f.squawk,
          adsb_source: f.source,
          alt_ft: f.alt,
          gspeed_kts: f.gspeed,
          vspeed_fpm: f.vspeed,
          simulated: true,
          snapshot_time: snapshot.fetchedAt
        }
      };
    });
  }
};
export {
  index_default as default
};
