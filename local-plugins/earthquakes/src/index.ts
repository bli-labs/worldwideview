// earthquakes — first-party frontend plugin for the local USGS seeder.
// Replaces @worldwideview/wwv-plugin-earthquakes: same rendering behavior, but
// REST fetch targets our engine's snapshot endpoint (no cloud-only stream URL),
// and the payload extractor accepts the seeder's pre-mapped item shape
// {source, fetchedAt, items, totalCount} as well as bare arrays / keyed objects.
//
// NOTE: the original bundle fetched raw USGS GeoJSON and read feature.geometry /
// feature.properties. Our seeder publishes already-mapped items
// ({ id, place, magnitude, depth_km, lat, lon, occurredAt, url, nearTestSite,
//   nearestSiteName, distanceToTestSiteKm }), so the mapper below reads that shape
// while preserving every original properties.* key (magnitude, depth, place, url).

const PLUGIN_ID = "earthquakes";

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
  if (payload && Array.isArray(payload.features)) return payload.features; // raw USGS fallback
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function severityColor(mag) {
  return mag < 5 ? "#fcd34d" : mag < 6 ? "#f97316" : mag < 7 ? "#ef4444" : "#7f1d1d";
}

function severitySize(mag) {
  return mag < 5 ? 5 : mag < 6 ? 8 : mag < 7 ? 12 : 16;
}

function toEntity(f) {
  if (f == null) return null;

  // Support both the seeder's mapped item shape and raw USGS GeoJSON features.
  let lat, lon, depth, mag, place, url, ts, id, updated, status, tsunami, sig, magType;
  let nearTestSite, nearestSiteName, distanceToTestSiteKm;

  if (f.geometry && Array.isArray(f.geometry.coordinates)) {
    // raw USGS feature
    const c = f.geometry.coordinates;
    lon = c[0];
    lat = c[1];
    depth = c[2];
    const p = f.properties || {};
    mag = Number(p.mag ?? 0) || 0;
    place = p.place ?? null;
    url = p.url ?? null;
    ts = p.time;
    id = f.id;
    updated = p.updated ?? null;
    status = p.status ?? null;
    tsunami = p.tsunami ?? null;
    sig = p.sig ?? null;
    magType = p.magType ?? null;
  } else {
    // seeder item
    lat = f.lat;
    lon = f.lon;
    depth = f.depth_km;
    mag = Number(f.magnitude ?? 0) || 0;
    place = f.place ?? null;
    url = f.url ?? null;
    ts = f.occurredAt;
    id = f.id;
    nearTestSite = f.nearTestSite ?? null;
    nearestSiteName = f.nearestSiteName ?? null;
    distanceToTestSiteKm = f.distanceToTestSiteKm ?? null;
  }

  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const time = ts != null ? new Date(ts) : undefined;

  return {
    id: `${PLUGIN_ID}-${id}`,
    pluginId: PLUGIN_ID,
    latitude: lat,
    longitude: lon,
    altitude: 0,
    timestamp: time && !Number.isNaN(time.getTime()) ? time : undefined,
    label: `M${f.magnitude ?? mag ?? "?"}`,
    properties: {
      magnitude: mag,
      depth: Number(depth ?? 0) || 0,
      place,
      url,
      updated: updated ?? null,
      status: status ?? null,
      tsunami: tsunami ?? null,
      sig: sig ?? null,
      magType: magType ?? null,
      nearTestSite: nearTestSite ?? null,
      nearestSiteName: nearestSiteName ?? null,
      distanceToTestSiteKm: distanceToTestSiteKm ?? null,
    },
  };
}

export default class EarthquakesPlugin {
  id = PLUGIN_ID;
  name = "Earthquakes";
  description = "Recent seismic activity from USGS";
  icon = "🌋";
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
      clusterDistance: 40,
      maxEntities: 2000,
    };
  }

  renderEntity(entity) {
    const mag = Number(entity.properties?.magnitude ?? 0) || 0;
    return {
      type: "point",
      color: severityColor(mag),
      size: severitySize(mag),
      outlineColor: "#000000",
      outlineWidth: 1,
      labelText: entity.label,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getLegend() {
    return [
      { label: "M < 5.0", color: "#fcd34d", filterId: "magnitude", filterValue: "0" },
      { label: "M 5.0 - 5.9", color: "#f97316", filterId: "magnitude", filterValue: "5.0" },
      { label: "M 6.0 - 6.9", color: "#ef4444", filterId: "magnitude", filterValue: "6.0" },
      { label: "M ≥ 7.0", color: "#7f1d1d", filterId: "magnitude", filterValue: "7.0" },
    ];
  }

  getFilterDefinitions() {
    return [
      {
        id: "magnitude",
        label: "Magnitude",
        type: "range",
        propertyKey: "magnitude",
        range: { min: 0, max: 10, step: 0.1 },
      },
      {
        id: "depth",
        label: "Depth (km)",
        type: "range",
        propertyKey: "depth",
        range: { min: 0, max: 800, step: 10 },
      },
    ];
  }
}
