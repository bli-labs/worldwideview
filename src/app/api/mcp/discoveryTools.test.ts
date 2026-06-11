import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/data-query/service");
vi.mock("@/lib/globeStateStore");
vi.mock("@/lib/mcpSessionCatalog");
vi.mock("@/lib/globeCommandQueue");
vi.mock("@/lib/nominatim", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/nominatim")>();
    return {
        ...actual,
        fetchGeocode: vi.fn(),
    };
});

import { getAllPluginSnapshots, getEntitiesInRegion } from "@/lib/data-query/service";
import { readActiveSessions, readGlobeState } from "@/lib/globeStateStore";
import { readSessionCatalog } from "@/lib/mcpSessionCatalog";
import { resolveActiveSessionId, enqueueGlobeCommand } from "@/lib/globeCommandQueue";
import { fetchGeocode } from "@/lib/nominatim";
import { registerDiscoveryTools } from "./discoveryTools";

const mockGetAllSnapshots = vi.mocked(getAllPluginSnapshots);
const mockGetEntitiesInRegion = vi.mocked(getEntitiesInRegion);
const mockReadActiveSessions = vi.mocked(readActiveSessions);
const mockReadGlobeState = vi.mocked(readGlobeState);
const mockReadSessionCatalog = vi.mocked(readSessionCatalog);
const mockResolveActiveSessionId = vi.mocked(resolveActiveSessionId);
const mockEnqueueGlobeCommand = vi.mocked(enqueueGlobeCommand);
const mockFetchGeocode = vi.mocked(fetchGeocode);

// ---------------------------------------------------------------------------
// Minimal fake server that captures handlers
// ---------------------------------------------------------------------------
const handlers: Record<string, (args: unknown) => unknown> = {};
const schemas: Record<string, { description: string }> = {};
const mockServer = {
    registerTool: vi.fn(
        (name: string, schema: { description: string }, handler: (args: unknown) => unknown) => {
            handlers[name] = handler;
            schemas[name] = schema;
        },
    ),
};

const ctx = { userId: "user-test-1" };

function textOf(result: unknown): string {
    return (result as { content: Array<{ text: string }> }).content[0].text;
}

function parsedOf(result: unknown): unknown {
    return JSON.parse(textOf(result));
}

// Re-usable geocode response fixture (Auckland, NZ)
const aucklandGeoRaw = {
    lat: "-36.8485",
    lon: "174.7633",
    name: "Auckland",
    display_name: "Auckland, Auckland, New Zealand",
    boundingbox: ["-37.0", "-36.5", "174.5", "175.0"] as [string, string, string, string],
    importance: 0.8,
    address: { country: "New Zealand" },
    namedetails: { "name:en": "Auckland" },
    type: "city",
    addresstype: "place",
};

beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    Object.keys(schemas).forEach((k) => delete schemas[k]);

    // Defaults -- individual tests override as needed
    mockGetAllSnapshots.mockResolvedValue([]);
    mockGetEntitiesInRegion.mockResolvedValue({ entities: [], emptyReason: "no_data_matches" });
    mockReadActiveSessions.mockResolvedValue([]);
    mockReadGlobeState.mockResolvedValue(null);
    mockReadSessionCatalog.mockResolvedValue(null);
    mockResolveActiveSessionId.mockResolvedValue(null);
    mockEnqueueGlobeCommand.mockResolvedValue(undefined);
    mockFetchGeocode.mockResolvedValue([aucklandGeoRaw]);

    registerDiscoveryTools(mockServer as never, ctx);
});

// ---------------------------------------------------------------------------
// list_available_plugins
// ---------------------------------------------------------------------------
describe("list_available_plugins", () => {
    it("registers the tool with a non-empty description containing Example:", () => {
        expect(schemas["list_available_plugins"].description.length).toBeGreaterThan(0);
        expect(schemas["list_available_plugins"].description).toContain("Example:");
    });

    it("returns plugin list with counts and entityTypes when streaming", async () => {
        mockGetAllSnapshots.mockResolvedValue([
            {
                pluginId: "flights",
                entities: [
                    { id: "e1", pluginId: "flights", latitude: 0, longitude: 0, timestamp: new Date(), properties: { status: "airborne" } },
                    { id: "e2", pluginId: "flights", latitude: 1, longitude: 1, timestamp: new Date(), properties: { status: "landed" } },
                ],
                timestamp: new Date(),
            },
        ]);

        const result = await handlers["list_available_plugins"]({});
        const parsed = parsedOf(result) as { plugins: Array<{ pluginId: string; entityCount: number; entityTypes: string[] }> };

        expect(parsed.plugins).toHaveLength(1);
        expect(parsed.plugins[0].pluginId).toBe("flights");
        expect(parsed.plugins[0].entityCount).toBe(2);
        expect(parsed.plugins[0].entityTypes).toContain("status");
    });

    it("returns { plugins: [], reason: 'engine_unreachable' } when engine is down (TOOL-05)", async () => {
        // Stub the probe fetch to fail: the test must not depend on whether a
        // real engine happens to be listening on this machine.
        const savedFetch = global.fetch;
        global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
        try {
            mockGetAllSnapshots.mockResolvedValue([]);

            const result = await handlers["list_available_plugins"]({});
            const parsed = parsedOf(result) as { plugins: unknown[]; reason: string };

            expect(parsed.plugins).toHaveLength(0);
            expect(parsed.reason).toBe("engine_unreachable");
        } finally {
            global.fetch = savedFetch;
        }
    });
});

// ---------------------------------------------------------------------------
// get_globe_context
// ---------------------------------------------------------------------------
describe("get_globe_context", () => {
    it("returns sessionCount:0 + camera:null when no active sessions", async () => {
        mockReadActiveSessions.mockResolvedValue([]);
        mockGetAllSnapshots.mockResolvedValue([]);

        const result = await handlers["get_globe_context"]({});
        const parsed = parsedOf(result) as { sessionCount: number; camera: null; layers: Record<string, unknown>; plugins: unknown[] };

        expect(parsed.sessionCount).toBe(0);
        expect(parsed.camera).toBeNull();
        expect(parsed.layers).toEqual({});
    });

    it("returns sessionCount + camera + layers when session active", async () => {
        mockReadActiveSessions.mockResolvedValue([{ sessionId: "sess-1", lastSeen: Date.now() }]);
        mockGetAllSnapshots.mockResolvedValue([
            {
                pluginId: "maritime",
                entities: [],
                timestamp: new Date(),
            },
        ]);
        mockReadGlobeState.mockResolvedValue({
            viewport: { lat: -36.8, lon: 174.7, altitude: 500000, heading: 0, pitch: -45, roll: 0 },
            layers: { maritime: { enabled: true } as never },
            timeline: { currentTime: "2026-01-01T00:00:00Z", timeWindow: "1h", isPlaybackMode: false, playbackTime: 0, playbackSpeed: 1 },
            selectedEntity: null,
            lastUpdate: Date.now(),
        });
        mockReadSessionCatalog.mockResolvedValue({ tools: [], capabilities: [] });

        const result = await handlers["get_globe_context"]({});
        const parsed = parsedOf(result) as { sessionCount: number; camera: { lat: number } | null; layers: Record<string, unknown>; plugins: unknown[] };

        expect(parsed.sessionCount).toBe(1);
        expect(parsed.camera).not.toBeNull();
        expect(parsed.camera?.lat).toBeCloseTo(-36.8);
        expect(parsed.layers).toHaveProperty("maritime");
    });

    it("includes a filters field with a note about server-tracking limitations", async () => {
        mockReadActiveSessions.mockResolvedValue([]);
        mockGetAllSnapshots.mockResolvedValue([]);

        const result = await handlers["get_globe_context"]({});
        const parsed = parsedOf(result) as { filters: { note: string } };

        expect(parsed.filters.note).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// investigate_area
// ---------------------------------------------------------------------------
describe("investigate_area", () => {
    it("happy path: returns entities + summary with count when plugin matches and data found", async () => {
        mockGetAllSnapshots.mockResolvedValue([
            {
                pluginId: "flights",
                entities: [],
                timestamp: new Date(),
            },
        ]);
        mockGetEntitiesInRegion.mockResolvedValue({
            entities: [
                { id: "f1", pluginId: "flights", latitude: -36.8, longitude: 174.7 },
                { id: "f2", pluginId: "flights", latitude: -36.9, longitude: 174.6 },
            ],
        });
        mockResolveActiveSessionId.mockResolvedValue("sess-1");

        const result = await handlers["investigate_area"]({ place_name: "Auckland", entity_type: "flights" });
        const parsed = parsedOf(result) as { entities: unknown[]; summary: string };

        expect(parsed.entities).toHaveLength(2);
        expect(parsed.summary.length).toBeGreaterThan(0);
        expect(parsed.summary).toContain("2");
        expect(mockEnqueueGlobeCommand).toHaveBeenCalledWith("user-test-1", "sess-1", expect.objectContaining({ type: "pan" }));
    });

    it("no-matching-plugin: returns empty entities + prose explaining missing entity_type", async () => {
        mockGetAllSnapshots.mockResolvedValue([
            { pluginId: "maritime", entities: [], timestamp: new Date() },
        ]);

        const result = await handlers["investigate_area"]({ place_name: "Auckland", entity_type: "submarines" });
        const parsed = parsedOf(result) as { entities: unknown[]; summary: string };

        expect(parsed.entities).toHaveLength(0);
        expect(parsed.summary).toContain("submarines");
        expect(parsed.summary).toContain("list_available_plugins");
        expect(mockEnqueueGlobeCommand).not.toHaveBeenCalled();
    });

    it("no-data-matches: returns empty entities + prose explaining empty result", async () => {
        mockGetAllSnapshots.mockResolvedValue([
            { pluginId: "flights", entities: [], timestamp: new Date() },
        ]);
        mockGetEntitiesInRegion.mockResolvedValue({ entities: [], emptyReason: "no_data_matches" });
        mockResolveActiveSessionId.mockResolvedValue("sess-1");

        const result = await handlers["investigate_area"]({ place_name: "Auckland", entity_type: "flights" });
        const parsed = parsedOf(result) as { entities: unknown[]; summary: string };

        expect(parsed.entities).toHaveLength(0);
        expect(parsed.summary.length).toBeGreaterThan(0);
    });

    it("no-session: returns entities but does NOT call enqueueGlobeCommand; summary notes skip", async () => {
        mockGetAllSnapshots.mockResolvedValue([
            { pluginId: "flights", entities: [], timestamp: new Date() },
        ]);
        mockGetEntitiesInRegion.mockResolvedValue({
            entities: [{ id: "f1", pluginId: "flights", latitude: -36.8, longitude: 174.7 }],
        });
        mockResolveActiveSessionId.mockResolvedValue(null); // no active session

        const result = await handlers["investigate_area"]({ place_name: "Auckland", entity_type: "flights" });
        const parsed = parsedOf(result) as { entities: unknown[]; summary: string };

        expect(parsed.entities).toHaveLength(1);
        expect(mockEnqueueGlobeCommand).not.toHaveBeenCalled();
        expect(parsed.summary).toContain("camera pan skipped");
    });

    it("geocode failure: returns empty entities + helpful summary", async () => {
        mockFetchGeocode.mockResolvedValue([]);

        const result = await handlers["investigate_area"]({ place_name: "ZZZ_NONEXISTENT", entity_type: "flights" });
        const parsed = parsedOf(result) as { entities: unknown[]; summary: string };

        expect(parsed.entities).toHaveLength(0);
        expect(parsed.summary).toContain("ZZZ_NONEXISTENT");
    });

    it("truncation (TOOL-04/P33): returns truncated:true and cappedTotal when result exceeds 200 cap", async () => {
        // Two plugins both named with "vessel" substring so entity_type:"vessel" matches both.
        // Each returns 110 entities = 220 total, exceeding INVESTIGATE_AREA_CAP (200).
        const makeEntities = (pluginId: string, count: number) =>
            Array.from({ length: count }, (_, i) => ({
                id: `${pluginId}-${i}`,
                pluginId,
                latitude: 0,
                longitude: 0,
            }));

        mockGetAllSnapshots.mockResolvedValue([
            { pluginId: "vessel-ais", entities: [], timestamp: new Date() },
            { pluginId: "vessel-cargo", entities: [], timestamp: new Date() },
        ]);
        mockGetEntitiesInRegion
            .mockResolvedValueOnce({ entities: makeEntities("vessel-ais", 110) })
            .mockResolvedValueOnce({ entities: makeEntities("vessel-cargo", 110) });
        mockResolveActiveSessionId.mockResolvedValue(null);

        const result = await handlers["investigate_area"]({
            place_name: "Auckland",
            entity_type: "vessel",
        });
        const parsed = parsedOf(result) as {
            entities: unknown[];
            count: number;
            truncated?: boolean;
            cappedTotal?: number;
            summary: string;
        };

        expect(parsed.entities).toHaveLength(200);
        expect(parsed.count).toBe(200);
        expect(parsed.truncated).toBe(true);
        expect(parsed.cappedTotal).toBe(220);
    });
});
