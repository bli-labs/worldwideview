/**
 * VoiceAgentHandler — OpenAI Realtime WebRTC voice session.
 *
 * Connects with a short-lived client secret minted by /api/agent/voice-token.
 * The browser sends mic audio over WebRTC, receives model audio as a remote
 * track, and exchanges session/tool events on the "oai-events" data channel.
 */

import type { AgentToolDefinition, VoiceState } from "./types";
import { AudioLevelMonitor } from "./AudioLevelMonitor";
import {
    eventErrorMessage,
    eventText,
    parseArguments,
    parseRealtimeEvent,
    type FunctionCallItem,
    type RealtimeEvent,
} from "./realtimeEvents";
import { sanitizeSchema } from "./toolSchema";

const TOKEN_URL = "/api/agent/voice-token";
const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MAX_TOOL_RESPONSE_CHARS = 8000;

export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface VoiceAgentHandlerConfig {
    tools: AgentToolDefinition[];
    onToolCall: ToolCallHandler;
    onStateChange?: (state: VoiceState) => void;
    onAudioLevel?: (level: number) => void;
    onDebug?: (message: string) => void;
    onTranscript?: (role: "user" | "agent", text: string) => void;
}

export { sanitizeSchema };

export class VoiceAgentHandler {
    private peerConnection: RTCPeerConnection | null = null;
    private dataChannel: RTCDataChannel | null = null;
    private mediaStream: MediaStream | null = null;
    private audioElement: HTMLAudioElement | null = null;
    private readonly levelMonitor: AudioLevelMonitor;
    private handledCallIds = new Set<string>();
    private agentTranscriptBuffer = "";
    private intentionalDisconnect = false;

    isConnected = false;
    isRecording = false;

    constructor(private readonly config: VoiceAgentHandlerConfig) {
        this.levelMonitor = new AudioLevelMonitor((level) => this.config.onAudioLevel?.(level));
    }

    async connect(): Promise<void> {
        try {
            this.intentionalDisconnect = false;
            this.updateState("connecting");

            this.config.onDebug?.("Requesting OpenAI Realtime client secret");
            const tokenRes = await fetch(TOKEN_URL, { method: "POST" });
            if (!tokenRes.ok) {
                const body = await tokenRes.text();
                throw new Error(`voice token request failed (HTTP ${tokenRes.status}): ${body.slice(0, 200)}`);
            }
            const { token } = await tokenRes.json() as { token?: string };
            if (!token) throw new Error("voice token response had no token");
            this.config.onDebug?.("OpenAI Realtime token received");

            const pc = new RTCPeerConnection();
            this.peerConnection = pc;
            this.audioElement = new Audio();
            this.audioElement.autoplay = true;

            pc.ontrack = (event) => {
                if (this.audioElement) {
                    this.audioElement.srcObject = event.streams[0];
                    this.audioElement.play().catch(() => { /* autoplay may already be satisfied */ });
                }
                this.updateState("speaking");
            };
            pc.onconnectionstatechange = () => this.handleConnectionState(pc.connectionState);

            this.config.onDebug?.("Starting microphone capture");
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            for (const track of this.mediaStream.getAudioTracks()) {
                pc.addTrack(track, this.mediaStream);
            }
            this.levelMonitor.start(this.mediaStream);

            const dc = pc.createDataChannel("oai-events");
            this.dataChannel = dc;
            const channelOpen = this.waitForDataChannel(dc);
            dc.addEventListener("message", (event) => this.handleDataMessage(event));
            dc.addEventListener("close", () => this.handleChannelClose());

            this.config.onDebug?.("Connecting to OpenAI Realtime (gpt-realtime-2)");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const sdpRes = await fetch(REALTIME_CALLS_URL, {
                method: "POST",
                body: offer.sdp,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/sdp",
                },
            });
            if (!sdpRes.ok) {
                const body = await sdpRes.text();
                throw new Error(`Realtime SDP exchange failed (HTTP ${sdpRes.status}): ${body.slice(0, 200)}`);
            }
            await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
            await channelOpen;

            this.isConnected = true;
            this.isRecording = true;
            this.config.onDebug?.("OpenAI Realtime connected");
            this.sendSessionUpdate();
            this.updateState("recording");
        } catch (error) {
            console.error("[VoiceAgent] Connection error:", error);
            this.config.onDebug?.(`OpenAI Realtime error: ${(error as Error).message}`);
            await this.disconnect();
            this.updateState("error");
            throw error;
        }
    }

    setMuted(muted: boolean): void {
        this.isRecording = !muted;
        for (const track of this.mediaStream?.getAudioTracks() ?? []) {
            track.enabled = !muted;
        }
        this.updateDerivedState();
    }

    async disconnect(): Promise<void> {
        this.intentionalDisconnect = true;
        this.isConnected = false;
        this.isRecording = false;
        this.levelMonitor.stop();
        this.dataChannel?.close();
        this.dataChannel = null;
        this.peerConnection?.close();
        this.peerConnection = null;
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.srcObject = null;
            this.audioElement = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }
        this.updateState("disconnected");
    }

    private waitForDataChannel(channel: RTCDataChannel): Promise<void> {
        if (channel.readyState === "open") return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error("Realtime data channel did not open")), 10_000);
            channel.addEventListener("open", () => {
                window.clearTimeout(timeout);
                resolve();
            }, { once: true });
            channel.addEventListener("error", () => {
                window.clearTimeout(timeout);
                reject(new Error("Realtime data channel failed"));
            }, { once: true });
        });
    }

    private sendSessionUpdate(): void {
        this.sendEvent({
            type: "session.update",
            session: {
                type: "realtime",
                tools: this.config.tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: sanitizeSchema(tool.inputSchema),
                })),
                tool_choice: "auto",
            },
        });
        this.config.onDebug?.(`Registered ${this.config.tools.length} OpenAI function tools`);
    }

    private sendEvent(event: Record<string, unknown>): void {
        if (this.dataChannel?.readyState === "open") {
            this.dataChannel.send(JSON.stringify(event));
        }
    }

    private handleDataMessage(message: MessageEvent<string>): void {
        const event = parseRealtimeEvent(message.data);
        if (!event) return;

        if (event.type === "error") {
            this.config.onDebug?.(`OpenAI Realtime error: ${eventErrorMessage(event)}`);
            return;
        }

        if (event.type === "conversation.item.input_audio_transcription.completed") {
            const transcript = eventText(event, "transcript").trim();
            if (transcript) this.config.onTranscript?.("user", transcript);
        }
        if (event.type === "response.audio_transcript.delta") {
            this.agentTranscriptBuffer += eventText(event, "delta");
        }
        if (event.type === "response.audio_transcript.done") {
            const transcript = eventText(event, "transcript").trim() || this.agentTranscriptBuffer.trim();
            if (transcript) this.config.onTranscript?.("agent", transcript);
            this.agentTranscriptBuffer = "";
        }
        if (event.type === "response.done" && this.agentTranscriptBuffer.trim()) {
            this.config.onTranscript?.("agent", this.agentTranscriptBuffer.trim());
            this.agentTranscriptBuffer = "";
            this.updateDerivedState();
        }

        if (event.type === "response.function_call_arguments.done") {
            const call = event as RealtimeEvent & FunctionCallItem;
            void this.handleToolCall(call.call_id, call.name, call.arguments);
        }
        if (event.type === "response.output_item.done") {
            const item = event.item as FunctionCallItem | undefined;
            if (item?.type === "function_call") {
                void this.handleToolCall(item.call_id, item.name, item.arguments);
            }
        }
    }

    private async handleToolCall(callId: string | undefined, name: string | undefined, rawArgs: string | undefined): Promise<void> {
        if (!callId || !name || this.handledCallIds.has(callId)) return;
        this.handledCallIds.add(callId);
        this.updateState("connected");

        let result: string;
        try {
            result = await this.config.onToolCall(name, parseArguments(rawArgs));
        } catch (error) {
            result = JSON.stringify({ error: (error as Error).message });
        }
        if (result.length > MAX_TOOL_RESPONSE_CHARS) {
            result = `${result.slice(0, MAX_TOOL_RESPONSE_CHARS)}... [truncated, ${result.length} chars total]`;
        }

        this.sendEvent({
            type: "conversation.item.create",
            item: {
                type: "function_call_output",
                call_id: callId,
                output: result,
            },
        });
        this.sendEvent({ type: "response.create" });
        this.updateDerivedState();
    }

    private handleConnectionState(state: RTCPeerConnectionState): void {
        this.config.onDebug?.(`OpenAI Realtime connection state: ${state}`);
        if ((state === "failed" || state === "closed" || state === "disconnected") && !this.intentionalDisconnect) {
            this.isConnected = false;
            this.isRecording = false;
            this.updateState("disconnected");
        }
    }

    private handleChannelClose(): void {
        if (!this.intentionalDisconnect) {
            this.config.onDebug?.("OpenAI Realtime data channel closed");
            this.isConnected = false;
            this.isRecording = false;
            this.updateState("disconnected");
        }
    }

    private updateDerivedState(): void {
        if (!this.isConnected) {
            this.updateState("disconnected");
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
