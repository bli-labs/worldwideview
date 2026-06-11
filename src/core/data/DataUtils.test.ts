/* eslint-disable @typescript-eslint/no-explicit-any */
import {
 describe, it, expect, vi, beforeEach, afterEach
} from "vitest";
import { pluginManager } from "@/core/plugins/PluginManager";
import { fetchLocalEngineManifest, localEngineHasPlugin, resetManifestCache } from "./engineManifest";
import { resolveEngineUrl } from "./resolveEngineUrl";

// Mock PluginManager
vi.mock("@/core/plugins/PluginManager", () => ({
  pluginManager: {
    getPlugin: vi.fn(),
    getManifest: vi.fn(),
  },
}));

describe("EngineManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManifestCache();
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should fetch manifest from local engine and cache it", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: ["plugin-a", "plugin-b"] }),
    });

    const plugins = await fetchLocalEngineManifest();
    expect(plugins).toEqual(["plugin-a", "plugin-b"]);
    expect(localEngineHasPlugin("plugin-a")).toBe(true);
    expect(localEngineHasPlugin("plugin-c")).toBe(false);

    // Second call should used cache
    await fetchLocalEngineManifest();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries within one probe so a transient boot race still detects the engine", async () => {
    // Regression: the first attempt aborting during a cold `next dev` boot
    // used to be cached as "no local engine" for the whole session.
    vi.useFakeTimers();
    (global.fetch as any)
      .mockRejectedValueOnce(new Error("This operation was aborted"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ plugins: ["plugin-a"] }),
      });

    const promise = fetchLocalEngineManifest();
    await vi.advanceTimersByTimeAsync(1500); // past one retry delay
    expect(await promise).toEqual(["plugin-a"]);
    expect(localEngineHasPlugin("plugin-a")).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: ["plugin-a"] }),
    });

    const [a, b] = await Promise.all([
      fetchLocalEngineManifest(),
      fetchLocalEngineManifest(),
    ]);
    expect(a).toEqual(["plugin-a"]);
    expect(b).toEqual(["plugin-a"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("cools down after a failed probe, then re-probes instead of failing forever", async () => {
    vi.useFakeTimers();
    (global.fetch as any).mockRejectedValue(new Error("Connection refused"));

    const promise = fetchLocalEngineManifest();
    await vi.advanceTimersByTimeAsync(3000); // exhaust all retry attempts
    expect(await promise).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // Within the cooldown: cached failure, no new fetches.
    expect(await fetchLocalEngineManifest()).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3);

    // After the cooldown: probes again (and can now succeed).
    await vi.advanceTimersByTimeAsync(31_000);
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: ["plugin-a"] }),
    });
    expect(await fetchLocalEngineManifest()).toEqual(["plugin-a"]);
  });

  it("kicks a background probe from localEngineHasPlugin when nothing is cached", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: ["plugin-a"] }),
    });

    expect(localEngineHasPlugin("plugin-a")).toBe(false); // not detected yet
    await new Promise(resolve => setTimeout(resolve, 0)); // let the probe settle
    expect(localEngineHasPlugin("plugin-a")).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEngineUrl", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetManifestCache();
    // Pre-cache an empty manifest: the engine is "known" with no plugins, so
    // localEngineHasPlugin answers from cache and never spawns a background
    // probe that could leak across tests.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: [] }),
    }) as any;
    await fetchLocalEngineManifest();
  });

  it("should prioritize local engine if plugin is found there", async () => {
    // Replace the cached empty manifest with one that has the plugin.
    resetManifestCache();
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ plugins: ["plugin-local"] }),
    });
    await fetchLocalEngineManifest();

    const url = resolveEngineUrl("plugin-local");
    expect(url).toContain("localhost:5000/stream");
  });

  it("should fall back to plugin's custom streamUrl if not local", () => {
    (pluginManager.getPlugin as any).mockReturnValue({
      plugin: {
        getServerConfig: () => ({ streamUrl: "ws://custom-engine/stream" })
      }
    });

    const url = resolveEngineUrl("plugin-custom");
    expect(url).toBe("ws://custom-engine/stream");
  });

  it("should fall back to manifest streamUrl if provided", () => {
    (pluginManager.getPlugin as any).mockReturnValue(undefined);
    (pluginManager.getManifest as any).mockReturnValue({
      dataSource: { streamUrl: "ws://manifest-engine/stream" }
    });

    const url = resolveEngineUrl("plugin-manifest");
    expect(url).toBe("ws://manifest-engine/stream");
  });

  it("should use default cloud engine as last resort", () => {
    (pluginManager.getPlugin as any).mockReturnValue(undefined);
    (pluginManager.getManifest as any).mockReturnValue(undefined);

    const url = resolveEngineUrl("unknown-plugin");
    expect(url).toContain("worldwideview.dev/stream");
  });
});
