// gps-jamming — first-party frontend plugin for the local GPS/GNSS interference seeder.
// Replaces @worldwideview/wwv-plugin-gps-jamming. REST fetch targets our engine's
// snapshot endpoint; the seeder publishes a wrapper { source, fetchedAt, items,
// totalCount } where each item is { id, lat, lon, interferenceLevel, timestamp,
// region }.
//
// NOTE ON RENDERING: the original bundle aggregated raw points into H3 hex cells
// (h3-js latLngToCell/cellToBoundary) and drew extruded Cesium polygons via a React
// globe component. Both require heavy dependencies (h3-js, Cesium, the host JSX
// runtime) and are intentionally omitted here for a dependency-free data layer. We
// instead render each interference reading as a point colored by interferenceLevel,
// preserving the original color palette and the exact `interferenceLevel` property
// key the filter/legend reference.

const PLUGIN_ID = "gps-jamming";

const LEVEL_COLORS = {
  low: "#facc15",
  medium: "#f97316",
  high: "#ef4444",
};

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
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

function levelSize(level) {
  if (level === "high") return 10;
  if (level === "medium") return 7;
  return 5;
}

function toEntity(e) {
  if (e == null) return null;
  const lat = typeof e.lat === "number" ? e.lat : e.latitude;
  const lon = typeof e.lon === "number" ? e.lon : e.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const level = (e.interferenceLevel || "low").toLowerCase();
  const ts = e.timestamp;
  return {
    id: e.id != null ? `gpsjam-${e.id}` : `gpsjam-${lat.toFixed(3)}-${lon.toFixed(3)}`,
    pluginId: PLUGIN_ID,
    latitude: lat,
    longitude: lon,
    timestamp: ts ? new Date(ts) : undefined,
    label: e.region || undefined,
    name: e.region || undefined,
    properties: {
      interferenceLevel: level,
      region: e.region,
    },
  };
}

export default class GpsJammingPlugin {
  id = PLUGIN_ID;
  name = "GPS Jamming";
  description = "Daily Global GPS/GNSS Interference Map";
  icon = "📡";
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
    return 0;
  }

  getLayerConfig() {
    return {
      color: "#ef4444",
      clusterEnabled: false,
      clusterDistance: 50,
    };
  }

  renderEntity(entity) {
    const level = (entity.properties?.interferenceLevel || "low").toLowerCase();
    const color = LEVEL_COLORS[level] || LEVEL_COLORS.low;
    return {
      type: "point",
      color,
      size: levelSize(level),
      outlineColor: "#000000",
      outlineWidth: 1,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getFilterDefinitions() {
    return [
      {
        id: "level",
        label: "Interference Level",
        propertyKey: "interferenceLevel",
        type: "select",
        options: [
          { value: "low", label: "Low (0-2%)" },
          { value: "medium", label: "Medium (2-10%)" },
          { value: "high", label: "High (>10%)" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "Low (0-2%)", color: LEVEL_COLORS.low, filterId: "level", filterValue: "low" },
      { label: "Medium (2-10%)", color: LEVEL_COLORS.medium, filterId: "level", filterValue: "medium" },
      { label: "High (>10%)", color: LEVEL_COLORS.high, filterId: "level", filterValue: "high" },
    ];
  }
}
