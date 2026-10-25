// Records the (optionally denoised) mic signal and reports a level for the meter.
class SonvelCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096); this.n = 0; this.peak = 0; this.sum = 0; this.cnt = 0; this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'pause') this.on = false; if (e.data === 'resume') this.on = true; if (e.data === 'flush' && this.n) { const c = this.buf.slice(0, this.n); this.n = 0; this.port.postMessage({ chunk: c }, [c.buffer]); } };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i]; const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a; this.sum += v * v; this.cnt++;
        if (this.on) { this.buf[this.n++] = v; if (this.n === this.buf.length) { this.port.postMessage({ chunk: this.buf }, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; } }
      }
      if (this.cnt >= 2048) { this.port.postMessage({ rms: Math.sqrt(this.sum / this.cnt), peak: this.peak }); this.sum = 0; this.cnt = 0; this.peak = 0; }
    }
    return true;
  }
}
registerProcessor('sonvel-capture', SonvelCapture);
