// aviation — first-party frontend plugin for the local OpenSky seeder.
// Replaces @worldwideview/wwv-plugin-aviation: same rendering behavior, but
// REST fetch targets our engine's snapshot endpoint (no cloud-only ?lookback
// history API), and the WS handler accepts both bare-array and {items} shapes.

const PLUGIN_ID = "aviation";

function engineBase(ctx) {
  const resolved = ctx?.getEngineUrl?.() ?? ctx?.apiBaseUrl;
  if (resolved) return resolved.replace(/\/stream$/, "");
  if (typeof window === "undefined") return "http://localhost:5000";
  const port = window.__WWV_LOCAL_ENGINE_PORT__ ?? "5001";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function altitudeBand(altM) {
  if (altM === null || altM === undefined || altM <= 0) return "grounded";
  if (altM < 3000) return "low";
  if (altM < 8000) return "mid";
  if (altM < 12000) return "high";
  return "extreme";
}

function altitudeColor(altM) {
  if (altM === null || altM === undefined || altM <= 0) return "#4ade80";
  if (altM < 3000) return "#22d3ee";
  if (altM < 8000) return "#3b82f6";
  if (altM < 12000) return "#a78bfa";
  return "#f472b6";
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function toEntity(f) {
  if (f == null || typeof f.lat !== "number" || typeof f.lon !== "number") return null;
  const ts = f.ts || f.time_position || f.last_contact || f.last_updated;
  return {
    id: `aviation-${f.icao24}`,
    pluginId: PLUGIN_ID,
    latitude: f.lat,
    longitude: f.lon,
    altitude: (f.alt || 0) * 10, // exaggerated for visibility, matches original plugin
    heading: f.hdg ?? undefined,
    speed: f.spd ?? undefined,
    timestamp: new Date(ts ? ts * 1000 : Date.now()),
    label: f.callsign || f.icao24,
    properties: {
      icao24: f.icao24,
      callsign: f.callsign,
      origin_country: f.origin_country,
      altitude_m: f.alt,
      altitude_band: altitudeBand(f.alt || 0),
      velocity_ms: f.spd,
      heading: f.hdg,
      vertical_rate: f.vertical_rate,
      on_ground: f.on_ground,
      squawk: f.squawk,
    },
  };
}

export default class AviationPlugin {
  id = PLUGIN_ID;
  name = "Aviation";
  description = "Real-time aircraft tracking via OpenSky Network";
  icon = "✈️";
  category = "aviation";
  version = "2.0.0";

  async initialize(ctx) {
    this.ctx = ctx;
  }

  destroy() {
    this.ctx = null;
  }

  async fetch() {
    const res = await fetch(`${engineBase(this.ctx)}/api/${PLUGIN_ID}`);
    if (!res.ok) throw new Error(`Engine REST HTTP ${res.status}`);
    const data = await res.json();
    return extractItems(data).map(toEntity).filter(Boolean);
  }

  getPollingInterval() {
    return 0; // WS-driven; initial REST fetch only
  }

  getLayerConfig() {
    return {
      color: "#3b82f6",
      clusterEnabled: true,
      clusterDistance: 40,
      maxEntities: 5000,
    };
  }

  renderEntity(entity) {
    const altM = entity.properties.altitude_m;
    const airborne = !entity.properties.on_ground;
    return {
      type: "model",
      iconUrl: "/plane-icon.svg",
      size: airborne ? 8 : 5,
      modelUrl: "/airplane/scene.gltf",
      modelScale: 2.56,
      modelMinPixelSize: 16,
      modelHeadingOffset: 180,
      color: altitudeColor(altM),
      rotation: entity.heading,
      labelText: entity.label || undefined,
      labelFont: "11px JetBrains Mono, monospace",
    };
  }

  getSelectionBehavior(entity) {
    if (entity.properties.on_ground) return null;
    return {
      showTrail: true,
      trailDurationSec: 60,
      trailStepSec: 5,
      trailColor: "#00fff7",
      flyToOffsetMultiplier: 3,
      flyToBaseDistance: 30000,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getLegend() {
    return [
      { label: "0 m (Grounded)", color: "#4ade80", filterId: "altitude_band", filterValue: "grounded" },
      { label: "< 3,000 m", color: "#22d3ee", filterId: "altitude_band", filterValue: "low" },
      { label: "3,000 - 8,000 m", color: "#3b82f6", filterId: "altitude_band", filterValue: "mid" },
      { label: "8,000 - 12,000 m", color: "#a78bfa", filterId: "altitude_band", filterValue: "high" },
      { label: "> 12,000 m", color: "#f472b6", filterId: "altitude_band", filterValue: "extreme" },
    ];
  }

  getFilterDefinitions() {
    return [
      {
        id: "origin_country",
        label: "Country",
        type: "select",
        propertyKey: "origin_country",
        options: [
          "United States", "China", "United Kingdom", "Germany", "France",
          "Japan", "Australia", "Canada", "India", "Brazil", "Russia",
          "Turkey", "South Korea", "Indonesia", "Mexico",
        ].map((c) => ({ value: c, label: c })),
      },
      {
        id: "altitude",
        label: "Altitude (m)",
        type: "range",
        propertyKey: "altitude_m",
        range: { min: 0, max: 15000, step: 500 },
      },
      {
        id: "altitude_band",
        label: "Altitude Category",
        type: "select",
        propertyKey: "altitude_band",
        options: [
          { value: "grounded", label: "0 m (Grounded)" },
          { value: "low", label: "< 3,000 m" },
          { value: "mid", label: "3,000 - 8,000 m" },
          { value: "high", label: "8,000 - 12,000 m" },
          { value: "extreme", label: "> 12,000 m" },
        ],
      },
      { id: "on_ground", label: "On Ground", type: "boolean", propertyKey: "on_ground" },
      { id: "callsign", label: "Callsign", type: "text", propertyKey: "callsign" },
    ];
  }
}
