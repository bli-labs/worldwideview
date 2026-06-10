// maritime — first-party frontend plugin for the local AIS (aisstream.io) seeder.
// Replaces @worldwideview/wwv-plugin-maritime: same rendering behavior, but REST fetch
// targets our engine's snapshot endpoint (no cloud-only ?lookback history API), and the
// WS/REST handlers accept bare-array, {items: array}, {items: keyed object} shapes.

const PLUGIN_ID = "maritime";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

// Vessel-type -> color map (ported from original bundle).
const VESSEL_COLORS = {
  cargo: "#f59e0b",
  tanker: "#ef4444",
  passenger: "#3b82f6",
  fishing: "#22d3ee",
  military: "#a78bfa",
  sailing: "#4ade80",
  tug: "#f97316",
  other: "#94a3b8",
};

function vesselColor(type) {
  const t = (type || "other").toLowerCase();
  for (const [key, color] of Object.entries(VESSEL_COLORS)) {
    if (t.includes(key)) return color;
  }
  return VESSEL_COLORS.other;
}

// The original bundle rendered the Lucide "ship" glyph tinted per vessel type via the
// host SDK's createSvgIconUrl(). We are dependency-free, so we inline the same icon as a
// colored data-URI, cached per color.
const SHIP_PATHS = [
  "M12 10.189V14",
  "M12 2v3",
  "M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6",
  "M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76",
  "M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
];
const _shipIconCache = {};
function shipIconUrl(color) {
  if (_shipIconCache[color]) return _shipIconCache[color];
  const paths = SHIP_PATHS.map((d) => `<path d="${d}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  _shipIconCache[color] = url;
  return url;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

// Ported faithfully from the original bundle's mapPayloadToEntities, including the
// history-trail accumulation against previously-seen entities.
function mapEntities(payload, existing) {
  const prevById = new Map((existing || []).map((e) => [e.id, e]));
  const rows = extractItems(payload);
  return rows.map((v) => {
    const id = `maritime-${v.mmsi || v.id}`;
    const prev = prevById.get(id);
    let history = v.history || (v.properties && v.properties.history) || (prev && prev.properties.history) || [];

    const lastTs = v.last_updated || v.ts;
    if (lastTs) {
      const lat = v.lat ?? v.latitude;
      const lon = v.lon ?? v.longitude;
      const newest = history.length > 0 ? history[history.length - 1].ts : 0;
      if (lastTs > newest && lat !== undefined && lon !== undefined) {
        history.push({ lat, lon, ts: lastTs });
      }
    }
    if (history.length > 61) history.splice(0, history.length - 61);

    const heading = v.hdg === 511 ? undefined : (v.hdg ?? v.heading);
    const spdKts = v.spd ?? v.speed;
    const speed = spdKts === undefined ? undefined : spdKts * 0.514444; // knots -> m/s

    return {
      id,
      pluginId: PLUGIN_ID,
      latitude: v.lat ?? v.latitude,
      longitude: v.lon ?? v.longitude,
      heading,
      speed,
      timestamp: v.last_updated ? new Date(v.last_updated * 1000) : new Date(v.timestamp || Date.now()),
      label: v.name ?? v.label,
      properties: {
        mmsi: v.mmsi,
        vesselName: v.name,
        vesselType: v.type || (v.properties && v.properties.vesselType) || "other",
        speed_knots: v.spd ?? v.speed,
        heading: v.hdg ?? v.heading,
        history,
      },
    };
  });
}

export default class MaritimePlugin {
  id = PLUGIN_ID;
  name = "Maritime";
  description = "Vessel tracking via AIS feeds";
  icon = "🚢";
  category = "maritime";
  version = "2.0.0";

  async initialize(ctx) {
    this.ctx = ctx;
  }

  destroy() {
    this.ctx = null;
  }

  async fetch() {
    const res = await fetch(`${engineBase()}/api/${PLUGIN_ID}`);
    if (!res.ok) throw new Error(`Engine REST HTTP ${res.status}`);
    const data = await res.json();
    return mapEntities(data);
  }

  getPollingInterval() {
    return 0; // WS-driven; initial REST fetch only
  }

  getLayerConfig() {
    return {
      color: "#f59e0b",
      clusterEnabled: true,
      clusterDistance: 50,
    };
  }

  renderEntity(entity) {
    const color = vesselColor(entity.properties.vesselType || "other");
    return {
      type: "billboard",
      iconUrl: shipIconUrl(color),
      color,
      rotation: entity.heading,
      labelText: entity.label || undefined,
      labelFont: "11px JetBrains Mono, monospace",
      distanceDisplayCondition: { near: 0, far: 1e6 },
      trailOptions: { width: 2, color, opacityFade: true },
    };
  }

  getSelectionBehavior(entity) {
    if (!entity.speed || entity.speed < 0.1) return null;
    return {
      showTrail: true,
      trailDurationSec: 3600,
      trailStepSec: 60,
      trailColor: vesselColor(entity.properties.vesselType || "other"),
      flyToOffsetMultiplier: 3,
      flyToBaseDistance: 15000,
    };
  }

  mapWebsocketPayload(payload, existingEntities) {
    return mapEntities(payload, existingEntities);
  }

  getFilterDefinitions() {
    return [
      {
        id: "vessel_type",
        label: "Vessel Type",
        type: "select",
        propertyKey: "vesselType",
        options: [
          { value: "cargo", label: "Cargo" },
          { value: "tanker", label: "Tanker" },
          { value: "passenger", label: "Passenger" },
          { value: "fishing", label: "Fishing" },
          { value: "military", label: "Military" },
          { value: "sailing", label: "Sailing" },
          { value: "tug", label: "Tug" },
          { value: "other", label: "Other" },
        ],
      },
      {
        id: "speed",
        label: "Speed (knots)",
        type: "range",
        propertyKey: "speed_knots",
        range: { min: 0, max: 30, step: 1 },
      },
    ];
  }

  getLegend() {
    return [
      { label: "Cargo", color: VESSEL_COLORS.cargo, filterId: "vessel_type", filterValue: "cargo" },
      { label: "Tanker", color: VESSEL_COLORS.tanker, filterId: "vessel_type", filterValue: "tanker" },
      { label: "Passenger", color: VESSEL_COLORS.passenger, filterId: "vessel_type", filterValue: "passenger" },
      { label: "Fishing", color: VESSEL_COLORS.fishing, filterId: "vessel_type", filterValue: "fishing" },
      { label: "Military", color: VESSEL_COLORS.military, filterId: "vessel_type", filterValue: "military" },
      { label: "Sailing", color: VESSEL_COLORS.sailing, filterId: "vessel_type", filterValue: "sailing" },
      { label: "Tug", color: VESSEL_COLORS.tug, filterId: "vessel_type", filterValue: "tug" },
      { label: "Other", color: VESSEL_COLORS.other, filterId: "vessel_type", filterValue: "other" },
    ];
  }
}
