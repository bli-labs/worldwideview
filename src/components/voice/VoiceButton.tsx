/**
 * VoiceButton — the "Ask SpatialCore" mercury orb.
 *
 * An always-morphing liquid shell around a glass core; the JS-driven
 * border-radius lerp takes over while a session is active.
 */

"use client";

import { useEffect, useRef } from "react";
import type { VoiceState } from "@/core/voice/types";

interface VoiceButtonProps {
    state: VoiceState;
    onClick: () => void;
    onDisconnect: () => void;
}

function randomRadius(): string {
    const r = () => 38 + Math.random() * 24;
    return `${r()}% ${r()}% ${r()}% ${r()}% / ${r()}% ${r()}% ${r()}% ${r()}%`;
}

function randomRotation(): number {
    return Math.random() * 360;
}

function lerpRadius(a: string, b: string, t: number): string {
    const aNums = a.match(/[\d.]+/g)!.map(Number);
    const bNums = b.match(/[\d.]+/g)!.map(Number);
    const out = aNums.map((v, i) => v + (bNums[i] - v) * t);
    return `${out[0]}% ${out[1]}% ${out[2]}% ${out[3]}% / ${out[4]}% ${out[5]}% ${out[6]}% ${out[7]}%`;
}

function stateLabel(state: VoiceState): string {
    switch (state) {
        case "disconnected": return "Ask SpatialCore";
        case "connecting": return "CONNECTING";
        case "connected": return "LISTENING";
        case "recording": return "LISTENING";
        case "speaking": return "SPEAKING";
        case "error": return "VOICE ERROR";
        default: return "";
    }
}

export function VoiceButton({ state, onClick, onDisconnect }: VoiceButtonProps) {
    const isActive = state === "connected" || state === "recording" || state === "speaking";
    const mercuryRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number>(0);

    useEffect(() => {
        const el = mercuryRef.current;
        if (!el || !isActive) {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (el) {
                el.style.borderRadius = "";
                el.style.transform = "";
            }
            return;
        }

        let current = { br: randomRadius(), rot: randomRotation(), scale: 1.05 };
        let target = { br: randomRadius(), rot: randomRotation(), scale: 1.05 + Math.random() * 0.08 };
        let progress = 0;
        const speed = 0.008 + Math.random() * 0.004;

        function tick() {
            progress += speed;
            const t = (1 - Math.cos(progress * Math.PI)) / 2;

            el!.style.borderRadius = lerpRadius(current.br, target.br, t);
            const rot = current.rot + (target.rot - current.rot) * t;
            const sc = current.scale + (target.scale - current.scale) * t;
            el!.style.transform = `rotate(${rot}deg) scale(${sc})`;

            if (progress >= 1) {
                current = { br: target.br, rot: target.rot, scale: target.scale };
                target = {
                    br: randomRadius(),
                    rot: current.rot + 30 + Math.random() * 60,
                    scale: 1.05 + Math.random() * 0.08,
                };
                progress = 0;
            }
            rafRef.current = requestAnimationFrame(tick);
        }

        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [isActive]);

    const wrapperClass = isActive
        ? "voice-orb-wrap voice-lava-active"
        : state === "connecting"
            ? "voice-orb-wrap voice-connecting"
            : state === "error"
                ? "voice-orb-wrap voice-error"
                : "voice-orb-wrap";

    const readoutClass = isActive
        ? "voice-readout voice-readout-active"
        : state === "connecting"
            ? "voice-readout voice-readout-connecting"
            : state === "error"
                ? "voice-readout voice-readout-error"
                : "voice-readout";

    return (
        <div className="voice-button-dock">
            <div className={wrapperClass}>
                <div ref={mercuryRef} className="voice-mercury" />
                <button
                    onClick={isActive ? onDisconnect : onClick}
                    className={`voice-glass-btn ${isActive ? "voice-glass-active" : ""}`}
                    aria-label="Voice interaction"
                    data-testid="voice-agent-button"
                >
                    <div className="voice-lava-a" />
                    <div className="voice-lava-b" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/logo/logo-icon.svg" alt="SpatialCore" className="voice-sc-icon" />
                </button>
            </div>
            <div className={readoutClass}>
                <span>{stateLabel(state)}</span>
            </div>
        </div>
    );
}
