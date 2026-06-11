import { describe, it, expect } from "vitest";
import { mergeInstalledWithLocal } from "./mergeInstalledWithLocal";

const rec = (pluginId: string, version: string) => ({
  pluginId,
  config: JSON.stringify({ id: pluginId, version }),
});

describe("mergeInstalledWithLocal", () => {
  it("lets a local sandbox plugin shadow the installed record with the same id", () => {
    // Regression: fresh-install seeding pinned npm 1.x manifests in the DB
    // while first-party 2.0.0 bundles sat in /public/plugins-local. The DB
    // record loaded first and won, so conflict layers ran stale bundles
    // without mapWebsocketPayload and rendered nothing.
    const merged = mergeInstalledWithLocal(
      [rec("civil-unrest", "1.1.15"), rec("aviation", "1.2.0")],
      [rec("civil-unrest", "2.0.0")],
    );

    const civilUnrest = merged.filter((m) => m.pluginId === "civil-unrest");
    expect(civilUnrest).toHaveLength(1);
    expect(JSON.parse(civilUnrest[0].config).version).toBe("2.0.0");
    // Non-shadowed records pass through untouched.
    expect(merged.map((m) => m.pluginId)).toContain("aviation");
  });

  it("returns records unchanged when there are no local plugins", () => {
    const records = [rec("aviation", "1.2.0")];
    expect(mergeInstalledWithLocal(records, [])).toEqual(records);
  });

  it("includes local-only plugins that have no installed record", () => {
    const merged = mergeInstalledWithLocal(
      [rec("aviation", "1.2.0")],
      [rec("brand-new", "0.0.1")],
    );
    expect(merged.map((m) => m.pluginId)).toEqual(["aviation", "brand-new"]);
  });
});
