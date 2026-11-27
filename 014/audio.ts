import { COUNT, STRINGS } from "./layout";

const MASTER_GAIN = 0.85;
const PLUCK_GAIN = 0.55; // change loudness here
const WET_GAIN = 0.16;
const ROOM_S = 1.6;
const DAMP_S = 0.012;
const MAX_S = 4.6;
const CACHE_MAX = 48;

type Note = { src: AudioBufferSourceNode; gain: GainNode; f: number };

// VOICE
// Karplus-Strong strings into two body modes, soft top end, short room, gentle limiter
export class Voice {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pans: StereoPannerNode[] = [];
  private keep: AudioNode[] = [];
  private notes: (Note | null)[] = new Array<Note | null>(COUNT).fill(null);
  private cache = new Map<string, AudioBuffer>();
  private muted = false;

  get ready() {
    return this.ctx !== null;
  }

  // UNLOCK
  // call from a user gesture (autoplay policy)
  wake() {
    if (!this.ctx) {
      const AC = window.AudioContext;
      if (typeof AC !== "function") return;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.build(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private build(ctx: AudioContext) {
    const body1 = ctx.createBiquadFilter();
    body1.type = "peaking";
    body1.frequency.value = 196;
    body1.Q.value = 1.3;
    body1.gain.value = 4;
    const body2 = ctx.createBiquadFilter();
    body2.type = "peaking";
    body2.frequency.value = 520;
    body2.Q.value = 1.8;
    body2.gain.value = 2.5;
    const top = ctx.createBiquadFilter();
    top.type = "highshelf";
    top.frequency.value = 3600;
    top.gain.value = -5;
    const room = ctx.createConvolver();
    room.buffer = this.roomBuffer(ctx);
    const wet = ctx.createGain();
    wet.gain.value = WET_GAIN;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -12;
    limit.knee.value = 14;
    limit.ratio.value = 8;
    limit.attack.value = 0.004;
    limit.release.value = 0.28;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;

    body1.connect(body2).connect(top);
    top.connect(limit);
    top.connect(room).connect(wet).connect(limit);
    limit.connect(master).connect(ctx.destination);
    for (let i = 0; i < COUNT; i++) {
      const p = ctx.createStereoPanner();
      p.pan.value = STRINGS[i].pan;
      p.connect(body1);
      this.pans.push(p);
    }
    this.master = master;
    this.keep.push(body1, body2, top, room, wet, limit, master);
  }

  private roomBuffer(ctx: AudioContext) {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * ROOM_S);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let t = 0; t < n; t++) {
        const u = t / n;
        const a = 0.9 - 0.75 * u;
        lp += a * (Math.random() * 2 - 1 - lp);
        d[t] = lp * Math.pow(1 - u, 2.4) * (t < sr * 0.012 ? t / (sr * 0.012) : 1);
      }
    }
    return buf;
  }

  // PLUCK
  // p: pluck point 0..1, amt: 0..1 how hard
  pluck(i: number, f: number, p: number, amt: number, t60: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const old = this.notes[i];
    if (old) {
      old.gain.gain.setTargetAtTime(0, now, DAMP_S);
      old.src.stop(now + DAMP_S * 8);
    }
    const bright = Math.min(1, 0.35 + amt * 0.65);
    const buf = this.string(ctx, f, p, bright, t60);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = PLUCK_GAIN * Math.pow(Math.min(1, amt), 0.8);
    src.connect(gain).connect(this.pans[i]);
    const note: Note = { src, gain, f };
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
      if (this.notes[i] === note) this.notes[i] = null;
    };
    src.start(now);
    this.notes[i] = note;
  }

  bend(i: number, f: number) {
    const note = this.notes[i];
    if (!this.ctx || !note) return;
    note.src.playbackRate.setTargetAtTime(f / note.f, this.ctx.currentTime, 0.02);
  }

  mute(on: boolean) {
    this.muted = on;
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(on ? 0 : MASTER_GAIN, now, 0.03);
  }

  // KARPLUS-STRONG
  // noise burst in a one-period delay loop with averaging filter; allpass for the fraction
  private string(ctx: AudioContext, f: number, p: number, bright: number, t60: number) {
    const pq = Math.round(Math.min(0.9, Math.max(0.1, p)) * 10);
    const bq = Math.round(bright * 4);
    const key = `${f.toFixed(1)}:${pq}:${bq}:${t60.toFixed(1)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const sr = ctx.sampleRate;
    const dur = Math.min(MAX_S, t60 * 1.05);
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const period = sr / f - 0.5;
    const n = Math.max(2, Math.floor(period));
    const frac = Math.max(0.05, period - n);
    const c = (1 - frac) / (1 + frac);
    const rho = Math.min(0.99995, Math.pow(0.001, 1 / (f * t60)) / Math.cos((Math.PI * f) / sr));

    const line = new Float32Array(n);
    const a = 0.25 + bright * 0.55;
    let lp = 0;
    for (let t = 0; t < n; t++) {
      lp += a * (Math.random() * 2 - 1 - lp);
      line[t] = lp;
    }
    // PLUCK POSITION
    // comb filter: removes harmonics with a node at the pluck point
    const off = Math.max(1, Math.round((pq / 10) * n));
    const tmp = Float32Array.from(line);
    let mean = 0;
    let peak = 0;
    for (let t = 0; t < n; t++) {
      line[t] = tmp[t] - tmp[(t + off) % n];
      mean += line[t];
    }
    mean /= n;
    for (let t = 0; t < n; t++) {
      line[t] -= mean;
      peak = Math.max(peak, Math.abs(line[t]));
    }
    const norm = peak > 0 ? 1 / peak : 1;
    for (let t = 0; t < n; t++) line[t] *= norm;

    let idx = 0;
    let prev = 0;
    let apIn = 0;
    let apOut = 0;
    const fade = Math.floor(sr * 0.08);
    for (let t = 0; t < len; t++) {
      const s0 = line[idx];
      const lpv = rho * 0.5 * (s0 + prev);
      prev = s0;
      const ap = c * lpv + apIn - c * apOut;
      apIn = lpv;
      apOut = ap;
      line[idx] = ap;
      idx = idx + 1 === n ? 0 : idx + 1;
      out[t] = t > len - fade ? (s0 * (len - t)) / fade : s0;
    }

    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, buf);
    return buf;
  }

  dispose() {
    for (const n of this.notes) {
      if (!n) continue;
      n.src.onended = null;
      n.src.disconnect();
      n.gain.disconnect();
    }
    this.notes.fill(null);
    for (const p of this.pans) p.disconnect();
    for (const k of this.keep) k.disconnect();
    this.pans.length = 0;
    this.keep.length = 0;
    this.cache.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
