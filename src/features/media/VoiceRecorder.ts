// Voice-message recorder. Records via MediaRecorder (preferring audio/mp4 where
// supported, else audio/webm;opus) fed by getUserMedia, and meters live levels
// via a WebAudio AnalyserNode sampled at ~20 Hz. Levels are downsampled to ~100
// waveform points on stop.
//
// The recorder is a plain class: the composer owns one, polls `levels`/
// `duration` for the live UI, and calls stop() to get the Recording payload
// (bytes, duration, downsampled waveform) to send.

const METER_HZ = 20; // ~0.05s
const WAVEFORM_POINTS = 100;
const MIN_DURATION_SECS = 0.5; // shorter releases are treated as taps

export interface Recording {
  bytes: ArrayBuffer;
  mimetype: string;
  durationSecs: number;
  /** ~100 normalized (0..1) waveform samples. */
  waveform: number[];
}

/** Pick the best supported audio mime, preferring mp4/AAC. */
function preferredMime(): string {
  const candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "audio/webm";
}

export class VoiceRecorder {
  /** Live 0..1 levels, appended at ~20 Hz. UI reads the tail for the meter. */
  readonly levels: number[] = [];
  /** Live duration in seconds. */
  duration = 0;
  /** Set true if the system tore down the stream (interruption). */
  interrupted = false;

  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private mimetype = "audio/webm";
  private audioCtx?: AudioContext;
  private analyser?: AnalyserNode;
  private meterTimer?: number;
  private startedAt = 0;
  private stopping = false;

  /** True once recording has actually begun. */
  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /**
   * Request the mic and begin recording. Throws if permission is denied or the
   * browser lacks MediaRecorder. Resolves once recording is live.
   */
  async start(): Promise<void> {
    if (this.recorder) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mimetype = preferredMime();
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimetype });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    // A stream ending underneath us (device unplugged / OS interruption).
    this.stream.getAudioTracks().forEach((t) => {
      t.onended = () => {
        if (!this.stopping) {
          this.interrupted = true;
          this.teardownMeter();
        }
      };
    });

    // WebAudio meter.
    try {
      this.audioCtx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
    } catch {
      this.analyser = undefined;
    }

    this.startedAt = performance.now();
    this.recorder.start();
    this.meterTimer = window.setInterval(() => this.sample(), 1000 / METER_HZ);
  }

  private sample(): void {
    this.duration = (performance.now() - this.startedAt) / 1000;
    if (!this.analyser) {
      this.levels.push(0);
      return;
    }
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    // RMS around the 128 midpoint, normalized to 0..1.
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    // dB to level curve: 20*log10(rms) in [-160,0], mapped as (db+50)/50.
    const db = rms > 0 ? 20 * Math.log10(rms) : -160;
    const level = Math.max(0, Math.min(1, (db + 50) / 50));
    this.levels.push(level);
  }

  private teardownMeter(): void {
    if (this.meterTimer !== undefined) {
      clearInterval(this.meterTimer);
      this.meterTimer = undefined;
    }
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = undefined;
    this.analyser = undefined;
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }

  /**
   * Stop recording. Returns a Recording only if not cancelled and the duration
   * reached the 0.5s minimum; otherwise returns undefined (and discards bytes).
   * Idempotent-ish: safe to call once per recorder.
   */
  async stop(cancelled: boolean): Promise<Recording | undefined> {
    this.stopping = true;
    const recorder = this.recorder;
    this.teardownMeter();
    if (!recorder) {
      this.stopTracks();
      return undefined;
    }
    const finalDuration = this.duration;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mimetype }));
      try {
        if (recorder.state !== "inactive") recorder.stop();
        else resolve(new Blob(this.chunks, { type: this.mimetype }));
      } catch {
        resolve(new Blob(this.chunks, { type: this.mimetype }));
      }
    });
    this.stopTracks();
    this.recorder = undefined;

    if (cancelled || finalDuration < MIN_DURATION_SECS) return undefined;

    const waveform = downsample(this.levels, WAVEFORM_POINTS);
    return {
      bytes: await blob.arrayBuffer(),
      mimetype: this.mimetype.split(";")[0],
      durationSecs: finalDuration,
      waveform,
    };
  }
}

/** Downsample a level array to `points` buckets, taking the max per bucket. */
function downsample(levels: number[], points: number): number[] {
  if (levels.length === 0) return [];
  if (levels.length <= points) return levels.slice();
  const out: number[] = [];
  const bucket = levels.length / points;
  for (let i = 0; i < points; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.min(levels.length, Math.floor((i + 1) * bucket));
    let max = 0;
    for (let j = start; j < end; j++) if (levels[j] > max) max = levels[j];
    out.push(max);
  }
  return out;
}
