/**
 * VoiceAgentHandler — wraps the @elevenlabs/client Conversation SDK.
 *
 * Ported from the DAVE prototype's ElevenLabsHandler. The SDK manages audio
 * I/O internally (microphone acquisition, playback, VAD) — no manual PCM or
 * WebSocket handling needed. Tool calls route through a single onToolCall
 * handler; WWV wires that to the MCP bridge.
 *
 * NOTE: prompt and voice are configured on the ElevenLabs agent dashboard.
 * Overrides are intentionally NOT sent — unauthorized overrides make the
 * server silently close the connection with code 1000.
 */

import type { VoiceState } from "./types";

type Mode = "speaking" | "listening";

interface ConversationInstance {
    endSession(): Promise<void>;
    setMicMuted(isMuted: boolean): void;
    getInputVolume(): number;
    getOutputVolume(): number;
    isOpen(): boolean;
}

export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface VoiceAgentHandlerConfig {
    agentId: string;
    /** Names of client tools to register; implementations go through onToolCall. */
    toolNames: string[];
    onToolCall: ToolCallHandler;
    onStateChange?: (state: VoiceState) => void;
    onAudioLevel?: (level: number) => void;
    onTranscript?: (role: "user" | "agent", text: string) => void;
}

export class VoiceAgentHandler {
    private conversation: ConversationInstance | null = null;
    private levelPollInterval: ReturnType<typeof setInterval> | null = null;
    private disconnecting = false;
    private mode: Mode = "listening";

    isConnected = false;
    isRecording = false;

    constructor(private readonly config: VoiceAgentHandlerConfig) {}

    async connect(): Promise<void> {
        try {
            this.disconnecting = false;
            this.updateState("connecting");

            // The SDK acquires the microphone itself — do NOT call
            // getUserMedia here (a dangling MediaStream can block the SDK's
            // own mic acquisition).

            const clientTools: Record<string, (params: unknown) => Promise<string>> = {};
            for (const name of this.config.toolNames) {
                clientTools[name] = async (params: unknown) => {
                    try {
                        return await this.config.onToolCall(
                            name,
                            (params as Record<string, unknown>) ?? {},
                        );
                    } catch (error) {
                        return JSON.stringify({ error: (error as Error).message });
                    }
                };
            }

            const { Conversation } = await import("@elevenlabs/client");

            this.conversation = await Conversation.startSession({
                agentId: this.config.agentId,
                connectionType: "websocket",
                clientTools,
                onConnect: () => {
                    this.isConnected = true;
                    this.isRecording = true;
                    this.updateState("recording");
                },
                onDisconnect: () => {
                    this.isConnected = false;
                    this.isRecording = false;
                    this.stopLevelPolling();
                    if (!this.disconnecting) {
                        this.updateState("disconnected");
                    }
                },
                onError: (message: string) => {
                    console.error("[VoiceAgent] Error:", message);
                },
                onModeChange: ({ mode }: { mode: Mode }) => {
                    this.mode = mode;
                    if (this.isConnected) {
                        this.updateDerivedState();
                    }
                },
                onMessage: ({ message, source }: { message: string; source: string }) => {
                    if (typeof message !== "string" || !message.trim()) return;
                    this.config.onTranscript?.(source === "user" ? "user" : "agent", message.trim());
                },
            } as Parameters<typeof Conversation.startSession>[0]) as unknown as ConversationInstance;

            this.startLevelPolling();
        } catch (error) {
            console.error("[VoiceAgent] Connection error:", error);
            this.isConnected = false;
            this.isRecording = false;
            this.updateState("error");
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        this.disconnecting = true;
        this.stopLevelPolling();

        if (this.conversation) {
            try {
                await this.conversation.endSession();
            } catch (error) {
                console.error("[VoiceAgent] Error ending session:", error);
            }
            this.conversation = null;
        }

        this.isConnected = false;
        this.isRecording = false;
        this.updateState("disconnected");
    }

    /** Mute/unmute without disconnecting (SDK auto-records on connect). */
    setMuted(muted: boolean): void {
        if (!this.conversation) return;
        this.conversation.setMicMuted(muted);
        this.isRecording = !muted;
        this.updateDerivedState();
    }

    private updateDerivedState(): void {
        if (!this.isConnected) {
            this.updateState("disconnected");
        } else if (this.mode === "speaking") {
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

    private startLevelPolling(): void {
        if (this.levelPollInterval) return;
        this.levelPollInterval = setInterval(() => {
            if (!this.conversation || !this.isConnected) return;
            try {
                const level = Math.max(
                    this.conversation.getInputVolume(),
                    this.conversation.getOutputVolume(),
                );
                this.config.onAudioLevel?.(level);
            } catch {
                // Volume polling is best-effort.
            }
        }, 50);
    }

    private stopLevelPolling(): void {
        if (this.levelPollInterval) {
            clearInterval(this.levelPollInterval);
            this.levelPollInterval = null;
        }
        this.config.onAudioLevel?.(0);
    }
}
