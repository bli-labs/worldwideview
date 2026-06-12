/**
 * Browser audio plumbing for the Gemini Live voice session.
 *
 * MicCapture: microphone → 16 kHz mono PCM16 chunks (base64), via an inline
 * AudioWorklet. AudioPlayback: 24 kHz PCM16 response audio → seamless
 * scheduled playback with an analyser for level metering.
 */

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    if (!base64) return new ArrayBuffer(0);
    try {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    } catch {
        return new ArrayBuffer(0);
    }
}

const WORKLET_CODE = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.bufferIndex++] = channel[i];
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage(this.buffer.slice());
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCaptureProcessor);
`;

/** Microphone capture at 16 kHz mono, delivering base64 PCM16 chunks. */
export class MicCapture {
    private mediaStream: MediaStream | null = null;
    private context: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;

    async start(onChunk: (base64Pcm16: string) => void): Promise<void> {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });

        this.context = new AudioContext({ sampleRate: 16000 });
        const source = this.context.createMediaStreamSource(this.mediaStream);

        const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
        await this.context.audioWorklet.addModule(URL.createObjectURL(blob));
        this.workletNode = new AudioWorkletNode(this.context, "voice-capture");

        this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
            const float32Data = event.data;
            const int16Data = new Int16Array(float32Data.length);
            for (let i = 0; i < float32Data.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Data[i]));
                int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            onChunk(arrayBufferToBase64(int16Data.buffer));
        };

        // Not connected to destination — avoids mic feedback.
        source.connect(this.workletNode);
    }

    stop(): void {
        if (this.workletNode) {
            try { this.workletNode.disconnect(); } catch { /* already gone */ }
            this.workletNode = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }
        if (this.context && this.context.state !== "closed") {
            this.context.close().catch(() => { /* ignore */ });
            this.context = null;
        }
    }
}

export interface PlaybackCallbacks {
    onLevel?: (level: number) => void;
    onPlaybackStart?: () => void;
    onPlaybackEnd?: () => void;
}

/** Queued, gap-free playback of 24 kHz PCM16 response audio. */
export class AudioPlayback {
    private context: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private analyserData: Uint8Array | null = null;
    private queue: Float32Array[] = [];
    private playing = false;
    private nextPlayTime = 0;
    private levelRaf: number | null = null;
    // Bumped on stopAll so stale onended callbacks from a previous session bail.
    private sessionId = 0;

    constructor(private readonly callbacks: PlaybackCallbacks = {}) {}

    get isPlaying(): boolean {
        return this.playing;
    }

    enqueue(pcm16: ArrayBuffer): void {
        const byteLength = pcm16.byteLength - (pcm16.byteLength % 2);
        if (byteLength === 0) return;

        const aligned = new ArrayBuffer(byteLength);
        new Uint8Array(aligned).set(new Uint8Array(pcm16).subarray(0, byteLength));
        const int16Data = new Int16Array(aligned);
        const float32Data = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i] / 32768.0;
        }

        this.queue.push(float32Data);
        if (!this.playing) void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.playing || this.queue.length === 0) return;
        this.playing = true;
        this.callbacks.onPlaybackStart?.();

        try {
            if (!this.context || this.context.state === "closed") {
                this.context = new AudioContext({ sampleRate: 24000 });
                this.analyser = this.context.createAnalyser();
                this.analyser.fftSize = 256;
                this.analyser.smoothingTimeConstant = 0.15;
                this.analyser.connect(this.context.destination);
                this.analyserData = new Uint8Array(this.analyser.fftSize);
            }
            if (this.context.state === "suspended") {
                await this.context.resume();
            }
            this.startLevelPolling();

            let currentTime = Math.max(this.context.currentTime, this.nextPlayTime);
            let lastSource: AudioBufferSourceNode | null = null;

            while (this.queue.length > 0) {
                const audioData = this.queue.shift()!;
                const buffer = this.context.createBuffer(1, audioData.length, 24000);
                buffer.getChannelData(0).set(audioData);
                const source = this.context.createBufferSource();
                source.buffer = buffer;
                source.connect(this.analyser!);
                source.start(currentTime);
                currentTime += buffer.duration;
                lastSource = source;
            }
            this.nextPlayTime = currentTime;

            if (lastSource) {
                const captured = this.sessionId;
                lastSource.onended = () => {
                    if (this.sessionId !== captured) return;
                    this.playing = false;
                    if (this.queue.length > 0) {
                        void this.drain();
                    } else {
                        this.stopLevelPolling();
                        this.callbacks.onPlaybackEnd?.();
                    }
                };
            } else {
                this.playing = false;
            }
        } catch {
            this.playing = false;
            this.nextPlayTime = 0;
        }
    }

    /** Drop queued audio (model was interrupted). */
    interrupt(): void {
        this.queue = [];
        this.nextPlayTime = 0;
        this.playing = false;
        this.stopLevelPolling();
    }

    /** Hard stop: silences scheduled sources by closing the context. */
    stopAll(): void {
        this.sessionId++;
        this.interrupt();
        if (this.context && this.context.state !== "closed") {
            this.context.close().catch(() => { /* ignore */ });
            this.context = null;
            this.analyser = null;
            this.analyserData = null;
        }
    }

    private startLevelPolling(): void {
        if (this.levelRaf !== null) return;
        const poll = () => {
            if (this.analyser && this.analyserData) {
                this.analyser.getByteTimeDomainData(this.analyserData as Uint8Array<ArrayBuffer>);
                let sumSq = 0;
                for (let i = 0; i < this.analyserData.length; i++) {
                    const v = (this.analyserData[i] - 128) / 128;
                    sumSq += v * v;
                }
                const rms = Math.sqrt(sumSq / this.analyserData.length);
                this.callbacks.onLevel?.(Math.min(1, rms * 5));
            }
            this.levelRaf = requestAnimationFrame(poll);
        };
        this.levelRaf = requestAnimationFrame(poll);
    }

    private stopLevelPolling(): void {
        if (this.levelRaf !== null) {
            cancelAnimationFrame(this.levelRaf);
            this.levelRaf = null;
        }
        this.callbacks.onLevel?.(0);
    }
}
