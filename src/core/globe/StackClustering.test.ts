import {
 describe, it, expect, vi, beforeEach
} from "vitest";
import type { AnimatableItem } from "./EntityRenderer";

// Mutable flag the mocked store reads at call time.
let clusteringEnabled = true;

vi.mock("@/core/plugins/PluginManager", () => ({
    pluginManager: {
        getPlugin: vi.fn(() => ({
            plugin: { getLayerConfig: () => ({ clusterEnabled: true }) },
        })),
    },
}));

vi.mock("@/core/state/store", () => ({
    useStore: {
        getState: () => ({
            dataConfig: { experimentalFeatures: { clusteringEnabled } },
        }),
    },
}));

import { computeGroups } from "./StackClustering";

function item(id: string, pluginId: string, lat: number, lon: number): AnimatableItem {
    return {
        entity: {
 id, pluginId, latitude: lat, longitude: lon, timestamp: new Date(), properties: {}
},
        options: { type: "point" },
    } as unknown as AnimatableItem;
}

describe("computeGroups — global experimental clustering toggle", () => {
    beforeEach(() => {
        clusteringEnabled = true;
    });

    it("groups nearby entities when clustering is enabled", () => {
        const map = new Map<string, AnimatableItem>([
            ["a", item("a", "p", 10, 10)],
            ["b", item("b", "p", 10.0001, 10.0001)],
        ]);
        const groups = computeGroups(map, 0.01);
        expect([...groups.values()].some((g) => g.length >= 2)).toBe(true);
    });

    it("returns no groups when the experimental clustering toggle is off", () => {
        clusteringEnabled = false;
        const map = new Map<string, AnimatableItem>([
            ["a", item("a", "p", 10, 10)],
            ["b", item("b", "p", 10.0001, 10.0001)],
        ]);
        const groups = computeGroups(map, 0.01);
        expect(groups.size).toBe(0);
    });
});
