// surveillance-satellites — first-party frontend plugin for the local CelesTrak military/
// reconnaissance TLE seeder. Replaces @worldwideview/wwv-plugin-surveillance-satellites:
// same rendering behavior, but REST fetch targets our engine's snapshot endpoint, and the
// WS/REST handlers accept {satellites: array}, {items: {satellites: array}}, {items: array}
// and wrapper shapes.

const PLUGIN_ID = "surveillance-satellites";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

// Ported faithfully from the bundle's mapPayload item-extraction, plus engine {items: ...}
// wrapper handling (seeder publishes { satellites: [...] } inside items).
function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.satellites)) return payload.satellites;
    if (payload.items && Array.isArray(payload.items.satellites)) return payload.items.satellites;
    if (Array.isArray(payload.items)) return payload.items;
    if (payload.items && typeof payload.items === "object") return Object.values(payload.items);
    return Object.values(payload);
  }
  return [];
}

function toEntity(sat) {
  if (sat == null) return null;
  return {
    id: `surv-sat-${sat.noradId}`,
    pluginId: PLUGIN_ID,
    latitude: sat.latitude,
    longitude: sat.longitude,
    altitude: sat.altitude * 1000, // km -> m
    heading: sat.heading,
    speed: sat.speed,
    timestamp: new Date(),
    label: sat.name,
    properties: {
      noradId: sat.noradId,
      name: sat.name,
      group: sat.group === "military" ? "Military" : "Recon",
      country: sat.country || "Unknown",
      objectType: sat.objectType,
      altitudeKm: Math.round(sat.altitude),
      speedKph: Math.round(sat.speed * 3.6),
      period: sat.period,
    },
  };
}

// The original bundle rendered the Lucide "radar" glyph tinted per mission type via the host
// SDK's createSvgIconUrl(). We are dependency-free, so we inline the same icon as a colored
// data-URI, cached per color.
const RADAR_PATHS = [
  "M19.07 4.93A10 10 0 0 0 6.99 3.34",
  "M4 6h.01",
  "M2.29 9.62A10 10 0 1 0 21.31 8.35",
  "M16.24 7.76A6 6 0 1 0 8.23 16.67",
  "M12 18h.01",
  "M17.99 11.66A6 6 0 0 1 15.77 16.67",
  "m13.41 10.59 5.66-5.66",
];
const RADAR_CIRCLE = '<circle cx="12" cy="12" r="2"/>';
const _iconCache = {};
function radarIconUrl(color) {
  if (_iconCache[color]) return _iconCache[color];
  const paths = RADAR_PATHS.map((d) => `<path d="${d}"/>`).join("") + RADAR_CIRCLE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  _iconCache[color] = url;
  return url;
}

export default class SurveillanceSatellitesPlugin {
  id = PLUGIN_ID;
  name = "Surveillance Satellites";
  description = "Active military and reconnaissance satellite tracking";
  icon = "📡";
  category = "infrastructure";
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
    return extractItems(data).map(toEntity).filter(Boolean);
  }

  getPollingInterval() {
    return 0; // WS-driven; initial REST fetch only
  }

  getLayerConfig() {
    return {
      color: "#ef4444",
      clusterEnabled: false,
      clusterDistance: 0,
      maxEntities: 1000,
    };
  }

  renderEntity(entity) {
    const color = entity.properties.group === "Military" ? "#3b82f6" : "#f97316";
    return {
      type: "billboard",
      iconUrl: radarIconUrl(color),
      color,
      labelText: entity.label,
      labelFont: "12px sans-serif",
      disableManualHorizonCulling: true,
      disableDepthTestDistance: 0,
    };
  }

  getSelectionBehavior() {
    return {
      showTrail: true,
      trailDurationSec: 300,
      trailStepSec: 10,
      trailColor: "#ef4444",
      flyToOffsetMultiplier: 4,
      flyToBaseDistance: 2e6,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getFilterDefinitions() {
    return [
      {
        id: "group",
        label: "Mission Type",
        type: "select",
        propertyKey: "group",
        options: [
          { value: "Military", label: "Military Operations" },
          { value: "Recon", label: "Reconnaissance" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "Military Satellites", color: "#3b82f6", filterId: "group", filterValue: "Military" },
      { label: "Reconnaissance", color: "#f97316", filterId: "group", filterValue: "Recon" },
    ];
  }
}
