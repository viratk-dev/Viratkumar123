// Heavy DSP off the main thread. Module worker.
import * as D from './dsp.js';
import { stageA, stageB } from './pipeline.js';

export const RN_URL = 'https://cdn.jsdelivr.net/npm/@shiguredo/rnnoise-wasm@2025.1.5/dist/rnnoise.js';
export const ST_URL = 'https://cdn.jsdelivr.net/npm/soundtouchjs@0.3.0/dist/soundtouch.js';

let rnP = null, stP = null;
const rnnoise = () => (rnP ||= import(RN_URL).then((m) => m.Rnnoise.load()));
const soundtouch = () => (stP ||= import(ST_URL));
const jobs = new Map(); // id -> { x, A, vad }

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

self.onmessage = async ({ data }) => {
  const { req, cmd } = data;
  const progress = (step, p) => post({ req, type: 'progress', step, p });
  try {
    if (cmd === 'load') { jobs.set(data.id, { x: data.x }); return post({ req, type: 'done' }); }
    const job = jobs.get(data.id);
    if (cmd === 'free') { jobs.delete(data.id); return post({ req, type: 'done' }); }
    if (!job) throw new Error('No audio loaded');
    if (cmd === 'stageA') {
      let rn = null;
      if (data.settings.noise.on) {
        progress('model', 0);
        try { rn = await rnnoise(); } catch (e) { post({ req, type: 'warn', message: 'Noise model could not load (offline?). Skipping noise removal.' }); }
      }
      const r = await stageA(job.x, data.settings, { rnnoise: rn, progress });
      job.A = r.y; job.vad = r.vad;
      return post({ req, type: 'done', stats: r.stats });
    }
    if (cmd === 'stageB') {
      const A = job.A || job.x;
      let st = null;
      const sp = data.settings.speed;
      if (Math.abs((sp.tempo || 1) - 1) > 1e-3 || Math.abs(sp.semitones || 0) > 1e-3) {
        try { st = await soundtouch(); } catch { post({ req, type: 'warn', message: 'Speed/pitch library could not load. Skipping.' }); }
      }
      const r = await stageB(A, data.settings, { fillerSpans: data.fillerSpans || [], music: data.music || null, soundtouch: st, progress, allowCuts: data.allowCuts !== false });
      const y = r.y.slice();
      return post({ req, type: 'done', y, chain: r.chain, stats: r.stats }, [y.buffer]);
    }
    if (cmd === 'get16k') {
      const y = D.to16k(job.A || job.x);
      return post({ req, type: 'done', y }, [y.buffer]);
    }
    if (cmd === 'hesitations') {
      const list = D.findHesitations(job.A || job.x, data.words || [], { vad: job.vad, vadHop: 480 });
      return post({ req, type: 'done', list });
    }
    throw new Error('Unknown command ' + cmd);
  } catch (e) {
    post({ req, type: 'error', message: e?.message || String(e) });
  }
};
