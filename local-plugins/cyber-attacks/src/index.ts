// cyber-attacks — first-party frontend plugin for the local AlienVault OTX seeder.
// Replaces @worldwideview/wwv-plugin-cyber-attacks@2.0.17: same entity mapping,
// rendering, filters and legend, but REST fetch targets our engine snapshot endpoint
// (no cloud-only ?start/&end history API), and the WS handler accepts bare-array,
// {items}, and wrapper {source, fetchedAt, items} shapes.

const PLUGIN_ID = "cyber-attacks";

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

// Threat type -> color, ported verbatim from the original bundle.
const THREAT_COLORS = {
  APT: "#dc2626",
  Ransomware: "#f97316",
  Botnet: "#a855f7",
  Phishing: "#eab308",
  DDoS: "#3b82f6",
  Malware: "#ef4444",
  "C2 Server": "#14b8a6",
  Other: "#6b7280",
};

// The original tinted a per-threat Lucide glyph via the host SDK's createSvgIconUrl().
// We are dependency-free, so we inline the same glyphs as colored data-URIs, cached per
// threat+color. SVG path data copied verbatim from the original bundle's Lucide icons:
//   APT -> Skull, Ransomware -> Zap, Botnet -> Radio, Phishing -> Fish,
//   DDoS -> ShieldAlert, Malware -> Bug, C2 Server -> Server, Other -> CircleHelp.
const THREAT_ICON_PATHS = {
  APT: [
    '<circle cx="9" cy="12" r="1"/>',
    '<circle cx="15" cy="12" r="1"/>',
    '<path d="M8 20v2h8v-2"/>',
    '<path d="m12.5 17-.5-1-.5 1h1z"/>',
    '<path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
  ],
  Ransomware: [
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  ],
  Botnet: [
    '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/>',
    '<path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/>',
    '<circle cx="12" cy="12" r="2"/>',
    '<path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/>',
    '<path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  ],
  Phishing: [
    '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/>',
    '<path d="M18 12v.5"/>',
    '<path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/>',
    '<path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/>',
    '<path d="M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"/>',
    '<path d="m16.01 17.93-.23 1.4A2 2 0 0 1 13.8 21H9.5a5.96 5.96 0 0 0 1.49-3.98"/>',
  ],
  DDoS: [
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    '<path d="M12 8v4"/>',
    '<path d="M12 16h.01"/>',
  ],
  Malware: [
    '<path d="m8 2 1.88 1.88"/>',
    '<path d="M14.12 3.88 16 2"/>',
    '<path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>',
    '<path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>',
    '<path d="M12 20v-9"/>',
    '<path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>',
    '<path d="M6 13H2"/>',
    '<path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>',
    '<path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>',
    '<path d="M22 13h-4"/>',
    '<path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  ],
  "C2 Server": [
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/>',
    '<rect width="20" height="8" x="2" y="14" rx="2" ry="2"/>',
    '<line x1="6" x2="6.01" y1="6" y2="6"/>',
    '<line x1="6" x2="6.01" y1="18" y2="18"/>',
  ],
  Other: [
    '<circle cx="12" cy="12" r="10"/>',
    '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>',
    '<path d="M12 17h.01"/>',
  ],
};

const _iconCache = {};
function threatIconUrl(threatType, color) {
  const key = `${threatType}-${color}`;
  if (_iconCache[key]) return _iconCache[key];
  const paths = (THREAT_ICON_PATHS[threatType] || THREAT_ICON_PATHS.Other).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  _iconCache[key] = url;
  return url;
}

function toEntity(e) {
  if (e == null || typeof e.lat !== "number" || typeof e.lon !== "number") return null;
  return {
    id: e.id,
    pluginId: PLUGIN_ID,
    latitude: e.lat,
    longitude: e.lon,
    timestamp: new Date(e.pulseModified || Date.now()),
    label: `${e.threatType}: ${e.ip}`,
    properties: {
      ip: e.ip,
      country: e.country,
      city: e.city,
      threatType: e.threatType,
      adversary: e.adversary,
      pulseName: e.pulseName,
      pulseDescription: e.pulseDescription,
      malwareFamilies: (e.malwareFamilies || []).join(", "),
      tags: (e.tags || []).join(", "),
      targetedCountries: (e.targetedCountries || []).join(", "),
      pulseUrl: `https://otx.alienvault.com/pulse/${e.pulseId}`,
    },
  };
}

export default class CyberAttacksPlugin {
  id = PLUGIN_ID;
  name = "Cyber Threats (OTX)";
  description = "Active threat campaigns from AlienVault Open Threat Exchange";
  icon = "🛡️";
  category = "cyber";
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
      color: "#ef4444",
      clusterEnabled: true,
      clusterDistance: 35,
      maxEntities: 5000,
    };
  }

  renderEntity(entity) {
    const threatType = entity.properties.threatType || "Other";
    const color = THREAT_COLORS[threatType] || THREAT_COLORS.Other;
    return {
      type: "billboard",
      iconUrl: threatIconUrl(threatType, color),
      color,
      iconScale: 0.7,
    };
  }

  getSelectionBehavior() {
    return {
      showTrail: false,
      flyToOffsetMultiplier: 2,
      flyToBaseDistance: 800000,
    };
  }

  mapWebsocketPayload(payload) {
    return extractItems(payload).map(toEntity).filter(Boolean);
  }

  getFilterDefinitions() {
    return [
      {
        id: "threatType",
        label: "Threat Type",
        type: "select",
        propertyKey: "threatType",
        options: Object.keys(THREAT_COLORS).map((t) => ({ value: t, label: t })),
      },
      {
        id: "country",
        label: "Country",
        type: "text",
        propertyKey: "country",
      },
      {
        id: "adversary",
        label: "Threat Actor",
        type: "text",
        propertyKey: "adversary",
      },
    ];
  }

  getLegend() {
    return Object.entries(THREAT_COLORS).map(([label, color]) => ({
      label,
      color,
      filterId: "threatType",
      filterValue: label,
    }));
  }
}
