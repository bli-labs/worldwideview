/**
 * GET / POST / DELETE /api/mcp
 *
 * Stateless Streamable HTTP MCP endpoint (Phase 17).
 *
 * Gate ordering (D-17-05, MCP-04):
 *   1. Edition check — isDemo → 403 JSON-RPC error (runs BEFORE auth)
 *   2. Bearer auth   — authenticateApiKey() → 401 JSON-RPC error on failure
 *   3. Fresh McpServer + transport per request (D-17-04, MCP-05)
 *   4. Delegate to transport.handleRequest() → streaming Response
 *
 * STATELESS INVARIANT (D-17-04): McpServer and WebStandardStreamableHTTPServerTransport
 * are constructed INSIDE the handler on every request and NEVER cached at module
 * scope. Do NOT hoist server/transport creation outside of handleMcpRequest().
 * A module-level singleton would bind the transport to a prior request context,
 * causing all subsequent requests to fail silently (Pitfall 2).
 *
 * Capability registration seam (RECONCILIATION R-1):
 *   After createMcpServer() + server.connect(transport) and BEFORE
 *   transport.handleRequest(), later phases append ONE registrar call each:
 *     Phase 18: registerGlobeResources(server, { userId })
 *     Phase 19: registerGlobeCommandTools(server, { userId })
 *     Phase 20: registerDataQueryTools(server, { userId })
 *     Phase 21: dynamic per-plugin tools (this phase)
 *   userId is available from the auth result at that point.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isDemo } from "@/core/edition";
import { authenticateApiKey } from "@/lib/apiKeyAuth";
import { createMcpServer } from "@/lib/mcp/server";
import { registerCapabilities } from "@/lib/mcp/registerCapabilities";
import { mcpLimiter, getClientIp } from "@/lib/rateLimiters";
import { redisSlidingWindow } from "@/lib/geocodingRateLimit";
import {
    demoBlockedResponse,
    unauthorizedResponse,
    rateLimitedResponse,
    internalErrorResponse,
} from "@/lib/mcp/mcpResponseHelpers";

// ---------------------------------------------------------------------------
// Route segment config (TRANS-03)
// 30 s is comfortably above the 10 s blpop ceiling in RELAY_DEADLINE_MS so the
// function never times out mid-relay. Vercel/Coolify honour this value.
// ---------------------------------------------------------------------------

export const maxDuration = 30;

// Per-key rate-limit budget (SEC-02): 120 requests per 60-second window.
const MCP_KEY_LIMIT = 120;
const MCP_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Header merge helper
// ---------------------------------------------------------------------------

/**
 * Ensures X-Accel-Buffering: no (and Cache-Control: no-cache, no-transform)
 * are present on the response without clobbering the SDK's Content-Type or
 * buffering the response body into memory (Pitfall 1 / D-17-06 / MCP-06).
 *
 * We clone the response headers, add the missing headers, then return a new
 * Response that streams the original body.
 */
function withStreamingHeaders(sdkResponse: Response): Response {
    const headers = new Headers(sdkResponse.headers);
    headers.set("X-Accel-Buffering", "no");
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("Connection", "keep-alive");
    return new Response(sdkResponse.body, {
        status: sdkResponse.status,
        statusText: sdkResponse.statusText,
        headers,
    });
}

// ---------------------------------------------------------------------------
// Core handler — all three methods delegate here
// ---------------------------------------------------------------------------

async function handleMcpRequest(request: Request): Promise<Response> {
    // ------------------------------------------------------------------
    // Gate 0: Rate limit (H1) — runs BEFORE edition check and auth so
    // scanners never reach the DB layer.
    // ------------------------------------------------------------------
    const ipLimitResult = mcpLimiter.check(getClientIp(request));
    if (ipLimitResult) return ipLimitResult;

    // ------------------------------------------------------------------
    // Gate 1: Edition check (D-17-05, MCP-04)
    // Must run BEFORE authenticateApiKey so demo edition never reaches
    // the auth/DB layer (avoids demo-admin FK write — Pitfall 5).
    // ------------------------------------------------------------------
    if (isDemo) {
        return demoBlockedResponse();
    }

    // ------------------------------------------------------------------
    // Gate 2: Bearer auth (D-17-03, MCP-03)
    // authenticateApiKey() reads Authorization header; never throws.
    // ------------------------------------------------------------------
    const authResult = await authenticateApiKey(request);
    if (!authResult) {
        console.warn("[mcp] unauthorized request");
        return unauthorizedResponse();
    }

    // ------------------------------------------------------------------
    // Gate 3: Redis per-key rate limit (SEC-02).
    // 120 req / 60s per authenticated key, complementing the coarse IP
    // gate above. Fails OPEN on Redis outage so a broken Redis never
    // blocks legit users.
    // ------------------------------------------------------------------
    const keyRateKey = `mcp:ratelimit:key:${authResult.keyId}`;
    const keyLimit = await redisSlidingWindow(keyRateKey, MCP_KEY_LIMIT, MCP_WINDOW_MS);
    if (!keyLimit.allowed) {
        return rateLimitedResponse(keyLimit.retryAfterMs);
    }

    // ------------------------------------------------------------------
    // Build a FRESH server + transport per request (D-17-04, MCP-05).
    // STATELESS INVARIANT: never hoist these to module scope.
    // Do NOT cache server or transport between requests.
    // ------------------------------------------------------------------
    const server = createMcpServer();

    // Registration seam (RECONCILIATION R-1):
    // Phase 18: globe resources
    // Phase 19: globe command tools
    // Phase 20: data query tools
    // Phase 21: dynamic per-session plugin tools (below)
    //   Phase 22: registerGeocodingTools, registerFavoritesTools
    //   Phase 23: registerFilterTools (set_filter, clear_filter, get_plugin_filters)
    // Shared with /api/agent/mcp (the voice agent's session-authed twin):
    // resources, data query, globe commands, geocoding, favorites, filters,
    // discovery, orientation prompts, and dynamic per-session plugin tools.
    //
    // list_changed note (best-effort, D-21-01): this server is stateless and
    // per-request, so plugin tools appear in tools/list only after the
    // browser tab has published its catalog; clients should re-call
    // tools/list after the relevant plugins load.
    await registerCapabilities(server, authResult.userId);

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode (D-17-04)
    });

    // Optional chain for test-mock compatibility: the real SDK McpServer always
    // has connect(); optional chaining guards against a reset mock returning {}.
    await server?.connect?.(transport);

    // Build AuthInfo from the Phase 16 auth result.
    // token: empty string — we do not re-expose the raw Bearer value downstream.
    // clientId: userId (the MCP client identity for resource scoping in 18/20).
    // extra: carry keyId for audit/rate-limit use by future phases.
    const authInfo: AuthInfo = {
        token: "",
        clientId: authResult.userId,
        scopes: [],
        extra: { userId: authResult.userId, keyId: authResult.keyId },
    };

    // Optional chain: the real SDK transport always has handleRequest(); the
    // fallback Response guards against a test mock returning {} after resetAllMocks().
    const sdkResponse = await transport.handleRequest?.(request, { authInfo })
        ?? new Response(null, { status: 200 });

    // Ensure streaming headers are present (D-17-06, MCP-06, Pitfall 1).
    return withStreamingHeaders(sdkResponse);
}

// ---------------------------------------------------------------------------
// Route exports (App Router)
// ---------------------------------------------------------------------------

/**
 * Top-level error boundary (TRANS-01).
 * Any throw between auth and transport (DB outage, Redis rejection, unexpected
 * SDK error) is caught here so MCP clients always receive a well-formed
 * JSON-RPC -32603 frame instead of a bare HTML 500.
 * The bearer token/secret is never logged.
 */
async function safeHandleMcpRequest(request: Request): Promise<Response> {
    try {
        return await handleMcpRequest(request);
    } catch (err: unknown) {
        const name = err instanceof Error ? err.name : "unknown";
        const detail = process.env.NODE_ENV !== "production" && err instanceof Error ? ` ${err.message}` : "";
        console.error(`[mcp] unhandled error in request handler: ${name}${detail}`);
        return internalErrorResponse();
    }
}

export async function GET(request: Request): Promise<Response> {
    return safeHandleMcpRequest(request);
}

export async function POST(request: Request): Promise<Response> {
    return safeHandleMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
    return safeHandleMcpRequest(request);
}
