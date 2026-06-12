/**
 * GET / POST /api/agent/voice-token
 *
 * Session-authenticated minting of short-lived Gemini ephemeral tokens for
 * the in-app voice agent. GEMINI_API_KEY stays server-side; the browser gets
 * a single-use token (30 min session cap, 2 min window to start it) and
 * connects to the Live API directly.
 *
 * GET  → { configured } — lets the overlay decide whether to render the orb.
 * POST → { token }      — mints the ephemeral token.
 */

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { auth } from "@/lib/auth";
import { isDemo } from "@/core/edition";
import { redisSlidingWindow } from "@/lib/geocodingRateLimit";

// Per-user budget: a token per connect attempt; 10/min is generous.
const MINT_LIMIT = 10;
const MINT_WINDOW_MS = 60_000;

export async function GET(): Promise<Response> {
    if (isDemo) return NextResponse.json({ configured: false }, { status: 403 });
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ configured: false }, { status: 401 });
    }
    return NextResponse.json({ configured: Boolean(process.env.GEMINI_API_KEY) });
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return NextResponse.json(
            { error: "GEMINI_API_KEY is not configured on the server" },
            { status: 503 },
        );
    }

    const limit = await redisSlidingWindow(`voice:token:${userId}`, MINT_LIMIT, MINT_WINDOW_MS);
    if (!limit.allowed) {
        return NextResponse.json({ error: "Too many token requests" }, { status: 429 });
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const token = await ai.authTokens.create({
            config: {
                uses: 1,
                expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
                httpOptions: { apiVersion: "v1alpha" },
            },
        });
        if (!token.name) {
            throw new Error("authTokens.create returned no token name");
        }
        return NextResponse.json({ token: token.name }, { headers: { "Cache-Control": "no-store" } });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[voice-token] mint failed: ${message}`);
        return NextResponse.json({ error: "Failed to mint voice token" }, { status: 502 });
    }
}
