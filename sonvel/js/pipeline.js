// Sonvel processing chain. Stage A keeps the timeline (repair). Stage B edits and masters.
// Order: decode -> mono/48k -> noise -> de-click -> breath | filler cut -> silence trim ->
//        de-ess -> EQ preset -> leveling -> speed/pitch -> music -> loudness+limiter -> fades
import * as D from './dsp.js';

export const RN_FRAME = 480;
export const RN_DELAY = 960; // measured latency of @shiguredo/rnnoise-wasm (samples @48k)

export const DEFAULT_SETTINGS = {
  noise: { on: true, strength: 0.9 },
  declick: { on: true },
  breath: { on: true, amount: 12 },
  fillers: { on: true, hindi: true },
  trim: { on: true, maxPause: 0.4 },
  deess: { on: true, amount: 0.5 },
  voice: { preset: 'natural' },
  level: { on: true, amount: 0.6 },
  speed: { tempo: 1, semitones: 0 },
  music: { on: false, volume: 0.22, duck: true },
  loud: { preset: 'youtube', target: -14, tp: -1 },
  fades: { in: 0.04, out: 0.25 },
};

export const MAGIC_SETTINGS = (s = DEFAULT_SETTINGS) => ({
  ...structuredCloneSafe(s),
  noise: { on: true, strength: s.noise?.strength ?? 0.9 },
  declick: { on: true },
  breath: { on: true, amount: 12 },
  trim: { on: true, maxPause: s.trim?.maxPause ?? 0.4 },
  deess: { on: true, amount: 0.5 },
  voice: { preset: 'natural' },
  level: { on: true, amount: 0.6 },
  loud: { preset: 'youtube', target: -14, tp: -1 },
});

export function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

// RNNoise over a whole buffer. `state` exposes processFrame(Float32Array(480)) -> vad.
export function denoise(x, state, strength = 1, onProgress) {
  const n = x.length;
  const padded = new Float32Array(n + RN_DELAY + RN_FRAME);
  padded.set(x);
  const wet = new Float32Array(padded.length);
  const frames = Math.floor(padded.length / RN_FRAME);
  const vad = new Float32Array(frames);
  const f = new Float32Array(RN_FRAME);
  for (let k = 0; k < frames; k++) {
    const o = k * RN_FRAME;
    for (let i = 0; i < RN_FRAME; i++) f[i] = padded[o + i] * 32768;
    vad[k] = state.processFrame(f);
    for (let i = 0; i < RN_FRAME; i++) wet[o + i] = f[i] / 32768;
    if (onProgress && (k & 255) === 0) onProgress(k / frames);
  }
  const y = new Float32Array(n);
  const s = Math.max(0, Math.min(1, strength));
  for (let i = 0; i < n; i++) y[i] = wet[i + RN_DELAY] * s + x[i] * (1 - s);
  // shift VAD by the delay (2 frames) so it lines up with the source timeline
  const shift = RN_DELAY / RN_FRAME;
  const vadAligned = new Float32Array(Math.ceil(n / RN_FRAME));
  for (let k = 0; k < vadAligned.length; k++) vadAligned[k] = vad[Math.min(vad.length - 1, k + shift)];
  return { y, vad: vadAligned };
}

// Stage A: repair without changing the timeline.
export async function stageA(x, s, { rnnoise = null, progress = () => {} } = {}) {
  let y = x; let vad = null; const stats = {};
  if (s.noise.on && rnnoise) {
    progress('noise', 0);
    const st = rnnoise.createDenoiseState();
    const r = denoise(y, st, s.noise.strength, (p) => progress('noise', p));
    st.destroy?.();
    y = r.y; vad = r.vad;
  }
  if (s.declick.on) { progress('declick', 0); const r = D.declick(y); y = r.y; stats.clicks = r.count; }
  if (s.breath.on) { progress('breath', 0); const r = D.reduceBreaths(y, { amountDb: s.breath.amount, vad, vadHop: RN_FRAME }); y = r.y; stats.breaths = r.count; }
  if (y === x) y = Float32Array.from(x);
  return { y, vad, stats };
}

// Stage B. fillerSpans are on the stage-A (= original) timeline.
export async function stageB(a, s, { fillerSpans = [], music = null, soundtouch = null, progress = () => {}, allowCuts = true } = {}) {
  const sr = D.SR; const chain = []; const stats = { fillersRemoved: 0, silenceRemoved: 0 };
  let y = a;
  if (allowCuts && s.fillers.on && fillerSpans.length) {
    progress('fillers', 0);
    const pad = 0.015;
    const keeps = D.spansToKeeps(fillerSpans.map((f) => [f.start - pad, f.end + pad]), y.length / sr);
    const r = D.applyKeeps(y, keeps, { xfadeMs: 15 });
    chain.push({ type: 'cut', map: r.map }); y = r.y; stats.fillersRemoved = fillerSpans.length;
  }
  if (allowCuts && s.trim.on) {
    progress('trim', 0);
    const t = D.silenceKeeps(y, { maxPause: s.trim.maxPause });
    const r = D.applyKeeps(y, t.keeps, { xfadeMs: 20 });
    chain.push({ type: 'cut', map: r.map }); stats.silenceRemoved = (y.length - r.y.length) / sr; y = r.y; stats.gapsShortened = t.gaps;
  }
  if (s.deess.on) { progress('deess', 0); y = D.deess(y, { amount: s.deess.amount }); }
  progress('eq', 0);
  y = D.applyVoicePreset(y, s.voice.preset);
  const lp = D.LOUDNESS_PRESETS[s.loud.preset] || D.LOUDNESS_PRESETS.custom;
  if (lp.brighten) y = D.brighten(y);
  if (s.level.on) { progress('level', 0); y = D.levelVoice(y, { amount: s.level.amount }); }
  const tempo = s.speed.tempo || 1, semis = s.speed.semitones || 0;
  if ((Math.abs(tempo - 1) > 1e-3 || Math.abs(semis) > 1e-3) && soundtouch) {
    progress('speed', 0);
    y = timeStretch(y, soundtouch, allowCuts ? tempo : 1, Math.pow(2, semis / 12), (p) => progress('speed', p));
    if (allowCuts && Math.abs(tempo - 1) > 1e-3) chain.push({ type: 'speed', tempo });
  }
  if (s.music.on && music && music.length) { progress('music', 0); y = D.mixMusic(y, music, { volume: s.music.volume, duck: s.music.duck }); }
  progress('loudness', 0);
  const target = s.loud.preset === 'custom' ? s.loud.target : lp.target;
  const tp = s.loud.preset === 'custom' ? s.loud.tp : lp.tp;
  const n = D.normalizeLoudness(y, target, tp);
  y = D.applyFades(n.y, s.fades.in, s.fades.out);
  progress('done', 1);
  stats.lufs = D.measureLUFS(y); stats.truePeak = D.truePeakDb(y); stats.target = target; stats.ceiling = tp;
  stats.inDuration = a.length / sr; stats.outDuration = y.length / sr;
  return { y, chain, stats };
}

// Pitch-preserving tempo + pitch via SoundTouch (soundtouchjs). st = { SoundTouch, SimpleFilter }.
export function timeStretch(x, st, tempo, pitch, onProgress) {
  const engine = new st.SoundTouch();
  engine.tempo = tempo; engine.pitch = pitch;
  const tail = Math.round(D.SR * 0.3);
  const total = x.length + tail;
  const source = {
    extract(target, numFrames, position) {
      const n = Math.max(0, Math.min(numFrames, total - position));
      for (let i = 0; i < n; i++) { const v = position + i < x.length ? x[position + i] : 0; target[2 * i] = v; target[2 * i + 1] = v; }
      return n;
    },
  };
  const filter = new st.SimpleFilter(source, engine);
  const expected = Math.round(x.length / tempo);
  const out = new Float32Array(expected + tail);
  const BUF = 8192; const tmp = new Float32Array(BUF * 2); let w = 0;
  for (;;) {
    const got = filter.extract(tmp, BUF);
    if (!got) break;
    for (let i = 0; i < got && w < out.length; i++) out[w++] = tmp[2 * i];
    if (onProgress) onProgress(Math.min(1, w / expected));
    if (w >= out.length) break;
  }
  return out.subarray(0, Math.min(w, expected));
}
