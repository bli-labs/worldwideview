/**
 * Shared types for the in-app voice agent (ported from the DAVE prototype).
 */

export type VoiceState =
    | "disconnected"
    | "connecting"
    | "connected"
    | "recording"
    | "speaking"
    | "error";

export interface VoiceTranscriptEntry {
    id: string;
    role: "user" | "agent" | "tool";
    text: string;
    toolName?: string;
    timestamp: number;
}

/** Tool surface discovered from the WWV MCP endpoint. */
export interface AgentToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
