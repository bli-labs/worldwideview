// =============================================================================
// fr24-flights — simulated global air traffic from a one-time Flightradar24
// snapshot (2,707 flights, 10-tile global sample).
//
// No live API calls: positions are dead-reckoned from each aircraft's snapshot
// position along its track at its ground speed. The simulation loops every
// 2 hours so the picture never disperses into nonsense. Uses the
// `interval + fetch` seeder shape — the scheduler wraps, stores, and
// broadcasts the returned flat GeoEntity[] (no SDK publish call needed).
// =============================================================================

import { readFileSync } from 'fs';

interface Fr24Flight {
  fr24_id: string;
  hex: string | null;
  callsign: string | null;
  lat: number;
  lon: number;
  track: number | null;
  alt: number;        // feet
  gspeed: number;     // knots
  vspeed: number;     // ft/min
  squawk: string;
  timestamp: string;
  source: string;
}

interface Snapshot {
  fetchedAt: string;
  source: string;
  flights: Fr24Flight[];
}

const KNOTS_TO_MS = 0.514444;
const FT_TO_M = 0.3048;
const M_PER_DEG_LAT = 111_320;
const LOOP_MS = 2 * 60 * 60 * 1000; // re-anchor to snapshot positions every 2h
const MIN_AIRBORNE_SPEED_KTS = 50;

// snapshot.json sits at the package root, one level above dist/
const snapshot: Snapshot = JSON.parse(
  readFileSync(new URL('../snapshot.json', import.meta.url), 'utf8'),
);

// Simulation clock starts when the engine loads the seeder, so aircraft begin
// at their true snapshot positions rather than teleporting hours downrange.
const simStart = Date.now();

function simulate(f: Fr24Flight, elapsedMs: number): { lat: number; lon: number } {
  if (f.gspeed < MIN_AIRBORNE_SPEED_KTS || f.track == null) {
    return { lat: f.lat, lon: f.lon }; // grounded / no vector — hold position
  }
  const distM = f.gspeed * KNOTS_TO_MS * (elapsedMs / 1000);
  const rad = (f.track * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / M_PER_DEG_LAT;
  const latRad = (f.lat * Math.PI) / 180;
  const dLon = (distM * Math.sin(rad)) / (M_PER_DEG_LAT * Math.cos(latRad));
  let lat = f.lat + dLat;
  let lon = f.lon + dLon;
  // Clamp/wrap to valid coordinates
  if (lat > 89.5) lat = 89.5;
  if (lat < -89.5) lat = -89.5;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

export default {
  name: 'fr24-flights', // MUST equal the frontend plugin id (ADR-0002)
  interval: 30_000,
  fetch: async () => {
    const elapsed = (Date.now() - simStart) % LOOP_MS;
    const now = new Date().toISOString();

    return snapshot.flights.map((f) => {
      const pos = simulate(f, elapsed);
      return {
        id: f.fr24_id,
        pluginId: 'fr24-flights',
        latitude: pos.lat,
        longitude: pos.lon,
        altitude: f.alt > 0 ? f.alt * FT_TO_M : 0,
        heading: f.track ?? 0,
        speed: f.gspeed,
        timestamp: now,
        label: f.callsign?.trim() || f.fr24_id,
        properties: {
          callsign: f.callsign?.trim() || null,
          hex: f.hex,
          squawk: f.squawk,
          adsb_source: f.source,
          alt_ft: f.alt,
          gspeed_kts: f.gspeed,
          vspeed_fpm: f.vspeed,
          simulated: true,
          snapshot_time: snapshot.fetchedAt,
        },
      };
    });
  },
};
