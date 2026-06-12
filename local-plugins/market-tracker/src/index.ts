// market-tracker — first-party frontend plugin for the local Yahoo Finance seeder.
// Replaces @worldwideview/wwv-plugin-market-tracker@1.0.3.
//
// PORTING NOTE: the original bundle is primarily a UI panel plugin (a draggable
// gridstack dashboard rendered via getBottomPanelComponent, backed by a zustand store).
// It carries NO geographic entities: its fetch() returns [], its layer config sets
// maxEntities: 0, and mapWebsocketPayload pushes { items } into the panel store and
// returns []. The ~485 KB of bundled React + gridstack + zustand UI is not reproducible
// dependency-free, so the optional bottom-panel component is intentionally omitted here.
// Everything portable for a data-layer plugin (metadata, fetch, polling, layer config,
// renderEntity, websocket handling) is ported faithfully. Price items remain accessible
// via getPriceItems() / the latest snapshot so a host panel could consume them later.

const PLUGIN_ID = "market-tracker";

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

export default class MarketTrackerPlugin {
  id = PLUGIN_ID;
  name = "Market Tracker";
  description = "Real-time stock and market index tracker";
  icon = "📈";
  category = "economic";
  version = "2.0.0";

  constructor() {
    this.context = null;
    // Latest price ticks ({ id, price, changePercent, timestamp }), kept so a host
    // panel could read them. The original drove these into a zustand store.
    this.priceItems = [];
  }

  async initialize(ctx) {
    this.context = ctx;
  }

  destroy() {
    this.context = null;
  }

  // No geographic entities — fetch primes the local price cache and returns no geo data,
  // matching the original plugin's behavior (fetch() -> []).
  async fetch() {
    try {
      const res = await fetch(`${engineBase(this.context)}/api/${PLUGIN_ID}`);
      if (!res.ok) return [];
      const data = await res.json();
      this.priceItems = extractItems(data);
    } catch {
      return [];
    }
    return [];
  }

  getPriceItems() {
    return this.priceItems;
  }

  getPollingInterval() {
    return 0;
  }

  getLayerConfig() {
    return {
      color: "#10b981",
      clusterEnabled: false,
      maxEntities: 0,
    };
  }

  renderEntity() {
    return {
      type: "point",
      color: "#10b981",
      size: 1,
      outlineColor: "#ffffff",
      outlineWidth: 0,
    };
  }

  // Original: t && t.items && store.updatePrices(t.items); return [].
  // We store the items for any host panel and return no geo entities.
  mapWebsocketPayload(payload) {
    const items = extractItems(payload);
    if (items.length) this.priceItems = items;
    return [];
  }
}
