/**
 * VoiceTranscript — compact live transcript of the voice session:
 * user/agent speech plus MCP tool activity.
 */

"use client";

import { useEffect, useRef } from "react";
import type { VoiceTranscriptEntry } from "@/core/voice/types";

interface VoiceTranscriptProps {
    entries: VoiceTranscriptEntry[];
    onClose: () => void;
}

function roleLabel(entry: VoiceTranscriptEntry): string {
    if (entry.role === "user") return "YOU";
    if (entry.role === "agent") return "SPATIALCORE";
    return entry.toolName ? `TOOL · ${entry.toolName}` : "TOOL";
}

export function VoiceTranscript({ entries, onClose }: VoiceTranscriptProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [entries]);

    return (
        <div className="voice-transcript" data-testid="voice-transcript">
            <div className="voice-transcript-header">
                <span>VOICE TRANSCRIPT</span>
                <button onClick={onClose} aria-label="Close transcript">×</button>
            </div>
            <div className="voice-transcript-body" ref={scrollRef}>
                {entries.length === 0 && (
                    <div className="voice-transcript-empty">
                        Say something — the conversation will appear here.
                    </div>
                )}
                {entries.map((entry) => (
                    <div key={entry.id} className={`voice-transcript-entry voice-entry-${entry.role}`}>
                        <span className="voice-entry-role">{roleLabel(entry)}</span>
                        <span className="voice-entry-text">{entry.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
