// civil-unrest — first-party frontend plugin for the local GDELT seeder.
// Replaces @worldwideview/wwv-plugin-civil-unrest: same rendering behavior, but
// REST fetch targets our engine's snapshot endpoint, and the payload extractor
// accepts the seeder's wrapper {source, fetchedAt, items, totalCount} as well as
// bare arrays / keyed objects.

const PLUGIN_ID = "civil-unrest";

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
  const lat = typeof e.lat === "number" ? e.lat : e.latitude;
  const lon = typeof e.lon === "number" ? e.lon : e.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const t = e.date ? new Date(e.date).getTime() : undefined;
  return {
    id: e.id,
    pluginId: PLUGIN_ID,
    latitude: lat,
    longitude: lon,
    timestamp: t !== undefined && !Number.isNaN(t) ? new Date(t) : undefined,
    label: `${e.type}: ${e.location || "Unknown"}`,
    name: `${e.type}: ${e.location || "Unknown"}`,
    properties: {
      type: e.type,
      subType: e.subType,
      actor1: e.actor1,
      actor2: e.actor2,
      fatalities: e.fatalities,
      country: e.country,
      location: e.location,
      date: e.date,
      source: e.source,
      notes: e.notes,
      reportCount: e.reportCount,
    },
  };
}

export default class CivilUnrestPlugin {
  id = PLUGIN_ID;
  name = "Civil Unrest";
  description = "Tracks global protests, riots, and civil disturbances via GDELT.";
  icon = "✊";
  category = "conflict";
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
    return 0;
  }

  getLayerConfig() {
    return {
      color: "#eab308",
      clusterEnabled: true,
      clusterDistance: 50,
      minZoomLevel: 3,
    };
  }

  renderEntity(entity) {
    const type = entity.properties?.type || "";
    const reportCount = entity.properties?.reportCount || 1;
    let color = "#eab308";
    if (type.includes("Riots") || type.includes("clash")) color = "#ef4444";
    else if (type.includes("Demonstration")) color = "#f97316";
    else if (type.includes("Strike")) color = "#3b82f6";
    let size = 8;
    if (reportCount > 50) size = 16;
    else if (reportCount > 15) size = 12;
    return {
      type: "point",
      color,
      size,
      outlineColor: "#000000",
      outlineWidth: 2,
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
        type: "select",
        propertyKey: "type",
        options: [
          { value: "Protests", label: "Protests" },
          { value: "Riots", label: "Riots" },
          { value: "Demonstrations", label: "Demonstrations" },
          { value: "Strikes", label: "Labor Strikes" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "Riots/Violent", color: "#ef4444" },
      { label: "Demonstrations", color: "#f97316" },
      { label: "Peaceful Protests", color: "#eab308" },
      { label: "Strikes", color: "#3b82f6" },
    ];
  }
}
