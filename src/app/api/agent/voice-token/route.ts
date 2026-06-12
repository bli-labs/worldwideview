/**
 * GET / POST /api/agent/voice-token
 *
 * Session-authenticated minting of short-lived OpenAI Realtime client secrets
 * for the in-app voice agent. OPENAI_API_KEY stays server-side; the browser
 * gets a scoped ephemeral secret and connects to the Realtime API directly.
 *
 * GET  → { configured } — lets the overlay decide whether to render the orb.
 * POST → { token }      — mints the ephemeral client secret.
 */

import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { isDemo } from "@/core/edition";
import { redisSlidingWindow } from "@/lib/geocodingRateLimit";
import { SPATIALCORE_REALTIME_MODEL, SPATIALCORE_SYSTEM_PROMPT, SPATIALCORE_VOICE } from "@/core/voice/persona";

// Per-user budget: a token per connect attempt; 10/min is generous.
const MINT_LIMIT = 10;
const MINT_WINDOW_MS = 60_000;
const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

function safetyIdentifier(userId: string): string {
    return createHash("sha256").update(`wwv-voice:${userId}`).digest("hex");
}

export async function GET(): Promise<Response> {
    if (isDemo) return NextResponse.json({ configured: false }, { status: 403 });
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ configured: false }, { status: 401 });
    }
    return NextResponse.json({ configured: Boolean(process.env.OPENAI_API_KEY) });
}

export async function POST(): Promise<Response> {
    if (isDemo) {
        return NextResponse.json({ error: "Voice agent is not available on demo" }, { status: 403 });
    }
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return NextResponse.json(
            { error: "OPENAI_API_KEY is not configured on the server" },
            { status: 503 },
        );
    }

    const limit = await redisSlidingWindow(`voice:token:${userId}`, MINT_LIMIT, MINT_WINDOW_MS);
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many token requests" }, { status: 429 });
    }

    try {
        const response = await fetch(OPENAI_CLIENT_SECRETS_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "OpenAI-Safety-Identifier": safetyIdentifier(userId),
            },
            body: JSON.stringify({
                session: {
                    type: "realtime",
                    model: process.env.OPENAI_REALTIME_MODEL || SPATIALCORE_REALTIME_MODEL,
                    instructions: SPATIALCORE_SYSTEM_PROMPT,
                    audio: { output: { voice: process.env.OPENAI_REALTIME_VOICE || SPATIALCORE_VOICE } },
                },
            }),
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`client_secrets failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
        }
        const data = await response.json() as { value?: string; client_secret?: { value?: string } };
        const token = data.value ?? data.client_secret?.value;
        if (!token) {
            throw new Error("client_secrets response had no token value");
        }
        return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[voice-token] mint failed: ${message}`);
        return NextResponse.json({ error: "Failed to mint voice token" }, { status: 502 });
    }
}
