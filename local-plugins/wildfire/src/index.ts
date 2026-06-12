// wildfire — first-party frontend plugin for the local NASA FIRMS (VIIRS) seeder.
// Replaces @worldwideview/wwv-plugin-wildfire: same entity mapping and rendering
// logic, but REST fetch targets our engine's snapshot endpoint (no cloud-only
// stream URL), and the payload extractor accepts the seeder's wrapper
// {source, fetchedAt, items, totalCount} as well as bare arrays / keyed objects.
//
// The seeder publishes already-clustered FIRMS records matching the original
// bundle's expected item shape (latitude, longitude, acq_date, acq_time, frp,
// confidence, satellite, bright_ti4, bright_ti5, tier), so the mapper is ported
// faithfully and preserves every original properties.* key.

const PLUGIN_ID = "wildfire";

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
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function frpColor(frp) {
  return frp < 10 ? "#fbbf24" : frp < 50 ? "#f97316" : frp < 100 ? "#ef4444" : "#dc2626";
}

function frpSize(frp) {
  return frp < 10 ? 5 : frp < 50 ? 7 : frp < 100 ? 9 : 12;
}

function frpBand(frp) {
  return frp < 10 ? "low" : frp < 50 ? "moderate" : frp < 100 ? "high" : "extreme";
}

function toEntity(e) {
  if (e == null || typeof e.latitude !== "number" || typeof e.longitude !== "number") return null;
  const acqTime = String(e.acq_time ?? "").padStart(4, "0");
  const tsStr = `${e.acq_date}T${acqTime.slice(0, 2)}:${acqTime.slice(2)}:00Z`;
  const ts = new Date(tsStr);
  return {
    id: `wildfire-${e.latitude.toFixed(4)}-${e.longitude.toFixed(4)}-${e.acq_date}-${e.tier || 3}`,
    pluginId: PLUGIN_ID,
    latitude: e.latitude,
    longitude: e.longitude,
    timestamp: Number.isNaN(ts.getTime()) ? undefined : ts,
    label: `FRP: ${e.frp}`,
    properties: {
      frp: e.frp,
      frp_band: frpBand(e.frp || 0),
      confidence: e.confidence,
      satellite: e.satellite,
      acq_date: e.acq_date,
      acq_time: e.acq_time,
      bright_ti4: e.bright_ti4,
      bright_ti5: e.bright_ti5,
      tier: e.tier,
    },
  };
}

export default class WildfirePlugin {
  id = PLUGIN_ID;
  name = "Wildfire";
  description = "Active fire detection via NASA FIRMS (VIIRS)";
  icon = "🔥";
  category = "natural-disaster";
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
      color: "#ef4444",
      clusterEnabled: true,
      clusterDistance: 30,
    };
  }

  renderEntity(entity) {
    const frp = entity.properties?.frp || 0;
    const tier = entity.properties?.tier || 3;
    // Tier-based distance display preserved from the original bundle:
    // macro tier visible far out, micro tier only when zoomed in.
    let distanceDisplayCondition;
    if (tier === 1) distanceDisplayCondition = { near: 3500000, far: Infinity };
    else if (tier === 2) distanceDisplayCondition = { near: 1000000, far: 3500000 };
    else distanceDisplayCondition = { near: 0, far: 1000000 };
    return {
      type: "point",
      color: frpColor(frp),
      size: frpSize(frp) * (tier === 1 ? 2 : tier === 2 ? 1.5 : 1),
      outlineColor: "#000000",
      outlineWidth: 1,
      distanceDisplayCondition,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getFilterDefinitions() {
    return [
      {
        id: "frp",
        label: "Fire Radiative Power (MW)",
        type: "range",
        propertyKey: "frp",
        range: { min: 0, max: 500, step: 10 },
      },
      {
        id: "frp_band",
        label: "Intensity Category",
        type: "select",
        propertyKey: "frp_band",
        options: [
          { value: "low", label: "FRP < 10 (Low)" },
          { value: "moderate", label: "FRP 10 - 50 (Moderate)" },
          { value: "high", label: "FRP 50 - 100 (High)" },
          { value: "extreme", label: "FRP > 100 (Extreme)" },
        ],
      },
      {
        id: "confidence",
        label: "Confidence",
        type: "select",
        propertyKey: "confidence",
        options: [
          { value: "low", label: "Low" },
          { value: "nominal", label: "Nominal" },
          { value: "high", label: "High" },
        ],
      },
      {
        id: "satellite",
        label: "Satellite",
        type: "select",
        propertyKey: "satellite",
        options: [
          { value: "N", label: "Suomi NPP" },
          { value: "1", label: "NOAA-20" },
          { value: "2", label: "NOAA-21" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "FRP < 10 (Low)", color: "#fbbf24", filterId: "frp_band", filterValue: "low" },
      { label: "FRP 10 - 50 (Moderate)", color: "#f97316", filterId: "frp_band", filterValue: "moderate" },
      { label: "FRP 50 - 100 (High)", color: "#ef4444", filterId: "frp_band", filterValue: "high" },
      { label: "FRP > 100 (Extreme)", color: "#dc2626", filterId: "frp_band", filterValue: "extreme" },
    ];
  }
}
