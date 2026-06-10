// fr24-flights — frontend plugin for the simulated Flightradar24 traffic layer.
// Dependency-free module: polls the local data engine's REST snapshot and
// also accepts WebSocket pushes via mapWebsocketPayload.

const PLUGIN_ID = "fr24-flights";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

function toEntity(raw) {
  if (!raw || typeof raw.latitude !== "number" || typeof raw.longitude !== "number") return null;
  return {
    ...raw,
    pluginId: PLUGIN_ID,
    timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    properties: raw.properties ?? {},
  };
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.payload)) return payload.payload;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  return [];
}

export default class Fr24FlightsPlugin {
  id = PLUGIN_ID;
  name = "FR24 Flights (Simulated)";
  description = "Global air traffic simulated from a one-time Flightradar24 snapshot.";
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
    const res = await fetch(`${engineBase()}/api/${PLUGIN_ID}`);
    if (!res.ok) throw new Error(`Engine REST HTTP ${res.status}`);
    const data = await res.json();
    return extractItems(data).map(toEntity).filter(Boolean);
  }

  getPollingInterval() {
    return 30_000;
  }

  getLayerConfig() {
    return {
      color: "#fbbf24",
      clusterEnabled: true,
      clusterDistance: 36,
      maxEntities: 5000,
    };
  }

  renderEntity(entity) {
    const altFt = Number(entity.properties?.alt_ft ?? 0);
    // Color by altitude band: amber low, sky-blue mid, indigo cruise
    const color = altFt < 10000 ? "#fbbf24" : altFt < 30000 ? "#38bdf8" : "#818cf8";
    return {
      type: "billboard",
      iconUrl: "/plane-icon.svg", // same tintable top-down plane the aviation plugin uses
      color,
      rotation: entity.heading ?? 0,
      iconScale: 0.55,
      labelText: entity.label,
    };
  }

  getFilterDefinitions() {
    return [
      { id: "callsign", label: "Callsign", type: "text", propertyKey: "callsign" },
      {
        id: "alt_ft",
        label: "Altitude (ft)",
        type: "range",
        propertyKey: "alt_ft",
        range: { min: 0, max: 50000, step: 1000 },
      },
      {
        id: "gspeed_kts",
        label: "Ground Speed (kts)",
        type: "range",
        propertyKey: "gspeed_kts",
        range: { min: 0, max: 700, step: 10 },
      },
    ];
  }

  getLegend() {
    return [
      { label: "Below 10,000 ft", color: "#fbbf24" },
      { label: "10,000–30,000 ft", color: "#38bdf8" },
      { label: "Above 30,000 ft", color: "#818cf8" },
    ];
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }
}
