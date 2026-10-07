/**
 * Award sound cues, synthesised with Web Audio (no files to load): the "shink" of a badge locking in,
 * a soft boom, a stone "tok", a glass "plink", a chime, a wooden "clack". Owner, 2026-10-07: "boom,
 * that image's locked, shink, the little sound effect". Quiet by design (peak about -12 dB), played
 * only after the user's own tap opened the award (the browser's rule for sound), and never when the
 * player is muted. A missing AudioContext plays nothing.
 */

export type Cue = "shink" | "boom" | "tok" | "plink" | "chime" | "clack" | "whoosh";

let shared: AudioContext | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
/** Every cue plays through this bus, so `silence()` can stop sounds already playing. */
let bus: GainNode | null = null;
function output(ctx: AudioContext): GainNode {
  if (!bus) { bus = ctx.createGain(); bus.connect(ctx.destination); }
  return bus;
}

/** Stops every cue now (mute, Skip, close). The next cue plays on a fresh bus. */
export function silence(): void {
  if (!shared || !bus) return;
  const old = bus;
  bus = null;
  old.gain.setTargetAtTime(0, shared.currentTime, 0.015);
  setTimeout(() => old.disconnect(), 120);
}
function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  shared ??= new Ctor();
  if (shared.state === "suspended") void shared.resume();
  // Rest the audio device a few seconds after the last cue.
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { if (shared?.state === "running") void shared.suspend(); }, 4000);
  return shared;
}

/** Call from the tap that opens an award: browsers let sound start only inside a user gesture. */
export function unlockAudio(): void {
  context();
}

function noise(ctx: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  return source;
}

function envelope(ctx: AudioContext, at: number, peak: number, attack: number, decay: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return gain;
}

function tone(ctx: AudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number,
  peak: number, decay: number) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + decay);
  const gain = envelope(ctx, at, peak, 0.005, decay);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.05);
}

export function play(cue: Cue): void {
  const ctx = context();
  if (!ctx) return;
  const at = ctx.currentTime + 0.01;
  const out = ctx.createGain();
  out.gain.value = 0.25;
  out.connect(output(ctx));
  switch (cue) {
    case "shink": {
      // A blade drawn across metal: a bright noise swish and a ringing high partial.
      const hiss = noise(ctx, 0.35);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(3500, at);
      band.frequency.exponentialRampToValueAtTime(9000, at + 0.18);
      band.Q.value = 6;
      hiss.connect(band).connect(envelope(ctx, at, 0.9, 0.01, 0.25)).connect(out);
      hiss.start(at);
      tone(ctx, out, at + 0.04, "triangle", 2600, 3200, 0.5, 0.6);
      tone(ctx, out, at + 0.04, "sine", 5200, 5300, 0.2, 0.5);
      break;
    }
    case "boom": {
      tone(ctx, out, at, "sine", 120, 38, 1, 0.7);
      const rumble = noise(ctx, 0.6);
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 400;
      rumble.connect(low).connect(envelope(ctx, at, 0.6, 0.005, 0.5)).connect(out);
      rumble.start(at);
      break;
    }
    case "tok": tone(ctx, out, at, "sine", 900, 420, 0.7, 0.09); break;
    case "clack": tone(ctx, out, at, "square", 620, 300, 0.25, 0.07); tone(ctx, out, at + 0.07, "square", 520, 260, 0.2, 0.07); break;
    case "plink": tone(ctx, out, at, "sine", 1800, 1500, 0.5, 0.35); break;
    case "chime": tone(ctx, out, at, "sine", 880, 880, 0.4, 1.1); tone(ctx, out, at + 0.08, "sine", 1320, 1320, 0.3, 1.2); break;
    case "whoosh": {
      const air = noise(ctx, 0.5);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(400, at);
      band.frequency.exponentialRampToValueAtTime(2400, at + 0.4);
      air.connect(band).connect(envelope(ctx, at, 0.5, 0.15, 0.3)).connect(out);
      air.start(at);
      break;
    }
  }
}

const MUTE_KEY = "care:sound-muted";
/** This visit's choice: what Sound off says when storage is missing or refuses (a private window). */
let mutedThisVisit: boolean | null = null;
/**
 * A per-device convenience: a muted player stays muted, and every sound in the well (the award
 * player, the shop's chime) reads it. With no storage the choice holds for this visit; with none made,
 * sound is on.
 */
export function readMuted(): boolean {
  try {
    const stored = window.localStorage.getItem(MUTE_KEY);
    if (stored !== null) return stored === "1";
  } catch { /* fall back to this visit's choice */ }
  return mutedThisVisit ?? false;
}
export function writeMuted(muted: boolean): void {
  mutedThisVisit = muted;
  try { window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* this visit only */ }
}
