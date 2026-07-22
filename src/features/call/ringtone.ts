// Synthesized classic telephone ring.
//
// No shipped audio asset: two OscillatorNodes (440 Hz + 480 Hz) gated by a gain
// envelope (2s on / 4s silent over a 6s loop) via the Web Audio API. Autoplay of
// a ring requires the tab to have prior user interaction; start() best-efforts a
// resume() and silently no-ops if the context is blocked.

export class RingtonePlayer {
  private ctx?: AudioContext;
  private oscA?: OscillatorNode;
  private oscB?: OscillatorNode;
  private gain?: GainNode;
  private loopTimer?: ReturnType<typeof setTimeout>;
  private playing = false;

  start(): void {
    if (this.playing) return;
    this.playing = true;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      void ctx.resume().catch(() => {});

      const gain = ctx.createGain();
      gain.gain.value = 0; // start silent; the envelope raises it
      gain.connect(ctx.destination);
      this.gain = gain;

      const oscA = ctx.createOscillator();
      oscA.type = "sine";
      oscA.frequency.value = 440;
      const oscB = ctx.createOscillator();
      oscB.type = "sine";
      oscB.frequency.value = 480;
      oscA.connect(gain);
      oscB.connect(gain);
      oscA.start();
      oscB.start();
      this.oscA = oscA;
      this.oscB = oscB;

      this.scheduleCycle();
    } catch {
      this.playing = false;
    }
  }

  /** One 6s cycle: 2s tone (with 20ms fades), 4s silence, then repeat. */
  private scheduleCycle = (): void => {
    if (!this.playing || !this.ctx || !this.gain) return;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    const amp = 0.35; // combined; each osc effectively ~0.22
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(amp, now + 0.02); // fade in
    g.setValueAtTime(amp, now + 1.98);
    g.linearRampToValueAtTime(0, now + 2.0); // fade out
    this.loopTimer = setTimeout(this.scheduleCycle, 6000);
  };

  stop(): void {
    this.playing = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = undefined;
    }
    try {
      this.oscA?.stop();
      this.oscB?.stop();
    } catch {
      /* already stopped */
    }
    this.oscA = undefined;
    this.oscB = undefined;
    this.gain = undefined;
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
  }
}
