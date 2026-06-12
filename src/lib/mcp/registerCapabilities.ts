/**
 * Shared MCP capability registration.
 *
 * Single source of truth for which resources, tools, and prompts a WWV MCP
 * server exposes. Both transports use it:
 *   - /api/mcp        (Bearer API-key auth, external clients)
 *   - /api/agent/mcp  (Auth.js session auth, the in-app voice agent)
 *
 * Keeping the sequence here means the two routes can never drift: a tool
 * registered for external MCP clients is automatically available to the
 * voice agent, and vice versa.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrientationPrompts } from "@/lib/mcp/server";
import { registerDataQueryTools } from "@/lib/mcp/tools";
import { registerGlobeResources } from "@/app/api/mcp/globeResources";
import { registerGlobeCommandTools } from "@/app/api/mcp/globeCommandTools";
import { registerGeocodingTools } from "@/app/api/mcp/geocodingTools";
import { registerFavoritesTools } from "@/app/api/mcp/favoritesTools";
import { registerFilterTools } from "@/app/api/mcp/filterTools";
import { registerDiscoveryTools } from "@/app/api/mcp/discoveryTools";
import { registerPluginToolDispatch } from "@/app/api/mcp/pluginToolDispatch";
import { resolveActiveSessionId } from "@/lib/globeCommandQueue";

/**
 * Register every WWV capability on a fresh per-request McpServer.
 *
 * userId comes from the route's auth result (API key or session) — never
 * from the request body. Plugin tools are scoped to the user's most
 * recently active globe session (browser-published catalog only).
 */
export async function registerCapabilities(
    server: McpServer,
    userId: string,
): Promise<void> {
    registerGlobeResources(server, { userId });
    registerDataQueryTools(server, { userId });
    registerGlobeCommandTools(server, { userId });
    registerGeocodingTools(server, { userId });
    registerFavoritesTools(server, { userId });
    registerFilterTools(server, { userId });
    registerDiscoveryTools(server, { userId });
    await registerOrientationPrompts(server, { userId });

    // Dynamic per-session plugin tools (Phase 21): catalog is published by the
    // browser tab; tools/list reflects whatever the tab has loaded.
    const sessionId = await resolveActiveSessionId(userId);
    await registerPluginToolDispatch(server, { userId, sessionId });
}
