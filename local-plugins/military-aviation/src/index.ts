// military-aviation — first-party frontend plugin for the local adsb.lol seeder.
// Replaces @worldwideview/wwv-plugin-military-aviation: same rendering behavior, but
// REST fetch targets our engine's snapshot endpoint, and the WS/REST handlers accept
// bare-array, {items: array}, {items: keyed object} and wrapper shapes.

const PLUGIN_ID = "military-aviation";

function engineBase() {
  if (typeof window === "undefined") return "http://localhost:5000";
  return `${window.location.protocol}//${window.location.hostname}:5000`;
}

// feet -> meters (matches original bundle's L())
function ftToM(ft) {
  return ft * 0.3048;
}

function altitudeColor(altM) {
  // Original computes color from feet derived from meters.
  const ft = altM === null ? null : altM / 0.3048;
  if (ft === null || ft <= 0) return "#39ff14";
  if (ft < 1e4) return "#ff6f00";
  if (ft < 25e3) return "#ff1744";
  if (ft < 4e4) return "#ff4081";
  return "#ffea00";
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.items && typeof payload.items === "object") return Object.values(payload.items);
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

function toEntity(ac) {
  if (ac == null || ac.lat == null || ac.lon == null) return null;
  const altFt = typeof ac.alt_baro === "number" ? ac.alt_baro : null;
  const altM = altFt === null ? null : ftToM(altFt);
  const onGround = ac.alt_baro === "ground";
  return {
    id: `military-aviation-${ac.hex}`,
    pluginId: PLUGIN_ID,
    latitude: ac.lat,
    longitude: ac.lon,
    altitude: altM === null ? 0 : altM * 10, // exaggerated for visibility, matches original
    heading: ac.track ?? undefined,
    speed: ac.gs ?? undefined,
    timestamp: new Date(),
    label: ac.flight?.trim() || ac.r || ac.hex,
    properties: {
      hex: ac.hex,
      callsign: ac.flight?.trim() || null,
      registration: ac.r || null,
      aircraft_type: ac.t || null,
      altitude_ft: altFt,
      altitude_m: altM,
      ground_speed_kts: ac.gs ?? null,
      heading: ac.track ?? null,
      squawk: ac.squawk || null,
      on_ground: onGround,
      category: ac.category || null,
      emergency: ac.emergency || null,
      history: ac.history || [],
    },
  };
}

export default class MilitaryAviationPlugin {
  id = PLUGIN_ID;
  name = "Military Aviation";
  description = "Real-time military aircraft tracking via adsb.lol";
  icon = "🛡️";
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
    return 0; // WS-driven; initial REST fetch only
  }

  getLayerConfig() {
    return {
      color: "#ff6f00",
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
      iconUrl: "/military-plane-icon.svg",
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
      trailColor: "#ffea00",
      flyToOffsetMultiplier: 3,
      flyToBaseDistance: 30000,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getLegend() {
    return [
      { label: "0 ft (Surface)", color: "#39ff14" },
      { label: "< 10,000 ft", color: "#ff6f00" },
      { label: "10,000 - 25,000 ft", color: "#ff1744" },
      { label: "25,000 - 40,000 ft", color: "#ff4081" },
      { label: "> 40,000 ft", color: "#ffea00" },
    ];
  }

  getFilterDefinitions() {
    return [
      { id: "aircraft_type", label: "Aircraft Type", type: "text", propertyKey: "aircraft_type" },
      { id: "callsign", label: "Callsign", type: "text", propertyKey: "callsign" },
      { id: "registration", label: "Registration", type: "text", propertyKey: "registration" },
      {
        id: "altitude",
        label: "Altitude (ft)",
        type: "range",
        propertyKey: "altitude_ft",
        range: { min: 0, max: 60000, step: 1000 },
      },
      { id: "on_ground", label: "On Ground", type: "boolean", propertyKey: "on_ground" },
    ];
  }
}
