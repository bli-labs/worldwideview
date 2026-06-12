// conflict-events — first-party frontend plugin for the local ACLED-style seeder.
// Replaces @worldwideview/wwv-plugin-conflict-events: same severity rendering, but
// REST fetch targets our engine's snapshot endpoint. The seeder publishes a bare
// array of pre-shaped entities ({ id, latitude, longitude, properties }); the
// extractor also handles {items}/{data}/keyed-object shapes for robustness.
//
// The original rendered runtime-generated Lucide billboard icons via the host SDK
// (createSvgIconUrl). To stay dependency-free we render points using the same
// fatalities-driven severity color/size, preserving the visual outcome and every
// properties.* key the filters reference.

const PLUGIN_ID = "conflict-events";

function engineBase(ctx) {
  const resolved = ctx?.getEngineUrl?.() ?? ctx?.apiBaseUrl;
  if (resolved) return resolved.replace(/\/stream$/, "");
  if (typeof window === "undefined") return "http://localhost:5000";
  const port = window.__WWV_LOCAL_ENGINE_PORT__ ?? "5001";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && typeof payload.data === "object") return extractItems(payload.data);
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function toEntity(e) {
  if (e == null) return null;
  const lat = typeof e.latitude === "number" ? e.latitude : e.lat;
  const lon = typeof e.longitude === "number" ? e.longitude : e.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const props = e.properties || e;
  const date = props.date;
  const t = date ? new Date(date).getTime() : undefined;
  return {
    id: e.id,
    pluginId: PLUGIN_ID,
    latitude: lat,
    longitude: lon,
    timestamp: t !== undefined && !Number.isNaN(t) ? new Date(t) : undefined,
    label: props.type || undefined,
    name: props.type || undefined,
    properties: {
      type: props.type,
      subType: props.subType,
      fatalities: props.fatalities,
      actor1: props.actor1,
      actor2: props.actor2,
      date: props.date,
      notes: props.notes,
    },
  };
}

export default class ConflictEventsPlugin {
  id = PLUGIN_ID;
  name = "Conflict Events";
  description = "Recent conflict events and violence mapping";
  icon = "🎯";
  category = "conflict";
  version = "2.0.0";

  async initialize(ctx) {
    this.ctx = ctx;
  }

  destroy() {
    this.ctx = null;
  }

  getSeverityValue(entity) {
    return entity.properties?.fatalities || 0;
  }

  getSeverityColor(v) {
    return v > 10 ? "#ef4444" : v > 0 ? "#f97316" : "#facc15";
  }

  getSeveritySize(v) {
    return v > 10 ? 20 : v > 0 ? 15 : 10;
  }

  async fetch() {
    const res = await fetch(`${engineBase(this.ctx)}/api/${PLUGIN_ID}`);
    if (!res.ok) throw new Error(`Engine REST HTTP ${res.status}`);
    const data = await res.json();
    return extractItems(data).map(toEntity).filter(Boolean);
  }

  getPollingInterval() {
    return 0;
  }

  getLayerConfig() {
    return {
      color: "#ef4444",
      clusterEnabled: true,
      clusterDistance: 50,
    };
  }

  renderEntity(entity) {
    const v = this.getSeverityValue(entity);
    const color = this.getSeverityColor(v);
    const size = this.getSeveritySize(v);
    return {
      type: "point",
      color,
      size,
      outlineColor: "#000000",
      outlineWidth: 1,
      labelText: entity.label || undefined,
      labelFont: "11px JetBrains Mono, monospace",
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getFilterDefinitions() {
    return [
      {
        id: "type",
        label: "Event Type",
        propertyKey: "type",
        type: "select",
        options: [
          { value: "Battles", label: "Battles" },
          { value: "Explosions/Remote violence", label: "Explosions/Remote violence" },
          { value: "Violence against civilians", label: "Violence against civilians" },
          { value: "Protests", label: "Protests" },
          { value: "Riots", label: "Riots" },
          { value: "Strategic developments", label: "Strategic developments" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "High Fatalities (>10)", color: "#ef4444" },
      { label: "Medium Fatalities (1-10)", color: "#f97316" },
      { label: "Low Fatalities / Remote", color: "#facc15" },
    ];
  }
}
