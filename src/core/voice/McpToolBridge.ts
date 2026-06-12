/**
 * McpToolBridge — connects the in-app voice agent to WWV's own MCP surface.
 *
 * Speaks real MCP (Streamable HTTP) to /api/agent/mcp, the session-authed
 * twin of /api/mcp. The voice agent therefore has exact tool parity with
 * external MCP clients — search, geocoding, fly_to, filters, favorites, and
 * any per-session plugin tools — with zero voice-specific server code.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentToolDefinition } from "./types";

const AGENT_MCP_PATH = "/api/agent/mcp";

interface ToolCallContent {
    type: string;
    text?: string;
}

export class McpToolBridge {
    private client: Client | null = null;

    /** Connect (or reuse) the MCP client over same-origin Streamable HTTP. */
    private async ensureClient(): Promise<Client> {
        if (this.client) return this.client;

        const client = new Client(
            { name: "wwv-voice-agent", version: "1.0.0" },
            { capabilities: {} },
        );
        const transport = new StreamableHTTPClientTransport(
            new URL(AGENT_MCP_PATH, window.location.origin),
            { requestInit: { credentials: "same-origin" } },
        );
        await client.connect(transport);
        this.client = client;
        return client;
    }

    /** List every tool the WWV MCP surface currently exposes. */
    async listTools(): Promise<AgentToolDefinition[]> {
        const client = await this.ensureClient();
        const result = await client.listTools();
        return (result.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        }));
    }

    /**
     * Invoke a tool and flatten the MCP content parts into a single string —
     * the shape voice-agent client tools must return.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
        const client = await this.ensureClient();
        const result = await client.callTool({ name, arguments: args });

        const parts = (result.content ?? []) as ToolCallContent[];
        const text = parts
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n");

        if (result.isError) {
            throw new Error(text || `Tool ${name} failed`);
        }
        return text || JSON.stringify({ success: true });
    }

    async close(): Promise<void> {
        if (this.client) {
            try {
                await this.client.close();
            } catch {
                // Closing a broken transport is best-effort.
            }
            this.client = null;
        }
    }
}
