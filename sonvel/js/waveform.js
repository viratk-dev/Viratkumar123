// Canvas waveform with seek, trim handles and range selection. Responsive and DPR-aware.
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Waveform {
  constructor(canvas, { onSeek, onTrim, onSelect } = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek; this.onTrim = onTrim; this.onSelect = onSelect;
    this.data = null; this.dur = 0; this.pos = 0; this.mode = 'seek';
    this.trim = null; this.sel = null; this.tone = 'accent'; this.peaks = null;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', (e) => {
      if (!this.dur) return;
      const step = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowRight') { this.onSeek?.(Math.min(this.dur, this.pos + step)); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.onSeek?.(Math.max(0, this.pos - step)); e.preventDefault(); }
    });
    this.mq = matchMedia('(prefers-color-scheme: dark)');
  }
  set(data, sr = 48000) { this.data = data; this.dur = data ? data.length / sr : 0; this.peaks = null; this.pos = 0; this.draw(); }
  setPos(t) { this.pos = t; this.draw(); }
  setMode(m) { this.mode = m; if (m === 'trim' && !this.trim) this.trim = [0, this.dur]; this.draw(); }
  resize() {
    const r = this.c.getBoundingClientRect(); const d = Math.min(3, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; this.peaks = null; }
    this.draw();
  }
  computePeaks(bars) {
    const x = this.data; const out = new Float32Array(bars); if (!x) return out;
    const per = x.length / bars; let max = 1e-6;
    for (let b = 0; b < bars; b++) {
      const a = Math.floor(b * per), e = Math.min(x.length, Math.floor((b + 1) * per));
      let s = 0, n = 0, pk = 0; for (let i = a; i < e; i += 2) { const v = x[i] < 0 ? -x[i] : x[i]; s += v * v; n++; if (v > pk) pk = v; }
      out[b] = 0.5 * Math.sqrt(s / Math.max(1, n)) * 1.41 + 0.5 * pk; if (out[b] > max) max = out[b];
    }
    // gentle perceptual scaling so quiet speech is still visible but dynamics read
    for (let b = 0; b < bars; b++) out[b] = Math.pow(out[b] / max, 0.8);
    return out;
  }
  tx(t) { return (t / (this.dur || 1)) * this.c.width; }
  tt(px) { return Math.max(0, Math.min(this.dur, (px / this.c.width) * this.dur)); }
  draw() {
    const { c, ctx } = this; const W = c.width, H = c.height; if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const d = Math.min(3, devicePixelRatio || 1);
    const bw = 2 * d, gap = 1.5 * d, step = bw + gap; const bars = Math.max(8, Math.floor(W / step));
    if (!this.peaks || this.peaks.length !== bars) this.peaks = this.computePeaks(bars);
    const accent = css('--accent'), idle = css('--wave-idle'), ink = css('--ink'), surface = css('--surface');
    const played = this.tx(this.pos);
    const mid = H / 2, maxH = H * 0.86;
    for (let b = 0; b < bars; b++) {
      const x = b * step; const h = Math.max(2 * d, this.peaks[b] * maxH);
      const isPlayed = x + bw <= played;
      if (this.tone === 'progress') { ctx.fillStyle = isPlayed ? accent : idle; ctx.globalAlpha = 1; }
      else if (this.tone === 'accent') { ctx.fillStyle = accent; ctx.globalAlpha = isPlayed ? 1 : 0.38; }
      else { ctx.fillStyle = isPlayed ? ink : idle; ctx.globalAlpha = 1; }
      roundRect(ctx, x, mid - h / 2, bw, h, bw / 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // trimmed-away areas
    if (this.trim && (this.mode === 'trim' || this.trim[0] > 0 || this.trim[1] < this.dur)) {
      ctx.fillStyle = surface; ctx.globalAlpha = 0.72;
      ctx.fillRect(0, 0, this.tx(this.trim[0]), H); ctx.fillRect(this.tx(this.trim[1]), 0, W - this.tx(this.trim[1]), H);
      ctx.globalAlpha = 1;
      if (this.mode === 'trim') for (const t of this.trim) this.handle(this.tx(t), H, ink, d);
    }
    if (this.sel && this.sel[1] - this.sel[0] > 0.01) {
      const a = this.tx(this.sel[0]), b = this.tx(this.sel[1]);
      ctx.fillStyle = accent; ctx.globalAlpha = 0.14; ctx.fillRect(a, 0, b - a, H); ctx.globalAlpha = 1;
      ctx.fillStyle = accent; ctx.fillRect(a - d / 2, 0, d, H); ctx.fillRect(b - d / 2, 0, d, H);
    }
    // playhead
    if (this.dur && this.tone !== 'progress') { ctx.fillStyle = ink; ctx.fillRect(Math.min(W - d, played), 0, 1.5 * d, H); }
  }
  handle(x, H, ink, d) {
    const ctx = this.ctx; const w = 6 * d;
    ctx.fillStyle = ink; roundRect(ctx, x - w / 2, 0, w, H, w / 2); ctx.fill();
    ctx.fillStyle = css('--surface'); roundRect(ctx, x - d / 2, H / 2 - 10 * d, d, 20 * d, d / 2); ctx.fill();
  }
  px(e) { const r = this.c.getBoundingClientRect(); return (e.clientX - r.left) * (this.c.width / r.width); }
  down(e) {
    if (!this.dur) return;
    this.c.setPointerCapture(e.pointerId); const x = this.px(e); const t = this.tt(x);
    const d = Math.min(3, devicePixelRatio || 1);
    if (this.mode === 'trim') {
      const da = Math.abs(x - this.tx(this.trim[0])), db = Math.abs(x - this.tx(this.trim[1]));
      this.drag = da < db ? 0 : 1; if (Math.min(da, db) > 40 * d) this.drag = da < db ? 0 : 1;
      this.moveTrim(t);
    } else if (this.mode === 'cut') { this.drag = 'sel'; this.selStart = t; this.sel = [t, t]; this.draw(); }
    else { this.drag = 'seek'; this.onSeek?.(t); }
  }
  move(e) {
    if (this.drag === undefined || this.drag === null) return;
    const t = this.tt(this.px(e));
    if (this.drag === 'seek') this.onSeek?.(t);
    else if (this.drag === 'sel') { this.sel = [Math.min(this.selStart, t), Math.max(this.selStart, t)]; this.draw(); }
    else this.moveTrim(t);
  }
  moveTrim(t) {
    const min = 0.2;
    if (this.drag === 0) this.trim[0] = Math.min(t, this.trim[1] - min); else this.trim[1] = Math.max(t, this.trim[0] + min);
    this.draw(); this.onTrim?.(this.trim);
  }
  up() { if (this.drag === 'sel') this.onSelect?.(this.sel); this.drag = null; }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); }
}

// Live scrolling level meter for recording.
export class Meter {
  constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.levels = []; new ResizeObserver(() => this.resize()).observe(canvas); }
  resize() { const r = this.c.getBoundingClientRect(); const d = Math.min(3, devicePixelRatio || 1); this.c.width = Math.round(r.width * d); this.c.height = Math.round(r.height * d); this.draw(); }
  push(rms) { const db = 20 * Math.log10(rms + 1e-9); this.levels.push(Math.max(0, Math.min(1, (db + 60) / 54))); if (this.levels.length > 400) this.levels.shift(); this.draw(); }
  reset() { this.levels = []; this.draw(); }
  draw() {
    const { c, ctx } = this; const W = c.width, H = c.height; if (!W) return; ctx.clearRect(0, 0, W, H);
    const d = Math.min(3, devicePixelRatio || 1); const bw = 3 * d, step = bw + 2 * d; const n = Math.floor(W / step);
    const accent = css('--accent'), idle = css('--wave-idle');
    for (let i = 0; i < n; i++) {
      const v = this.levels[this.levels.length - n + i];
      const h = Math.max(3 * d, (v ?? 0) * H * 0.92);
      ctx.fillStyle = v === undefined ? idle : accent; ctx.globalAlpha = v === undefined ? 0.6 : 0.35 + 0.65 * (i / n);
      roundRect(ctx, i * step, H / 2 - h / 2, bw, h, bw / 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
