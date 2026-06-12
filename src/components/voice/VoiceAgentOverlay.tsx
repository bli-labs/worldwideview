/**
 * VoiceAgentOverlay — mounts the "Ask SpatialCore" voice agent.
 *
 * Renders the mercury orb dock plus a transcript panel. The agent's tools
 * are the live WWV MCP surface (via /api/agent/mcp), so it can search
 * entities, geocode, fly the camera, manage filters and favorites, and
 * call any per-session plugin tools — all by voice.
 *
 * The orb renders only when the server reports the voice backend is
 * configured (OPENAI_API_KEY present) — and never on demo edition.
 */

"use client";

import { useEffect, useState } from "react";
import { useVoiceAgent } from "@/core/voice/useVoiceAgent";
import { isDemo } from "@/core/edition";
import { VoiceButton } from "./VoiceButton";
import { VoiceTranscript } from "./VoiceTranscript";

export function VoiceAgentOverlay() {
    const { state, audioLevel, transcript, start, stop } = useVoiceAgent();
    const [transcriptOpen, setTranscriptOpen] = useState(false);
    const [configured, setConfigured] = useState(false);

    useEffect(() => {
        if (isDemo) return;
        let cancelled = false;
        fetch("/api/agent/voice-token")
            .then((res) => (res.ok ? res.json() : { configured: false }))
            .then((data) => {
                if (!cancelled) setConfigured(Boolean(data.configured));
            })
            .catch(() => {
                if (!cancelled) setConfigured(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (isDemo || !configured) return null;

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
            <VoiceButton
                state={state}
                audioLevel={audioLevel}
                onClick={handleStart}
                onDisconnect={handleStop}
            />
        </>
    );
}
