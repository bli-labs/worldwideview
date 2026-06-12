/**
 * GET / POST / DELETE /api/agent/mcp
 *
 * Session-authenticated Streamable HTTP MCP endpoint for the in-app voice
 * agent. The Bearer-key twin lives at /api/mcp — both expose the SAME
 * capability surface via registerCapabilities(), so the voice agent always
 * has exact parity with external MCP clients.
 *
 * Gate ordering mirrors /api/mcp:
 *   0. IP rate limit
 *   1. Edition check — demo edition is blocked before any auth/DB work
 *   2. Auth.js session — same-origin browser cookies, userId from session
 *   3. Per-user Redis sliding window
 *   4. Fresh McpServer + transport per request (stateless invariant — never
 *      hoist server/transport to module scope)
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isDemo } from "@/core/edition";
import { auth } from "@/lib/auth";
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

export const maxDuration = 30;

// Per-user rate-limit budget: matches the per-key budget on /api/mcp.
const AGENT_MCP_LIMIT = 120;
const AGENT_MCP_WINDOW_MS = 60_000;

/** Mirror of /api/mcp's streaming header handling (Pitfall 1 / D-17-06). */
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

async function handleAgentMcpRequest(request: Request): Promise<Response> {
    const ipLimitResult = mcpLimiter.check(getClientIp(request));
    if (ipLimitResult) return ipLimitResult;

    if (isDemo) {
        return demoBlockedResponse();
    }

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        console.warn("[agent-mcp] unauthorized request (no session)");
        return unauthorizedResponse();
    }

    const userRateKey = `mcp:ratelimit:agent:${userId}`;
    const userLimit = await redisSlidingWindow(userRateKey, AGENT_MCP_LIMIT, AGENT_MCP_WINDOW_MS);
    if (!userLimit.allowed) {
        return rateLimitedResponse(userLimit.retryAfterMs);
    }

    // STATELESS INVARIANT: fresh server + transport per request.
    const server = createMcpServer();
    await registerCapabilities(server, userId);

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
    });
    await server?.connect?.(transport);

    const authInfo: AuthInfo = {
        token: "",
        clientId: userId,
        scopes: [],
        extra: { userId, via: "session" },
    };

    const sdkResponse = await transport.handleRequest?.(request, { authInfo })
        ?? new Response(null, { status: 200 });

    return withStreamingHeaders(sdkResponse);
}

async function safeHandleAgentMcpRequest(request: Request): Promise<Response> {
    try {
        return await handleAgentMcpRequest(request);
    } catch (err: unknown) {
        const name = err instanceof Error ? err.name : "unknown";
        const detail = process.env.NODE_ENV !== "production" && err instanceof Error ? ` ${err.message}` : "";
        console.error(`[agent-mcp] unhandled error in request handler: ${name}${detail}`);
        return internalErrorResponse();
    }
}

export async function GET(request: Request): Promise<Response> {
    return safeHandleAgentMcpRequest(request);
}

export async function POST(request: Request): Promise<Response> {
    return safeHandleAgentMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
    return safeHandleAgentMcpRequest(request);
}
