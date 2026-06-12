/**
 * VoiceAgentOverlay — mounts the "Ask SpatialCore" voice agent.
 *
 * Renders the mercury orb dock plus a transcript panel. The agent's tools
 * are the live WWV MCP surface (via /api/agent/mcp), so it can search
 * entities, geocode, fly the camera, manage filters and favorites, and
 * call any per-session plugin tools — all by voice.
 *
 * Hidden on demo edition (the MCP surface is demo-blocked server-side too).
 */

"use client";

import { useState } from "react";
import { useVoiceAgent, isVoiceAgentConfigured } from "@/core/voice/useVoiceAgent";
import { isDemo } from "@/core/edition";
import { VoiceButton } from "./VoiceButton";
import { VoiceTranscript } from "./VoiceTranscript";

export function VoiceAgentOverlay() {
    const { state, transcript, start, stop } = useVoiceAgent();
    const [transcriptOpen, setTranscriptOpen] = useState(false);

    // Render nothing until a SpatialCore agent is provisioned
    // (scripts/setup-voice-agent.mjs) — and never on demo edition.
    if (isDemo || !isVoiceAgentConfigured) return null;

    const handleStart = () => {
        setTranscriptOpen(true);
        void start();
    };

    const handleStop = () => {
        void stop();
    };

    return (
        <>
            {transcriptOpen && (
                <VoiceTranscript entries={transcript} onClose={() => setTranscriptOpen(false)} />
            )}
            <VoiceButton state={state} onClick={handleStart} onDisconnect={handleStop} />
        </>
    );
}
