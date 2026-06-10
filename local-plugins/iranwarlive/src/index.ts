// iranwarlive — first-party frontend plugin for the local IranWarLive OSINT seeder.
// Replaces @worldwideview/wwv-plugin-iranwarlive: same entity mapping and
// rendering logic, but the original was WS-only (its fetch() returned []) and
// pointed at a dead cloud stream URL. Here fetch() pulls the engine's REST
// snapshot, and the payload extractor accepts the seeder's wrapper
// {source, fetchedAt, items} as well as bare arrays / single-event objects.
//
// The seeder validates each event with a Zod schema that keeps event_id, type,
// location, timestamp, confidence, event_summary, source_url, preview_image and
// passes _osint_meta through untouched (z.any). The mapper below is ported
// faithfully and preserves every original properties.* key. Coordinates and
// casualties come from _osint_meta, exactly as in the original bundle.

const PLUGIN_ID = "iranwarlive";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  // single-event object (matches original mapPayloadToEntities fallback)
  if (payload && typeof payload === "object" && (payload.event_id || payload._osint_meta)) return [payload];
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function toEntity(e) {
  if (e == null) return null;
  const lat = e._osint_meta?.coordinates?.lat ?? 0;
  const lon = e._osint_meta?.coordinates?.lng ?? 0;
  // Drop null-island events (no usable geolocation).
  if (!(typeof lat === "number" && typeof lon === "number") || (lat === 0 && lon === 0)) return null;

  const ts = new Date(e.timestamp || Date.now());
  const hoursAgo = Math.max(0, Math.round((Date.now() - ts.getTime()) / (1000 * 60 * 60)));

  return {
    id: e.event_id,
    pluginId: PLUGIN_ID,
    latitude: lat,
    longitude: lon,
    timestamp: Number.isNaN(ts.getTime()) ? undefined : ts,
    label: (e.type || "Event") + (e.location ? ` in ${e.location}` : ""),
    properties: {
      hours_ago: hoursAgo,
      type: e.type,
      confidence: e.confidence,
      location: e.location,
      summary: e.event_summary,
      casualties: e._osint_meta?.casualties || 0,
      source_url: e.source_url,
      preview_image: e.preview_image,
      preview_video: e.preview_video,
    },
  };
}

export default class IranWarLivePlugin {
  id = PLUGIN_ID;
  name = "Iran War Live";
  description = "Live OSINT tracking — Data sourced from IranWarLive.com (Not for Life-Safety)";
  icon = "🛡️";
  category = "conflict";
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
      clusterEnabled: true,
      clusterDistance: 40,
    };
  }

  renderEntity(entity) {
    // Original used per-type SVG icons via the host SDK; ported to a dependency-free
    // point render. Severity color is constant red and size constant (16) in the original.
    return {
      type: "point",
      color: "#ef4444",
      size: 16,
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
        label: "Strike Type",
        type: "select",
        propertyKey: "type",
        options: [
          { value: "Missile Strike", label: "Missile Strike" },
          { value: "Air Strike", label: "Air Strike" },
        ],
      },
      {
        id: "confidence",
        label: "Intelligence Confidence",
        type: "select",
        propertyKey: "confidence",
        options: [
          { value: "News Wire", label: "News Wire" },
          { value: "State Actor", label: "State Defense Press" },
        ],
      },
      {
        id: "hours_ago",
        label: "Max Hours Ago",
        type: "range",
        propertyKey: "hours_ago",
        range: { min: 0, max: 168, step: 1 },
      },
    ];
  }

  getLegend() {
    return [{ label: "Kinetic Event", color: "#ef4444" }];
  }
}
