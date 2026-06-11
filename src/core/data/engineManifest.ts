// src/core/data/engineManifest.ts
// Fetches /manifest from a local data engine to discover available seeders.
// Used by resolveEngineUrl for per-plugin local vs cloud routing.

let localManifest: string[] | null = null;
let inFlightProbe: Promise<string[] | null> | null = null;
let lastFailureAt: number | null = null;

// A cold `next dev` boot can starve a localhost fetch well past 500ms, and
// that false negative used to be cached forever — every engine-backed plugin
// then routed to the cloud URL for the whole session (observed 2026-06-10 as
// a wall of dataenginev2 404s with a healthy engine on localhost).
const PROBE_TIMEOUT_MS = 2000;
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 1000;
// A failed probe is cached only briefly: a plugin toggle costs nothing while
// the cooldown holds, and the next call after it re-probes instead of
// assuming the engine is gone for good.
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * Resolve the base URL of the local data engine.
 *
 * Always checks localhost:5000 — the port docker-compose.yml binds for
 * wwv-data-engine. NEXT_PUBLIC_WWV_PLUGIN_DATA_ENGINE_URL is intentionally
 * NOT used here: that variable belongs to each plugin's own declared engine
 * URL (production, third-party, etc.) and must not poison local detection.
 * Mixing the two caused the production engine to be reported as "local".
 */
function getLocalEngineBase() {
    const port = process.env.NEXT_PUBLIC_WWV_LOCAL_ENGINE_PORT || '5000';
    if (typeof window === "undefined") return `http://localhost:${port}`;
    return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

async function probeOnce(): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${getLocalEngineBase()}/manifest`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`manifest responded HTTP ${res.status}`);
    const data = await res.json();
    return data.plugins || [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the list of available seeders from a local engine.
 *
 * A successful result is cached for the session. A failure is retried up to
 * PROBE_ATTEMPTS times within the call (the boot race that aborts the first
 * attempt is over within seconds), then cached only for FAILURE_COOLDOWN_MS.
 * Concurrent callers share one in-flight probe, so plugins loading in
 * parallel during boot all see the same answer.
 *
 * The engine guarantees manifest IDs are already in kebab-case (the seeder's
 * exported `name` field is the canonical plugin ID). No client-side translation
 * is needed — what the engine reports is what the frontend uses.
 */
export async function fetchLocalEngineManifest(): Promise<string[] | null> {
  if (localManifest) return localManifest;
  if (lastFailureAt !== null && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    return null;
  }
  if (inFlightProbe) return inFlightProbe;

  inFlightProbe = (async () => {
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      try {
        const plugins = await probeOnce();
        localManifest = plugins;
        lastFailureAt = null;
        console.log(
          `[EngineManifest] Local engine detected: ${plugins.length} seeders`,
          plugins
        );
        return plugins;
      } catch {
        if (attempt < PROBE_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
        }
      }
    }
    lastFailureAt = Date.now();
    console.log(
      `[EngineManifest] No local engine detected after ${PROBE_ATTEMPTS} attempts — using cloud, will re-probe after ${FAILURE_COOLDOWN_MS / 1000}s.`
    );
    return null;
  })();

  try {
    return await inFlightProbe;
  } finally {
    inFlightProbe = null;
  }
}

/**
 * Check if the local engine has a seeder for a given plugin ID.
 *
 * Stays synchronous for resolveEngineUrl. When no manifest is cached it
 * answers false immediately but kicks a background re-probe (a no-op while
 * the failure cooldown holds or a probe is in flight), so a toggle made
 * before the engine was detected heals on the next connection.
 */
export function localEngineHasPlugin(pluginId: string): boolean {
  if (!localManifest) {
    void fetchLocalEngineManifest();
    return false;
  }
  return localManifest.includes(pluginId);
}

/** Reset the cache (for testing or reconnection). */
export function resetManifestCache(): void {
  localManifest = null;
  inFlightProbe = null;
  lastFailureAt = null;
}
