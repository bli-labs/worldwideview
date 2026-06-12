export class AudioLevelMonitor {
    private context: AudioContext | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private raf = 0;

    constructor(private readonly onLevel?: (level: number) => void) {}

    start(stream: MediaStream): void {
        this.stop();
        this.context = new AudioContext();
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        this.source = this.context.createMediaStreamSource(stream);
        this.source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);

        const tick = () => {
            analyser.getByteTimeDomainData(data);
            let sumSq = 0;
            for (const sample of data) {
                const centered = (sample - 128) / 128;
                sumSq += centered * centered;
            }
            const rms = Math.sqrt(sumSq / data.length);
            this.onLevel?.(Math.min(1, rms * 8));
            this.raf = window.requestAnimationFrame(tick);
        };
        tick();
    }

    stop(): void {
        if (this.raf) {
            window.cancelAnimationFrame(this.raf);
            this.raf = 0;
        }
        if (this.source) {
            try { this.source.disconnect(); } catch { /* already disconnected */ }
            this.source = null;
        }
        if (this.context && this.context.state !== "closed") {
            this.context.close().catch(() => { /* best effort */ });
            this.context = null;
        }
        this.onLevel?.(0);
    }
}
