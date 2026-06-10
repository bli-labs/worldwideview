// international-sanctions — first-party frontend plugin for the local OFAC sanctions seeder.
// Replaces @worldwideview/wwv-plugin-international-sanctions@1.1.16: same entity mapping,
// filters, legend, and extruded-country globe rendering, but REST fetch targets our engine
// snapshot endpoint and the WS handler accepts bare-array / {items} / wrapper shapes.
//
// This plugin renders nothing as a normal point layer (disableDefaultRendering). Instead it
// extrudes the borders of each sanctioned country, colored by sanction level, via the
// optional getGlobeComponent() React/Cesium component (host-provided globals).

const PLUGIN_ID = "international-sanctions";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

// Sanction level -> color, ported verbatim from the original bundle.
const LEVEL_COLORS = {
  low: "#facc15",
  medium: "#f97316",
  high: "#ef4444",
};

function toEntity(t) {
  return {
    id: t.id || `sanction-${t.countryCode || Math.random()}`,
    pluginId: PLUGIN_ID,
    latitude: t.latitude || 0,
    longitude: t.longitude || 0,
    altitude: 0,
    timestamp: new Date(t.timestamp || Date.now()),
    properties: { ...t },
  };
}

export default class InternationalSanctionsPlugin {
  id = PLUGIN_ID;
  name = "International Sanctions";
  description = "Countries facing significant international US OFAC sanctions";
  icon = "⚖️";
  category = "economic";
  version = "2.0.0";

  constructor() {
    this.context = null;
    this.data = [];

    // Optional Cesium/Resium globe component. Ported faithfully from the original bundle.
    // Uses host-provided React + Cesium + Resium globals so we stay dependency-free.
    const self = this;
    this.GlobeComp = ({ enabled }) => {
      const host = globalThis.__WWV_HOST__ || {};
      const React = host.React;
      const Cesium = host.Cesium;
      const Resium = host.Resium;
      const jsxRuntime = host.jsxRuntime;
      if (!React || !Cesium || !Resium || !jsxRuntime) return null;

      const { useState, useEffect, useMemo } = React;
      const { JulianDate, Color, GeoJsonDataSource } = Cesium;
      const { Entity, PolygonGraphics } = Resium;
      const jsx = jsxRuntime.jsx;
      const Fragment = jsxRuntime.Fragment;

      const [borders, setBorders] = useState({});

      useEffect(() => {
        if (!enabled) return;
        let alive = true;
        (async () => {
          try {
            const ds = new GeoJsonDataSource("border-shapes");
            await ds.load("/borders.geojson");
            if (!alive) return;
            const now = JulianDate.now();
            const byCode = {};
            for (const ent of ds.entities.values) {
              const code = (ent.properties ? ent.properties.getValue(now) : undefined)?.iso_a2;
              if (!code) continue;
              let hierarchy;
              if (ent.polygon) hierarchy = ent.polygon.hierarchy?.getValue(now);
              if (hierarchy) {
                if (!byCode[code]) byCode[code] = [];
                byCode[code].push(hierarchy);
              }
            }
            setBorders(byCode);
          } catch (err) {
            console.error("[InternationalSanctions] Failed to load borders", err);
          }
        })();
        return () => {
          alive = false;
        };
      }, [enabled]);

      function attachEntityRef(ref, geoEntity) {
        const el = ref?.cesiumElement;
        if (el && !el._wwvEntity) el._wwvEntity = geoEntity;
      }

      const shapes = useMemo(() => {
        if (!enabled || Object.keys(borders).length === 0 || self.data.length === 0) return [];
        const out = [];
        for (const e of self.data) {
          const code = e.properties.countryCode;
          const level = e.properties.level || "low";
          const base = LEVEL_COLORS[level] || LEVEL_COLORS.low;
          const fill = Color.fromCssColorString(base).withAlpha(0.65);
          const outline = Color.fromCssColorString(base).withAlpha(1);
          const height = level === "high" ? 250000 : level === "medium" ? 150000 : 75000;
          const hierarchies = borders[code];
          if (hierarchies) {
            out.push({
              id: e.id,
              name: `Sanctioned Country: ${code}`,
              geoEntity: e,
              color: fill,
              outlineColor: outline,
              height,
              hierarchies,
            });
          }
        }
        return out;
      }, [enabled, borders]);

      if (shapes.length === 0) return null;
      return jsx(Fragment, {
        children: shapes.flatMap((s) =>
          s.hierarchies.map((h, i) =>
            jsx(
              Entity,
              {
                name: s.name,
                ref: (r) => attachEntityRef(r, s.geoEntity),
                children: jsx(PolygonGraphics, {
                  hierarchy: h,
                  extrudedHeight: s.height,
                  height: 0,
                  material: s.color,
                  outline: true,
                  outlineColor: s.outlineColor,
                  closeTop: true,
                  closeBottom: false,
                }),
              },
              `${s.id}-${i}`
            )
          )
        ),
      });
    };
  }

  async initialize(ctx) {
    this.context = ctx;
  }

  destroy() {
    this.context = null;
  }

  async fetch() {
    const res = await fetch(`${engineBase()}/api/${PLUGIN_ID}`);
    if (!res.ok) throw new Error(`Engine REST HTTP ${res.status}`);
    const data = await res.json();
    this.data = extractItems(data).map(toEntity);
    return this.data;
  }

  getPollingInterval() {
    return 0;
  }

  mapWebsocketPayload(payload) {
    const mapped = extractItems(payload).map(toEntity);
    // Full snapshots replace; incremental updates merge by id (ported from original).
    const isFull = Array.isArray(payload) || (payload && payload.type === "full_sync") || (payload && payload.items);
    if (isFull) {
      this.data = mapped;
    } else {
      for (const t of mapped) {
        const idx = this.data.findIndex((d) => d.id === t.id);
        if (idx >= 0) this.data[idx] = t;
        else this.data.push(t);
      }
    }
    return mapped;
  }

  getLayerConfig() {
    return {
      color: "#ef4444",
      clusterEnabled: false,
      clusterDistance: 0,
      disableDefaultRendering: true,
      maxEntities: 5000,
    };
  }

  renderEntity() {
    // Default point rendering is disabled; the extruded polygons come from getGlobeComponent.
    return {
      type: "point",
      size: 0,
      color: "transparent",
    };
  }

  getSelectionBehavior() {
    return {
      showTrail: false,
      flyToOffsetMultiplier: 2,
      flyToBaseDistance: 5000000,
    };
  }

  getFilterDefinitions() {
    return [
      {
        id: "level",
        label: "Sanction Level",
        type: "select",
        propertyKey: "level",
        options: [
          { value: "low", label: "Low (< 50)" },
          { value: "medium", label: "Medium (50 - 500)" },
          { value: "high", label: "High (> 500)" },
        ],
      },
    ];
  }

  getLegend() {
    return [
      { label: "High (> 500)", color: LEVEL_COLORS.high, filterId: "level", filterValue: "high" },
      { label: "Medium (50 - 500)", color: LEVEL_COLORS.medium, filterId: "level", filterValue: "medium" },
      { label: "Low (< 50)", color: LEVEL_COLORS.low, filterId: "level", filterValue: "low" },
    ];
  }

  getGlobeComponent() {
    return this.GlobeComp;
  }
}
