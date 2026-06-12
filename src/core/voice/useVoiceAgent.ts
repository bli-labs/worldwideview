/**
 * useVoiceAgent — React orchestration for the in-app voice agent.
 *
 * Lifecycle per session: discover the WWV MCP tool surface via the bridge,
 * open an OpenAI Realtime session with those tools registered as function
 * tools, and route every tool call back through MCP. Transcript
 * entries (user/agent speech and tool activity) accumulate for the panel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { McpToolBridge } from "./McpToolBridge";
import { VoiceAgentHandler } from "./VoiceAgentHandler";
import type { VoiceState, VoiceTranscriptEntry } from "./types";

let entryCounter = 0;
function nextEntryId(): string {
    entryCounter += 1;
    return `voice_${Date.now()}_${entryCounter}`;
}

export function useVoiceAgent() {
    const [state, setState] = useState<VoiceState>("disconnected");
    const [audioLevel, setAudioLevel] = useState(0);
    const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);

    const handlerRef = useRef<VoiceAgentHandler | null>(null);
    const bridgeRef = useRef<McpToolBridge | null>(null);

    const addEntry = useCallback((entry: Omit<VoiceTranscriptEntry, "id" | "timestamp">) => {
        setTranscript((prev) => [
            ...prev,
            { ...entry, id: nextEntryId(), timestamp: Date.now() },
        ]);
    }, []);

    const start = useCallback(async () => {
        if (handlerRef.current?.isConnected) return;
        setState("connecting");

        try {
            const bridge = bridgeRef.current ?? new McpToolBridge();
            bridgeRef.current = bridge;

            // Discover the live MCP tool surface; the Live session's function
            // declarations mirror it exactly (including per-session plugin tools).
            addEntry({ role: "tool", toolName: "voice", text: "Discovering MCP tools" });
            const tools = await bridge.listTools();
            addEntry({ role: "tool", toolName: "voice", text: `Discovered ${tools.length} MCP tools` });
            if (process.env.NODE_ENV !== "production") {
                console.log(
                    `[VoiceAgent] Registering ${tools.length} MCP tools:`,
                    tools.map((tool) => tool.name),
                );
            }

            const handler = new VoiceAgentHandler({
                tools,
                onToolCall: async (name, args) => {
                    addEntry({ role: "tool", toolName: name, text: `→ ${name}` });
                    const result = await bridge.callTool(name, args);
                    const compact = result.length > 280 ? `${result.slice(0, 277)}...` : result;
                    addEntry({ role: "tool", toolName: name, text: compact });
                    return result;
                },
                onStateChange: setState,
                onAudioLevel: setAudioLevel,
                onDebug: (message) => addEntry({ role: "tool", toolName: "voice", text: message }),
                onTranscript: (role, text) => addEntry({ role, text }),
            });

            handlerRef.current = handler;
            await handler.connect();
        } catch (error) {
            console.error("[VoiceAgent] Failed to start:", error);
            setState("error");
        }
    }, [addEntry]);

    const stop = useCallback(async () => {
        const handler = handlerRef.current;
        handlerRef.current = null;
        if (handler) {
            await handler.disconnect();
        }
        const bridge = bridgeRef.current;
        bridgeRef.current = null;
        if (bridge) {
            await bridge.close();
        }
        setState("disconnected");
    }, []);

    const clearTranscript = useCallback(() => setTranscript([]), []);

    // Tear the session down if the component unmounts mid-conversation.
    useEffect(() => {
        return () => {
            handlerRef.current?.disconnect();
            bridgeRef.current?.close();
        };
    }, []);

    return { state, audioLevel, transcript, start, stop, clearTranscript };
}
