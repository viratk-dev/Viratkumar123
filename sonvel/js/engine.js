// Browser glue: decoding, worker RPC, MP3, video remux and live recording.
import * as D from './dsp.js';

/* ------------------------------------------------------------------ RPC */
export class RPC {
  constructor(url, opts) { this.url = url; this.opts = opts; this.w = null; this.seq = 0; this.pending = new Map(); }
  get worker() {
    if (!this.w) {
      this.w = new Worker(this.url, this.opts);
      this.w.onmessage = ({ data }) => {
        const p = this.pending.get(data.req); if (!p) return;
        if (data.type === 'progress') p.onProgress?.(data);
        else if (data.type === 'warn') p.onWarn?.(data.message);
        else { this.pending.delete(data.req); data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data); }
      };
      this.w.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker failed to start')); this.pending.clear(); this.w = null; };
    }
    return this.w;
  }
  call(cmd, payload = {}, transfer = [], { onProgress, onWarn } = {}) {
    const req = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject, onProgress, onWarn });
      this.worker.postMessage({ req, cmd, ...payload }, transfer);
    });
  }
  terminate() { this.w?.terminate(); this.w = null; for (const p of this.pending.values()) p.reject(new Error('cancelled')); this.pending.clear(); }
}

export const dspRPC = new RPC(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
export const asrRPC = new RPC(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
export const mp3RPC = new RPC(new URL('./mp3-worker.js', import.meta.url));

/* --------------------------------------------------------------- decode */
// Decode any audio/video file the browser can read to mono 48 kHz.
export async function decodeToMono48k(fileOrBuf, { onFallback } = {}) {
  const ab = fileOrBuf instanceof ArrayBuffer ? fileOrBuf : await fileOrBuf.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, D.SR);
  let buf;
  try { buf = await ctx.decodeAudioData(ab.slice(0)); }
  catch {
    // Browser can't decode this container/codec (e.g. some MOV/MKV/AC-3). Fall back to ffmpeg.wasm.
    if (!(fileOrBuf instanceof Blob)) throw new Error('This file has no audio we can read.');
    onFallback?.();
    try { buf = await ctx.decodeAudioData(await extractAudioWithFFmpeg(fileOrBuf)); }
    catch (e) { throw new Error('This file has no audio we can read. Try WAV, MP3, M4A, OGG, WEBM or MP4.'); }
  }
  const n = buf.length, ch = buf.numberOfChannels; const x = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / ch; }
  return { x, duration: n / D.SR, channels: ch };
}

/* ------------------------------------------------------------------ MP3 */
export async function encodeMP3(x, kbps = 192, onProgress) {
  const copy = x.slice();
  const r = await mp3RPC.call('encode', { x: copy, sampleRate: D.SR, kbps }, [copy.buffer], { onProgress: (d) => onProgress?.(d.p) });
  return r.blob;
}

/* ---------------------------------------------------------- video remux */
const FF_VER = '0.12.15', CORE_VER = '0.12.9';
const FF_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FF_VER}/dist/esm`;
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VER}/dist/esm`;
let ffP = null;
async function getFFmpeg(onProgress) {
  if (!ffP) {
    ffP = (async () => {
      const { FFmpeg } = await import(`${FF_BASE}/index.js`);
      const ff = new FFmpeg();
      // The class worker must be same-origin; a tiny blob module re-exports the CDN worker.
      const classWorkerURL = URL.createObjectURL(new Blob([`import "${FF_BASE}/worker.js";`], { type: 'text/javascript' }));
      await ff.load({ classWorkerURL, coreURL: `${CORE_BASE}/ffmpeg-core.js`, wasmURL: `${CORE_BASE}/ffmpeg-core.wasm` });
      return ff;
    })().catch((e) => { ffP = null; throw e; });
  }
  onProgress?.(0.05);
  return ffP;
}

// Replace the audio track of a video with cleaned audio. Uses single-thread ffmpeg-core (no SharedArrayBuffer).
export async function remuxVideo(videoFile, wavBuffer, onProgress) {
  const ff = await getFFmpeg(onProgress);
  const isWebm = /webm$/i.test(videoFile.type) || /\.webm$/i.test(videoFile.name);
  const inName = isWebm ? 'in.webm' : 'in.mp4', outName = isWebm ? 'out.webm' : 'out.mp4';
  const cb = ({ progress }) => onProgress?.(0.1 + 0.9 * Math.max(0, Math.min(1, progress)));
  ff.on('progress', cb);
  try {
    await ff.writeFile(inName, new Uint8Array(await videoFile.arrayBuffer()));
    await ff.writeFile('clean.wav', new Uint8Array(wavBuffer));
    const ac = isWebm ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k'];
    const code = await ff.exec(['-i', inName, '-i', 'clean.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...ac, '-shortest', outName]);
    if (code !== 0) throw new Error('Video export failed (ffmpeg exit ' + code + ')');
    const data = await ff.readFile(outName);
    await ff.deleteFile(inName); await ff.deleteFile('clean.wav'); await ff.deleteFile(outName);
    return new Blob([data.buffer], { type: isWebm ? 'video/webm' : 'video/mp4' });
  } finally { ff.off('progress', cb); }
}

export async function extractAudioWithFFmpeg(file) {
  const ff = await getFFmpeg();
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const inName = 'src.' + ext;
  await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const code = await ff.exec(['-i', inName, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', 'a.wav']);
  if (code !== 0) throw new Error('ffmpeg could not read this file');
  const data = await ff.readFile('a.wav');
  await ff.deleteFile(inName); await ff.deleteFile('a.wav');
  return data.buffer;
}

/* ------------------------------------------------------- live recording */
const NS_BASE = 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.4.1/dist';

export class LiveRecorder {
  constructor({ onLevel, onWarn } = {}) { this.onLevel = onLevel; this.onWarn = onWarn; this.chunks = []; this.state = 'idle'; this.liveNC = true; }
  async start({ liveNC = true } = {}) {
    this.liveNC = liveNC; this.chunks = []; this.samples = 0;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: !liveNC ? true : false, autoGainControl: false } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: D.SR, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    let node = this.src;
    if (liveNC) {
      try {
        const ns = await import(`${NS_BASE}/index.js`);
        const wasmBinary = await ns.loadRnnoise({ url: `${NS_BASE}/rnnoise.wasm`, simdUrl: `${NS_BASE}/rnnoise_simd.wasm` });
        await this.ctx.audioWorklet.addModule(`${NS_BASE}/rnnoise/workletProcessor.js`);
        this.rn = new ns.RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary });
        node.connect(this.rn); node = this.rn;
      } catch (e) { this.liveNC = false; this.onWarn?.('Live noise cancel is not available right now. Recording the raw mic.'); }
    }
    this.cap = new AudioWorkletNode(this.ctx, 'sonvel-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.cap.port.onmessage = ({ data }) => {
      if (data.chunk) { this.chunks.push(data.chunk); this.samples += data.chunk.length; }
      else if (data.rms !== undefined) this.onLevel?.(data.rms, data.peak);
    };
    node.connect(this.cap);
    const mute = this.ctx.createGain(); mute.gain.value = 0; this.cap.connect(mute).connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.state = 'recording'; this.t0 = performance.now(); this.elapsed = 0;
  }
  get seconds() { return this.samples / D.SR; }
  pause() { if (this.state !== 'recording') return; this.cap.port.postMessage('pause'); this.state = 'paused'; }
  resume() { if (this.state !== 'paused') return; this.cap.port.postMessage('resume'); this.state = 'recording'; }
  async stop() {
    this.cap?.port.postMessage('flush');
    await new Promise((r) => setTimeout(r, 150));
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.rn?.destroy?.(); } catch {}
    await this.ctx?.close();
    this.state = 'idle';
    const x = new Float32Array(this.samples); let o = 0;
    for (const c of this.chunks) { x.set(c, o); o += c.length; }
    this.chunks = [];
    return x;
  }
}

/* -------------------------------------------------------------- helpers */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  return false;
}
