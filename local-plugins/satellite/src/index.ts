// satellite — first-party frontend plugin for the local CelesTrak TLE seeder.
// Replaces @worldwideview/wwv-plugin-satellite: same rendering behavior, but REST fetch
// targets our engine's snapshot endpoint, and the WS/REST handlers accept bare-array,
// {satellites: array}, {items: array}, {items: keyed object} and wrapper shapes.

const PLUGIN_ID = "satellite";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

// Color map by CelesTrak group (ported from original bundle).
const GROUP_COLORS = {
  stations: "#00fff7",
  visual: "#f0abfc",
  weather: "#a78bfa",
  "gps-ops": "#22c55e",
  resource: "#f97316",
  starlink: "#ffffff",
  military: "#3b82f6",
};

function groupColor(group) {
  return GROUP_COLORS[group] ?? "#94a3b8";
}

// Ported faithfully from the bundle's mapPayloadToEntities item-extraction logic, plus the
// engine's {items: ...} wrapper handling.
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
    id: `satellite-${sat.noradId}`,
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
      group: sat.group,
      country: sat.country,
      objectType: sat.objectType,
      altitudeKm: sat.altitude,
      period: sat.period,
    },
  };
}

// The original bundle rendered the Lucide "satellite" glyph tinted per group via the host
// SDK's createSvgIconUrl(). We are dependency-free, so we inline the same icon as a colored
// data-URI, cached per color.
const SATELLITE_PATHS = [
  "m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5",
  "M16.5 7.5 19 5",
  "m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5",
  "M9 21a6 6 0 0 0-6-6",
  "M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z",
];
const _iconCache = {};
function satelliteIconUrl(color) {
  if (_iconCache[color]) return _iconCache[color];
  const paths = SATELLITE_PATHS.map((d) => `<path d="${d}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  _iconCache[color] = url;
  return url;
}

export default class SatellitePlugin {
  id = PLUGIN_ID;
  name = "Satellites";
  description = "Real-time satellite tracking (ISS, GPS, weather, military)";
  icon = "🛰️";
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
      color: "#00fff7",
      clusterEnabled: false,
      clusterDistance: 0,
      maxEntities: 1000,
    };
  }

  renderEntity(entity) {
    const group = entity.properties.group || "";
    const isStation = group === "stations";
    const color = groupColor(group);
    return {
      type: "billboard",
      iconUrl: satelliteIconUrl(color),
      color,
      iconScale: isStation ? 0.9 : 0.7,
      labelText: isStation ? entity.label : undefined,
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
      trailColor: "#00fff7",
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
        label: "Satellite Group",
        type: "select",
        propertyKey: "group",
        options: [
          { value: "stations", label: "Space Stations" },
          { value: "visual", label: "Brightest Satellites" },
          { value: "weather", label: "Weather" },
          { value: "gps-ops", label: "GPS" },
          { value: "resource", label: "Earth Observation" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "Space Stations", color: groupColor("stations"), filterId: "group", filterValue: "stations" },
      { label: "Brightest Satellites", color: groupColor("visual"), filterId: "group", filterValue: "visual" },
      { label: "Weather", color: groupColor("weather"), filterId: "group", filterValue: "weather" },
      { label: "GPS", color: groupColor("gps-ops"), filterId: "group", filterValue: "gps-ops" },
      { label: "Earth Observation", color: groupColor("resource"), filterId: "group", filterValue: "resource" },
      { label: "Starlink", color: groupColor("starlink"), filterId: "group", filterValue: "starlink" },
      { label: "Military", color: groupColor("military"), filterId: "group", filterValue: "military" },
      { label: "Other", color: groupColor("other"), filterId: "group", filterValue: "other" },
    ];
  }
}
