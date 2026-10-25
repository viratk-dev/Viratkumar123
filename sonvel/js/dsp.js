// Sonvel DSP core. Pure functions on mono Float32Array at 48 kHz.
// No DOM, no Web Audio: runs in the main thread, a Web Worker and Node (tests).

export const SR = 48000;
const EPS = 1e-12;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, EPS));

/* ---------------------------------------------------------------- biquads */
// RBJ cookbook designs. Returns normalised {b0,b1,b2,a1,a2}.
export function biquadCoefs(type, f0, q = 0.707, gainDb = 0, sr = SR) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.49)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    default: throw new Error('unknown biquad ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Transposed direct form II. Writes into out (may equal x).
export function biquad(x, c, out = new Float32Array(x.length)) {
  let z1 = 0, z2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + z1;
    z1 = b1 * xi - a1 * y + z2;
    z2 = b2 * xi - a2 * y;
    out[i] = y;
  }
  return out;
}

export function applyFilters(x, list, sr = SR) {
  let y = x;
  for (const f of list) y = biquad(y, biquadCoefs(f.type, f.f, f.q ?? 0.707, f.g ?? 0, sr), y === x ? undefined : y);
  return y === x ? Float32Array.from(x) : y;
}

/* ---------------------------------------------------------------- levels */
export function frameRmsDb(x, hop, win = hop) {
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0; const o = f * hop;
    for (let i = 0; i < win && o + i < x.length; i++) s += x[o + i] * x[o + i];
    out[f] = 10 * Math.log10(s / win + EPS);
  }
  return out;
}

export function percentile(arr, p) {
  if (!arr.length) return -120;
  const a = Array.from(arr).sort((m, n) => m - n);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

// Noise floor and typical speech level, from 10 ms frames.
export function analyzeLevels(x, sr = SR) {
  const hop = Math.round(sr * 0.01);
  const db = frameRmsDb(x, hop);
  const valid = Array.from(db).filter((v) => v > -100);
  const floor = percentile(valid, 0.1);
  const speech = percentile(valid, 0.9);
  return { db, hop, floor, speech };
}

/* ------------------------------------------------------- loudness (BS.1770) */
function kWeightCoefs(sr) {
  if (sr === 48000) {
    return [
      { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
      { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 },
    ];
  }
  // Generic re-derivation (pyloudnorm constants) for other rates.
  const G = 3.99984385397, Q = 0.7071752369554193, fc = 1681.974450955533;
  const A = Math.pow(10, G / 40), K = Math.tan((Math.PI * fc) / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.499666774155);
  const a0 = 1 + K / Q + K * K;
  const s1 = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  void A;
  const fc2 = 38.13547087613982, Q2 = 0.5003270373253953, K2 = Math.tan((Math.PI * fc2) / sr);
  const d = 1 + K2 / Q2 + K2 * K2;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K2 * K2 - 1)) / d, a2: (1 - K2 / Q2 + K2 * K2) / d };
  return [s1, s2];
}

export function kWeight(x, sr = SR) {
  const [c1, c2] = kWeightCoefs(sr);
  return biquad(biquad(x, c1), c2);
}

// Integrated loudness in LUFS (mono, channel weight 1.0) with gating.
export function measureLUFS(x, sr = SR) {
  const y = kWeight(x, sr);
  const block = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
  if (y.length < block) {
    let s = 0; for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    return y.length ? -0.691 + 10 * Math.log10(s / y.length + EPS) : -Infinity;
  }
  // prefix sums of squares for O(n) block energies
  const zs = [];
  let acc = 0; const pref = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) { acc += y[i] * y[i]; pref[i + 1] = acc; }
  for (let o = 0; o + block <= y.length; o += step) zs.push((pref[o + block] - pref[o]) / block);
  const L = (z) => -0.691 + 10 * Math.log10(z + EPS);
  const abs = zs.filter((z) => L(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  if (!gated.length) return -Infinity;
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/* ---------------------------------------------------- true peak (4x oversample) */
const TP_PHASES = 4, TP_TAPS = 12;
const TP_KERNEL = (() => {
  // windowed-sinc polyphase interpolator; phase p gives value at n + p/4
  const k = [];
  for (let p = 1; p < TP_PHASES; p++) {
    const frac = p / TP_PHASES; const taps = new Float32Array(TP_TAPS);
    for (let t = 0; t < TP_TAPS; t++) {
      const m = t - TP_TAPS / 2 + 1 - frac; // distance from sample
      const sinc = m === 0 ? 1 : Math.sin(Math.PI * m) / (Math.PI * m);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * m) / (TP_TAPS / 2 + 1));
      taps[t] = sinc * w;
    }
    k.push(taps);
  }
  return k;
})();

// Per-sample true-peak envelope: max |x| over the sample and the 3 interpolated points after it.
export function truePeakEnvelope(x) {
  const n = x.length; const env = new Float32Array(n);
  const half = TP_TAPS / 2 - 1;
  for (let i = 0; i < n; i++) {
    let m = Math.abs(x[i]);
    if (i >= half && i + TP_TAPS - half < n) {
      for (let p = 0; p < TP_PHASES - 1; p++) {
        const k = TP_KERNEL[p]; let s = 0; const base = i - half;
        for (let t = 0; t < TP_TAPS; t++) s += k[t] * x[base + t];
        const a = Math.abs(s); if (a > m) m = a;
      }
    }
    env[i] = m;
  }
  return env;
}

export function truePeakDb(x) {
  const e = truePeakEnvelope(x); let m = 0;
  for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i];
  return gainToDb(m);
}

/* ---------------------------------------------------------------- limiter */
// Lookahead brickwall limiter on the true-peak envelope. Time aligned (no added delay).
export function limitTruePeak(x, ceilingDb = -1, { lookaheadMs = 1.5, releaseMs = 80, sr = SR } = {}) {
  const ceil = dbToGain(ceilingDb - 0.15);
  const L = Math.max(2, Math.round((lookaheadMs / 1000) * sr));
  const n = x.length;
  const env = truePeakEnvelope(x);
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = env[i] > ceil ? ceil / env[i] : 1;
  const gx = (k) => (k < n ? g[k] : 1);
  // m[i] = min(g[i .. i+L-1])  (look ahead), monotonic deque
  const m = new Float32Array(n); const dq = new Int32Array(n + L); let h = 0, t = 0;
  for (let k = 0; k < n + L - 1; k++) {
    const v = gx(k);
    while (t > h && gx(dq[t - 1]) >= v) t--;
    dq[t++] = k;
    const i = k - L + 1;
    if (dq[h] < i) h++;
    if (i >= 0 && i < n) m[i] = gx(dq[h]);
  }
  // box[j] = mean(m[j-L+1 .. j]) <= g[j]; gives a smooth attack that completes in time
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  const out = new Float32Array(n); let s = 0, e = 1;
  for (let j = 0; j < n; j++) {
    s += m[j]; if (j >= L) s -= m[j - L];
    const box = j >= L - 1 ? s / L : (s + (L - 1 - j)) / L; // pad history with unity gain
    e = box < e ? box : box + (e - box) * rel;
    out[j] = x[j] * e;
  }
  for (let i = 0; i < n; i++) { if (out[i] > ceil) out[i] = ceil; else if (out[i] < -ceil) out[i] = -ceil; }
  return out;
}

export function scale(x, gain) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * gain; return y; }

// Normalise to target LUFS with a true-peak ceiling. Iterates to land within ~0.3 LU.
export function normalizeLoudness(x, targetLufs = -14, ceilingDb = -1, sr = SR) {
  const L0 = measureLUFS(x, sr);
  if (!isFinite(L0)) return { y: Float32Array.from(x), lufs: L0, tp: truePeakDb(x), gainDb: 0 };
  let gainDb = targetLufs - L0;
  let y = limitTruePeak(scale(x, dbToGain(gainDb)), ceilingDb, { sr });
  for (let it = 0; it < 6; it++) {
    const L = measureLUFS(y, sr);
    const d = targetLufs - L;
    if (Math.abs(d) < 0.15) break;
    gainDb += d;
    y = limitTruePeak(scale(x, dbToGain(gainDb)), ceilingDb, { sr });
  }
  return { y, lufs: measureLUFS(y, sr), tp: truePeakDb(y), gainDb };
}

/* ---------------------------------------------------------------- compressor */
export function compress(x, { thresholdDb = -20, ratio = 3, kneeDb = 6, attackMs = 5, releaseMs = 120, makeupDb = 0, sr = SR } = {}) {
  const at = Math.exp(-1 / ((attackMs / 1000) * sr)), rt = Math.exp(-1 / ((releaseMs / 1000) * sr));
  const y = new Float32Array(x.length); let env = 0; const mk = dbToGain(makeupDb);
  for (let i = 0; i < x.length; i++) {
    const p = x[i] * x[i];
    env = p > env ? at * env + (1 - at) * p : rt * env + (1 - rt) * p;
    const lvl = 10 * Math.log10(env + EPS);
    const over = lvl - thresholdDb;
    let gr = 0;
    if (over > kneeDb / 2) gr = over * (1 / ratio - 1);
    else if (over > -kneeDb / 2) gr = ((1 / ratio - 1) * (over + kneeDb / 2) ** 2) / (2 * kneeDb);
    y[i] = x[i] * dbToGain(gr) * mk;
  }
  return y;
}

/* ----------------------------------------------------- leveling (gentle AGC) */
export function levelVoice(x, { amount = 0.6, maxBoostDb = 9, maxCutDb = 8, sr = SR } = {}) {
  if (amount <= 0) return Float32Array.from(x);
  const hop = Math.round(sr * 0.05), win = Math.round(sr * 0.4);
  const n = Math.max(1, Math.floor(x.length / hop));
  const pref = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pref[i + 1] = pref[i] + x[i] * x[i];
  const lvl = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const c = f * hop + hop / 2; const a = Math.max(0, Math.round(c - win / 2)), b = Math.min(x.length, Math.round(c + win / 2));
    lvl[f] = 10 * Math.log10((pref[b] - pref[a]) / Math.max(1, b - a) + EPS);
  }
  const { floor, speech } = analyzeLevels(x, sr);
  const gate = Math.max(floor + 10, speech - 30);
  const voiced = Array.from(lvl).filter((v) => v > gate);
  if (voiced.length < 3) return Float32Array.from(x);
  const target = percentile(voiced, 0.6);
  const des = new Float32Array(n); let prev = 0;
  for (let f = 0; f < n; f++) {
    if (lvl[f] > gate) prev = Math.max(-maxCutDb, Math.min(maxBoostDb, target - lvl[f])) * amount;
    else prev = Math.min(prev, 0) * 0.98 + 0; // never boost pauses/noise; drift back toward 0
    des[f] = prev;
  }
  // smooth: 250 ms one-pole forward + backward (zero-phase)
  const a = Math.exp(-hop / (0.25 * sr));
  for (let f = 1; f < n; f++) des[f] = a * des[f - 1] + (1 - a) * des[f];
  for (let f = n - 2; f >= 0; f--) des[f] = a * des[f + 1] + (1 - a) * des[f];
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const fp = i / hop - 0.5; const f0 = Math.max(0, Math.min(n - 1, Math.floor(fp))); const f1 = Math.min(n - 1, f0 + 1);
    const t = Math.max(0, Math.min(1, fp - f0));
    y[i] = x[i] * dbToGain(des[f0] * (1 - t) + des[f1] * t);
  }
  return y;
}

/* ---------------------------------------------------------------- de-click */
// Detects short impulsive transients (clicks, pops, mouth noise) on the 2nd difference
// and repairs them with cubic Hermite interpolation across the damaged span.
export function declick(x, { sensitivity = 0.6, maxClickMs = 3, sr = SR } = {}) {
  const n = x.length; const y = Float32Array.from(x);
  if (n < 1024) return { y, count: 0 };
  const d = new Float32Array(n);
  for (let i = 2; i < n; i++) d[i] = x[i] - 2 * x[i - 1] + x[i - 2];
  // local RMS of d over ~20 ms (prefix sums)
  const w = Math.round(sr * 0.02); const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + d[i] * d[i];
  const k = 9 - 4 * sensitivity; // threshold multiplier (lower = more sensitive)
  const maxLen = Math.round((maxClickMs / 1000) * sr), pad = Math.round(sr * 0.0006);
  let count = 0; let i = 2;
  while (i < n - 2) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w);
    const loc = Math.sqrt((pref[b] - pref[a]) / (b - a) + EPS);
    if (Math.abs(d[i]) > k * loc && Math.abs(d[i]) > 0.02) {
      // span of the transient
      let e = i; while (e < n - 2 && e - i < maxLen * 2 && Math.abs(d[e]) > (k * loc) / 3) e++;
      const len = e - i;
      if (len <= maxLen) {
        const s0 = Math.max(2, i - pad - 1), s1 = Math.min(n - 3, e + pad);
        hermiteFill(y, s0, s1);
        count++;
      }
      i = e + pad + 1;
    } else i++;
  }
  return { y, count };
}

function hermiteFill(y, a, b) {
  const p0 = y[a], p1 = y[b];
  const m0 = (y[a] - y[a - 2]) / 2 * (b - a), m1 = (y[b + 2] - y[b]) / 2 * (b - a);
  for (let i = a + 1; i < b; i++) {
    const t = (i - a) / (b - a), t2 = t * t, t3 = t2 * t;
    y[i] = (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
  }
}

/* --------------------------------------------------------- breath reduction */
// Finds low-energy, air-heavy segments between words and ducks them.
export function reduceBreaths(x, { amountDb = 12, vad = null, vadHop = 480, sr = SR } = {}) {
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.02);
  const nf = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const hp = biquad(x, biquadCoefs('highpass', 1800, 0.707, 0, sr));
  const { floor, speech } = analyzeLevels(x, sr);
  const flags = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0, sh = 0, zc = 0; const o = f * hop;
    for (let i = 0; i < win; i++) { const v = x[o + i]; s += v * v; sh += hp[o + i] * hp[o + i]; if (i && (v >= 0) !== (x[o + i - 1] >= 0)) zc++; }
    const db = 10 * Math.log10(s / win + EPS);
    const hf = sh / (s + EPS);
    const zcr = zc / win;
    const v = vad ? vad[Math.min(vad.length - 1, Math.floor((o + win / 2) / vadHop))] : 0;
    const quietEnough = db > floor + 4 && db < speech - 14;
    const airy = hf > 0.35 && zcr > 0.06;
    flags[f] = quietEnough && airy && v < 0.5 ? 1 : 0;
  }
  // group into segments 120 ms .. 1.5 s, allow 30 ms holes
  const segs = []; let f = 0;
  while (f < nf) {
    if (!flags[f]) { f++; continue; }
    let e = f, holes = 0;
    while (e < nf && (flags[e] || holes < 3)) { holes = flags[e] ? 0 : holes + 1; e++; }
    e -= holes;
    const dur = (e - f) * hop / sr;
    if (dur >= 0.12 && dur <= 1.5) segs.push([f * hop, Math.min(x.length, e * hop + win)]);
    f = e + 1;
  }
  const g = new Float32Array(x.length).fill(1);
  const ramp = Math.round(sr * 0.015), depth = dbToGain(-amountDb);
  for (const [a, b] of segs) {
    for (let i = a; i < b; i++) {
      const t = Math.min(1, (i - a) / ramp, (b - i) / ramp);
      g[i] = Math.min(g[i], 1 - (1 - depth) * Math.max(0, t));
    }
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g[i];
  return { y, count: segs.length, segments: segs.map(([a, b]) => [a / sr, b / sr]) };
}

/* ---------------------------------------------------------------- de-esser */
export function deess(x, { amount = 0.5, sr = SR } = {}) {
  if (amount <= 0) return Float32Array.from(x);
  const band = biquad(biquad(x, biquadCoefs('bandpass', 6500, 0.9, 0, sr)), biquadCoefs('peak', 6500, 1, 0, sr));
  const at = Math.exp(-1 / (0.001 * sr)), rt = Math.exp(-1 / (0.06 * sr));
  let eb = 0, ef = 0, gs = 1;
  const thr = 0.42 - 0.2 * amount; // band/full energy ratio above which we reduce
  const strength = 0.6 + 1.6 * amount; const floorG = dbToGain(-16 * amount);
  const gsm = Math.exp(-1 / (0.002 * sr));
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const pb = band[i] * band[i], pf = x[i] * x[i];
    eb = pb > eb ? at * eb + (1 - at) * pb : rt * eb + (1 - rt) * pb;
    ef = pf > ef ? at * ef + (1 - at) * pf : rt * ef + (1 - rt) * pf;
    const r = Math.sqrt(eb / (ef + EPS));
    let g = r > thr ? Math.pow(thr / r, strength) : 1;
    if (g < floorG) g = floorG;
    gs = g < gs ? g : gsm * gs + (1 - gsm) * g;
    y[i] = (x[i] - band[i]) + band[i] * gs;
  }
  return y;
}

/* ---------------------------------------------------------- voice presets */
export const VOICE_PRESETS = {
  natural: { label: 'Natural', eq: [{ type: 'highpass', f: 80 }, { type: 'peak', f: 250, q: 1, g: -1.5 }, { type: 'peak', f: 3000, q: 1, g: 1.5 }, { type: 'highshelf', f: 10000, g: 1 }], comp: { thresholdDb: -24, ratio: 2 } },
  clear: { label: 'Clear', eq: [{ type: 'highpass', f: 100 }, { type: 'peak', f: 300, q: 1, g: -3 }, { type: 'peak', f: 3500, q: 0.9, g: 3 }, { type: 'highshelf', f: 9000, g: 2.5 }], comp: { thresholdDb: -24, ratio: 2.5 } },
  warm: { label: 'Warm', eq: [{ type: 'highpass', f: 70 }, { type: 'lowshelf', f: 180, g: 2.5 }, { type: 'peak', f: 3000, q: 1, g: 0.5 }, { type: 'highshelf', f: 9000, g: -1.5 }], comp: { thresholdDb: -24, ratio: 2 } },
  deep: { label: 'Deep', eq: [{ type: 'highpass', f: 60 }, { type: 'lowshelf', f: 120, g: 4 }, { type: 'peak', f: 400, q: 1, g: -2 }, { type: 'peak', f: 2500, q: 1, g: 1 }], comp: { thresholdDb: -26, ratio: 2.5 } },
  radio: { label: 'Radio', eq: [{ type: 'highpass', f: 180, q: 0.9 }, { type: 'peak', f: 1800, q: 0.8, g: 4 }, { type: 'highshelf', f: 6000, g: -4 }, { type: 'lowpass', f: 9000 }], comp: { thresholdDb: -28, ratio: 4 } },
  podcast: { label: 'Podcast Pro', eq: [{ type: 'highpass', f: 90 }, { type: 'lowshelf', f: 150, g: 1.5 }, { type: 'peak', f: 350, q: 1.1, g: -2.5 }, { type: 'peak', f: 4000, q: 0.9, g: 2.5 }, { type: 'highshelf', f: 11000, g: 2 }], comp: { thresholdDb: -26, ratio: 3 } },
};

export const LOUDNESS_PRESETS = {
  youtube: { label: 'YouTube', target: -14, tp: -1 },
  podcast: { label: 'Podcast', target: -16, tp: -1 },
  reels: { label: 'Reels', target: -14, tp: -1, brighten: true },
  audiobook: { label: 'Audiobook', target: -18, tp: -3 },
  custom: { label: 'Custom', target: -16, tp: -1 },
};

export function applyVoicePreset(x, name = 'natural', sr = SR) {
  const p = VOICE_PRESETS[name] || VOICE_PRESETS.natural;
  const eq = applyFilters(x, p.eq, sr);
  const { speech } = analyzeLevels(eq, sr);
  // threshold relative to the speech level so presets behave the same at any input gain
  return compress(eq, { thresholdDb: speech - 6 + (p.comp.thresholdDb + 24) / 2, ratio: p.comp.ratio, attackMs: 8, releaseMs: 140, sr });
}

export function brighten(x, sr = SR) { return applyFilters(x, [{ type: 'highshelf', f: 6000, g: 2 }, { type: 'peak', f: 2800, q: 1, g: 1 }], sr); }

/* ---------------------------------------------------------------- cutting */
// keeps: [[startSec, endSec], ...] sorted, non-overlapping. Joins use equal-power crossfades.
// Returns {y, map}; map converts source time -> output time.
export function applyKeeps(x, keeps, { xfadeMs = 12, sr = SR } = {}) {
  const segs = keeps
    .map(([a, b]) => [Math.max(0, Math.round(a * sr)), Math.min(x.length, Math.round(b * sr))])
    .filter(([a, b]) => b - a > 1);
  const X = Math.round((xfadeMs / 1000) * sr);
  let total = 0;
  segs.forEach(([a, b], i) => { total += b - a; if (i > 0) total -= Math.min(X, b - a, segs[i - 1][1] - segs[i - 1][0]); });
  const y = new Float32Array(Math.max(0, total));
  const map = [];
  let w = 0;
  segs.forEach(([a, b], i) => {
    const len = b - a;
    const xf = i === 0 ? 0 : Math.min(X, len, segs[i - 1][1] - segs[i - 1][0]);
    const start = w - xf;
    for (let k = 0; k < len; k++) {
      const v = x[a + k];
      if (k < xf) {
        const t = (k + 0.5) / xf;
        const gin = Math.sin((t * Math.PI) / 2), gout = Math.cos((t * Math.PI) / 2);
        y[start + k] = y[start + k] * gout + v * gin;
      } else y[start + k] = v;
    }
    map.push({ in0: a / sr, in1: b / sr, out0: start / sr });
    w = start + len;
  });
  return { y: w === y.length ? y : y.subarray(0, w), map };
}

// Map a source time through one cut-map. Times inside removed regions snap to the next kept start.
export function mapTime(map, t) {
  if (!map) return t;
  for (const s of map) {
    if (t < s.in0) return s.out0;
    if (t <= s.in1) return s.out0 + (t - s.in0);
  }
  const l = map[map.length - 1]; return l ? l.out0 + (l.in1 - l.in0) : 0;
}
export function isRemoved(map, t0, t1) {
  if (!map) return false;
  let kept = 0;
  for (const s of map) kept += Math.max(0, Math.min(t1, s.in1) - Math.max(t0, s.in0));
  return kept < (t1 - t0) * 0.5;
}
export function invMapTime(map, t) {
  if (!map) return t;
  for (const s of map) { const len = s.in1 - s.in0; if (t <= s.out0 + len) return s.in0 + Math.max(0, t - s.out0); }
  const l = map[map.length - 1]; return l ? l.in1 : 0;
}
// A chain of transforms: {type:'cut', map} or {type:'speed', tempo}
export function chainFwd(chain, t) { for (const c of chain) t = c.type === 'cut' ? mapTime(c.map, t) : t / c.tempo; return t; }
export function chainInv(chain, t) { for (let i = chain.length - 1; i >= 0; i--) { const c = chain[i]; t = c.type === 'cut' ? invMapTime(c.map, t) : t * c.tempo; } return t; }

/* ---------------------------------------------------------- silence trimming */
export function silenceKeeps(x, { maxPause = 0.4, minSilence = null, edgePad = 0.15, sr = SR } = {}) {
  const { db, hop, floor, speech } = analyzeLevels(x, sr);
  const dur = x.length / sr;
  if (speech - floor < 6) return { keeps: [[0, dur]], removed: 0, gaps: 0 };
  const thr = Math.max(floor + 6, floor + (speech - floor) * 0.28);
  const n = db.length; const sil = new Uint8Array(n);
  for (let i = 0; i < n; i++) sil[i] = db[i] < thr ? 1 : 0;
  // hangover: protect 60 ms after and 30 ms before speech (word tails, plosive onsets)
  const prot = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!sil[i]) { for (let k = -3; k <= 6; k++) if (i + k >= 0 && i + k < n) prot[i + k] = 1; }
  const minGap = minSilence ?? Math.max(maxPause, 0.12);
  const keeps = []; let cur = 0; let removed = 0, gaps = 0;
  let i = 0;
  while (i < n) {
    if (prot[i]) { i++; continue; }
    let e = i; while (e < n && !prot[e]) e++;
    const t0 = (i * hop) / sr, t1 = Math.min(dur, (e * hop) / sr);
    const len = t1 - t0;
    const lead = i === 0, tail = e >= n;
    if (lead && len > edgePad) { cur = t1 - edgePad; removed += len - edgePad; gaps++; }
    else if (tail && len > edgePad) { keeps.push([cur, t0 + edgePad]); cur = dur; removed += len - edgePad; gaps++; }
    else if (!lead && !tail && len > minGap && len > maxPause) {
      const half = Math.max(0.04, (maxPause - 0.09) / 2); // 0.09 s of hangover is already protected
      keeps.push([cur, t0 + half]); cur = t1 - half; removed += len - maxPause; gaps++;
    }
    i = e;
  }
  if (cur < dur) keeps.push([cur, dur]);
  return { keeps: keeps.filter(([a, b]) => b - a > 0.005), removed, gaps, threshold: thr, floor, speech };
}

// Convert removal spans (seconds) into keep segments.
export function spansToKeeps(spans, dur) {
  const s = spans.map(([a, b]) => [Math.max(0, a), Math.min(dur, b)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const sp of s) { const l = merged[merged.length - 1]; if (l && sp[0] <= l[1]) l[1] = Math.max(l[1], sp[1]); else merged.push([...sp]); }
  const keeps = []; let cur = 0;
  for (const [a, b] of merged) { if (a > cur) keeps.push([cur, a]); cur = b; }
  if (cur < dur) keeps.push([cur, dur]);
  return keeps;
}

/* ---------------------------------------------------------------- fades */
export function applyFades(x, inSec = 0.05, outSec = 0.3, sr = SR) {
  const y = Float32Array.from(x);
  const a = Math.min(y.length, Math.round(inSec * sr)), b = Math.min(y.length, Math.round(outSec * sr));
  for (let i = 0; i < a; i++) { const t = i / a; y[i] *= t * t * (3 - 2 * t); }
  for (let i = 0; i < b; i++) { const t = i / b; y[y.length - 1 - i] *= t * t * (3 - 2 * t); }
  return y;
}

/* ---------------------------------------------------------------- music bed */
export function mixMusic(voice, music, { volume = 0.25, duckDb = 12, duck = true, sr = SR } = {}) {
  const n = voice.length; const y = new Float32Array(n);
  if (!music || !music.length) return Float32Array.from(voice);
  // voice activity envelope (20 ms RMS)
  const { floor, speech } = analyzeLevels(voice, sr);
  const thr = Math.max(floor + 8, speech - 22);
  const hop = Math.round(sr * 0.02); const nf = Math.ceil(n / hop);
  const act = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; const o = f * hop; const e = Math.min(n, o + hop); for (let i = o; i < e; i++) s += voice[i] * voice[i]; act[f] = 10 * Math.log10(s / Math.max(1, e - o) + EPS) > thr ? 1 : 0; }
  // hold 300 ms so the bed does not pump between words
  const hold = Math.round(0.3 * sr / hop); let last = -1e9;
  for (let f = 0; f < nf; f++) { if (act[f]) last = f; else if (f - last <= hold) act[f] = 1; }
  const att = Math.exp(-1 / (0.08 * sr)), rel = Math.exp(-1 / (0.45 * sr));
  const dg = dbToGain(-duckDb); let g = 1;
  const fadeOut = Math.min(n, Math.round(2 * sr)), fadeIn = Math.min(n, Math.round(0.6 * sr));
  for (let i = 0; i < n; i++) {
    const target = duck && act[Math.floor(i / hop)] ? dg : 1;
    g = target < g ? att * g + (1 - att) * target : rel * g + (1 - rel) * target;
    let m = music[i % music.length] * volume * g;
    if (i < fadeIn) m *= i / fadeIn;
    if (i > n - fadeOut) m *= (n - i) / fadeOut;
    y[i] = voice[i] + m;
  }
  return y;
}

/* ---------------------------------------------------------------- resampling */
export function resampleLinear(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const n = Math.floor((x.length * to) / from); const y = new Float32Array(n); const r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r; const a = Math.floor(p); const t = p - a; y[i] = (x[a] || 0) * (1 - t) + (x[a + 1] || 0) * t; }
  return y;
}
// 48k -> 16k for speech recognition: low-pass at 7 kHz then take every 3rd sample.
export function to16k(x) {
  const lp = biquad(biquad(x, biquadCoefs('lowpass', 7000, 0.54)), biquadCoefs('lowpass', 7000, 1.31));
  const y = new Float32Array(Math.floor(lp.length / 3));
  for (let i = 0; i < y.length; i++) y[i] = lp[i * 3];
  return y;
}

/* ---------------------------------------------------------------- WAV */
export function encodeWAV(x, sr = SR, bits = 16) {
  const bps = bits / 8; const dataLen = x.length * bps;
  const buf = new ArrayBuffer(44 + dataLen); const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * bps, true); v.setUint16(32, bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    if (bits === 16) { v.setInt16(o, Math.round(s < 0 ? s * 32768 : s * 32767), true); o += 2; }
    else { const q = Math.round(s < 0 ? s * 8388608 : s * 8388607); v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3; }
  }
  return buf;
}

export function decodeWAV(buf) {
  const v = new DataView(buf);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const len = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') data = { off: o + 8, len };
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('bad wav');
  const bps = fmt.bits / 8, frames = Math.floor(data.len / (bps * fmt.ch));
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const p = data.off + (i * fmt.ch + c) * bps;
      if (fmt.format === 3) s += v.getFloat32(p, true);
      else if (fmt.bits === 16) s += v.getInt16(p, true) / 32768;
      else if (fmt.bits === 24) { let q = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (q & 0x800000) q -= 0x1000000; s += q / 8388608; }
      else if (fmt.bits === 32) s += v.getInt32(p, true) / 2147483648;
    }
    x[i] = s / fmt.ch;
  }
  return { x, sr: fmt.sr, bits: fmt.bits, channels: fmt.ch };
}

/* ------------------------------------------------- acoustic hesitation finder */
// Finds isolated, short, steady voiced blobs ("uhh", "mmm") that the recogniser
// did not transcribe. words: [{start,end}] on the same timeline.
export function findHesitations(x, words, { sr = SR, vad = null, vadHop = 480 } = {}) {
  const hop = Math.round(sr * 0.01), win = Math.round(sr * 0.025);
  const nf = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const { floor, speech } = analyzeLevels(x, sr);
  const thr = Math.max(floor + 10, speech - 18);
  const db = new Float32Array(nf), zcr = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let s = 0, z = 0; const o = f * hop;
    for (let i = 0; i < win; i++) { const v = x[o + i]; s += v * v; if (i && (v >= 0) !== (x[o + i - 1] >= 0)) z++; }
    db[f] = 10 * Math.log10(s / win + EPS); zcr[f] = z / win;
  }
  const out = []; let f = 0;
  const covered = (a, b) => words.some((w) => Math.min(b, w.end) - Math.max(a, w.start) > (b - a) * 0.3);
  while (f < nf) {
    if (db[f] < thr) { f++; continue; }
    let e = f; while (e < nf && db[e] >= thr - 3) e++;
    const a = (f * hop) / sr, b = (e * hop + win) / sr, dur = b - a;
    // silence around it
    const quietBefore = f > 15 && Array.from(db.subarray(f - 15, f)).every((v) => v < thr);
    const quietAfter = e + 15 < nf && Array.from(db.subarray(e, e + 15)).every((v) => v < thr);
    if (dur > 0.18 && dur < 0.9 && quietBefore && quietAfter && !covered(a, b)) {
      const z = Array.from(zcr.subarray(f, e)); const m = z.reduce((p, q) => p + q, 0) / z.length;
      const sd = Math.sqrt(z.reduce((p, q) => p + (q - m) ** 2, 0) / z.length);
      const v = vad ? vad[Math.min(vad.length - 1, Math.floor(((a + b) / 2 * sr) / vadHop))] : 1;
      if (m < 0.12 && sd < 0.035 && v > 0.3) out.push({ start: a, end: b, word: '(hesitation)', kind: 'sound' });
    }
    f = e + 1;
  }
  return out;
}

/* ---------------------------------------------------------------- fillers */
export const FILLERS_EN = ['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'hmm', 'hm', 'mm', 'mhm', 'erm', 'er', 'ah', 'ahh', 'eh'];
export const FILLERS_HI = ['matlab', 'toh', 'haan', 'acha', 'achha', 'मतलब', 'तो', 'हाँ', 'हां', 'अच्छा', 'उम', 'अं', 'हम्म'];
// Hindi words that are also real words in context; only cut when they stand alone.
const HI_CONTEXT = new Set(['toh', 'तो', 'haan', 'हाँ', 'हां', 'acha', 'achha', 'अच्छा']);

export function normWord(w) { return (w || '').toLowerCase().replace(/[.,!?;:"'“”‘’…\-–—()[\]]/g, '').trim(); }

export function detectFillers(words, { hindi = true, custom = [] } = {}) {
  const set = new Set([...FILLERS_EN, ...(hindi ? FILLERS_HI : []), ...custom.map(normWord)]);
  const out = [];
  words.forEach((w, i) => {
    const n = normWord(w.text);
    if (!n || !set.has(n)) return;
    if (HI_CONTEXT.has(n)) {
      // only flag if it is followed or preceded by a pause (>= 250 ms) — i.e. used as a filler
      const prev = words[i - 1], next = words[i + 1];
      const gapB = prev ? w.start - prev.end : 1, gapA = next ? next.start - w.end : 1;
      if (Math.max(gapA, gapB) < 0.25) return;
    }
    out.push({ start: w.start, end: w.end, word: w.text.trim(), kind: 'word' });
  });
  return out;
}

/* ---------------------------------------------------------------- subtitles */
const fmtSrt = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
// words already mapped to output time: [{text,start,end}]
export function buildSRT(words, { maxChars = 42, maxDur = 5, gapBreak = 0.7 } = {}) {
  const cues = []; let cur = null;
  for (const w of words) {
    const text = (w.text || '').trim(); if (!text) continue;
    const endsSentence = /[.?!।]$/.test(text);
    if (cur && ((cur.text.length + text.length + 1 > maxChars && !(endsSentence && cur.text.length + text.length + 1 <= maxChars + 12)) || w.end - cur.start > maxDur || w.start - cur.end > gapBreak || /[.?!।]$/.test(cur.text))) { cues.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, text };
    else { cur.text += ' ' + text; cur.end = w.end; }
  }
  if (cur) cues.push(cur);
  return cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(Math.max(c.end, c.start + 0.3))}\n${c.text}\n`).join('\n');
}
