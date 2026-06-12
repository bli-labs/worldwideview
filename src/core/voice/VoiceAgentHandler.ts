/**
 * VoiceAgentHandler — Gemini Live API voice session.
 *
 * Connects with a short-lived ephemeral token minted by /api/agent/voice-token
 * (GEMINI_API_KEY never reaches the browser). The persona and tool surface are
 * defined entirely in this codebase: system prompt from persona.ts, tools from
 * the WWV MCP bridge, registered as function declarations at session start.
 *
 * Audio: mic → 16 kHz PCM16 chunks via MicCapture; responses → 24 kHz PCM16
 * through AudioPlayback. Audio input pauses while a tool call is in flight —
 * Gemini rejects sendRealtimeInput during tool processing.
 */

import { GoogleGenAI, Modality } from "@google/genai";
import type { Session, LiveServerMessage, LiveServerContent, FunctionCall } from "@google/genai";
import type { AgentToolDefinition, VoiceState } from "./types";
import { MicCapture, AudioPlayback, base64ToArrayBuffer } from "./liveAudio";
import { SPATIALCORE_SYSTEM_PROMPT, SPATIALCORE_VOICE, SPATIALCORE_LIVE_MODEL } from "./persona";

const TOKEN_URL = "/api/agent/voice-token";
// Oversized tool responses crash the Live socket with code 1008.
const MAX_TOOL_RESPONSE_CHARS = 8000;
const MAX_RECONNECT_ATTEMPTS = 3;

export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface VoiceAgentHandlerConfig {
    tools: AgentToolDefinition[];
    onToolCall: ToolCallHandler;
    onStateChange?: (state: VoiceState) => void;
    onAudioLevel?: (level: number) => void;
    onTranscript?: (role: "user" | "agent", text: string) => void;
}

/** Gemini's schema dialect rejects some JSON-Schema keywords zod emits. */
function sanitizeSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeSchema);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if (key === "$schema" || key === "additionalProperties") continue;
            out[key] = sanitizeSchema(v);
        }
        return out;
    }
    return value;
}

export class VoiceAgentHandler {
    private session: Session | null = null;
    private mic = new MicCapture();
    private playback: AudioPlayback;

    isConnected = false;
    isRecording = false;

    private toolCallInProgress = false;
    private intentionalDisconnect = false;
    private reconnectAttempts = 0;
    private userTranscriptBuffer = "";
    private agentTranscriptBuffer = "";

    constructor(private readonly config: VoiceAgentHandlerConfig) {
        this.playback = new AudioPlayback({
            onLevel: (level) => this.config.onAudioLevel?.(level),
            onPlaybackStart: () => this.updateState("speaking"),
            onPlaybackEnd: () => this.updateDerivedState(),
        });
    }

    async connect(): Promise<void> {
        try {
            this.intentionalDisconnect = false;
            this.toolCallInProgress = false;
            this.updateState("connecting");

            const tokenRes = await fetch(TOKEN_URL, { method: "POST" });
            if (!tokenRes.ok) {
                const body = await tokenRes.text();
                throw new Error(`voice token request failed (HTTP ${tokenRes.status}): ${body.slice(0, 200)}`);
            }
            const { token } = await tokenRes.json();
            if (!token) throw new Error("voice token response had no token");

            const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });

            this.session = await ai.live.connect({
                model: SPATIALCORE_LIVE_MODEL,
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: SPATIALCORE_VOICE } },
                    },
                    // Thinking makes the model emit text blocks instead of audio,
                    // which crashes tool-calling sessions with code 1008.
                    thinkingConfig: { thinkingBudget: 0 },
                    systemInstruction: SPATIALCORE_SYSTEM_PROMPT,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    tools: [{
                        functionDeclarations: this.config.tools.map((tool) => ({
                            name: tool.name,
                            description: tool.description,
                            parameters: sanitizeSchema(tool.inputSchema) as undefined,
                        })),
                    }],
                },
                callbacks: {
                    onmessage: (message: LiveServerMessage) => this.handleMessage(message),
                    onerror: (e: ErrorEvent) => {
                        console.error("[VoiceAgent] Live error:", e?.message ?? e);
                    },
                    onclose: (e: CloseEvent) => this.handleClose(e),
                },
            });

            this.isConnected = true;
            await this.startMic();
        } catch (error) {
            console.error("[VoiceAgent] Connection error:", error);
            this.isConnected = false;
            this.isRecording = false;
            this.updateState("error");
            throw error;
        }
    }

    private handleClose(e: CloseEvent): void {
        this.isConnected = false;
        this.isRecording = false;
        const transient = e?.code === 1008 || e?.code === 1011;
        if (transient && !this.intentionalDisconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            const delay = this.reconnectAttempts * 1000;
            console.warn(`[VoiceAgent] Transient close (${e.code}); reconnecting in ${delay}ms (${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            this.updateState("connecting");
            setTimeout(() => {
                this.session = null;
                this.mic.stop();
                this.playback.stopAll();
                this.connect()
                    .then(() => { this.reconnectAttempts = 0; })
                    .catch(() => this.updateState("disconnected"));
            }, delay);
        } else if (!this.intentionalDisconnect) {
            this.updateState("disconnected");
        }
    }

    private handleMessage(message: LiveServerMessage): void {
        try {
            if (message.serverContent) this.handleServerContent(message.serverContent);
            if (message.toolCall) {
                this.flushUserTranscript();
                void this.handleToolCall(message.toolCall.functionCalls || []);
            }
        } catch (error) {
            console.error("[VoiceAgent] Message handling error:", error);
        }
    }

    private handleServerContent(content: LiveServerContent): void {
        if (content.modelTurn) {
            this.flushUserTranscript();
            for (const part of content.modelTurn.parts || []) {
                if (part.inlineData?.data) {
                    this.playback.enqueue(base64ToArrayBuffer(part.inlineData.data));
                }
            }
        }

        if (content.inputTranscription?.text) {
            this.userTranscriptBuffer += content.inputTranscription.text;
        }
        if (content.inputTranscription?.finished) {
            this.flushUserTranscript();
        }
        if (content.outputTranscription?.text) {
            this.agentTranscriptBuffer += content.outputTranscription.text;
        }

        if (content.turnComplete) {
            const text = this.agentTranscriptBuffer.trim();
            if (text) this.config.onTranscript?.("agent", text);
            this.agentTranscriptBuffer = "";
            if (!this.playback.isPlaying) this.updateDerivedState();
        }

        if (content.interrupted) {
            this.userTranscriptBuffer = "";
            this.agentTranscriptBuffer = "";
            this.playback.interrupt();
        }
    }

    private flushUserTranscript(): void {
        const text = this.userTranscriptBuffer.trim();
        if (text) this.config.onTranscript?.("user", text);
        this.userTranscriptBuffer = "";
    }

    private async handleToolCall(functionCalls: FunctionCall[]): Promise<void> {
        this.toolCallInProgress = true;
        const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];

        for (const call of functionCalls) {
            const name = call.name || "";
            const args = (call.args || {}) as Record<string, unknown>;
            let result: string;
            try {
                result = await this.config.onToolCall(name, args);
            } catch (error) {
                result = JSON.stringify({ error: (error as Error).message });
            }
            if (result.length > MAX_TOOL_RESPONSE_CHARS) {
                result = `${result.slice(0, MAX_TOOL_RESPONSE_CHARS)}… [truncated, ${result.length} chars total]`;
            }
            responses.push({
                id: call.id || `call_${responses.length}`,
                name,
                response: { result },
            });
        }

        if (responses.length > 0 && this.session) {
            this.session.sendToolResponse({ functionResponses: responses });
        }
        this.toolCallInProgress = false;
    }

    private async startMic(): Promise<void> {
        await this.mic.start((base64Pcm16) => {
            if (this.isConnected && this.isRecording && this.session && !this.toolCallInProgress) {
                this.session.sendRealtimeInput({
                    audio: { data: base64Pcm16, mimeType: "audio/pcm;rate=16000" },
                });
            }
        });
        this.isRecording = true;
        this.updateState("recording");
    }

    /** Mute/unmute without tearing the session down. */
    setMuted(muted: boolean): void {
        this.isRecording = !muted;
        this.updateDerivedState();
    }

    async disconnect(): Promise<void> {
        this.intentionalDisconnect = true;
        this.reconnectAttempts = 0;
        this.mic.stop();
        this.playback.stopAll();
        if (this.session) {
            try { this.session.close(); } catch { /* already closed */ }
            this.session = null;
        }
        this.isConnected = false;
        this.isRecording = false;
        this.updateState("disconnected");
    }

    private updateDerivedState(): void {
        if (!this.isConnected) {
            this.updateState("disconnected");
        } else if (this.playback.isPlaying) {
            this.updateState("speaking");
        } else if (this.isRecording) {
            this.updateState("recording");
        } else {
            this.updateState("connected");
        }
    }

    private updateState(state: VoiceState): void {
        this.config.onStateChange?.(state);
    }
}
