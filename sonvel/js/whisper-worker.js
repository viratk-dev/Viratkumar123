// Speech recognition with word timestamps (Whisper via transformers.js). Module worker.
const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js';
let tf = null, asr = null, loadedModel = null;

const post = (m) => self.postMessage(m);

async function load(req, model) {
  if (asr && loadedModel === model) return;
  tf ||= await import(TF_URL);
  tf.env.allowLocalModels = false;
  // Cache API keeps the model offline after the first download (needs a secure context, e.g. GitHub Pages HTTPS).
  tf.env.useBrowserCache = typeof caches !== 'undefined';
  const files = new Map();
  asr = await tf.pipeline('automatic-speech-recognition', model, {
    // fp32 encoder is required: a q8 encoder makes Whisper hallucinate. The q8 decoder is fine and halves the download.
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    device: 'wasm',
    progress_callback: (e) => {
      if (e.status === 'progress' || e.status === 'done') {
        const f = files.get(e.file) || { loaded: 0, total: 0 };
        if (e.total) f.total = e.total;
        f.loaded = e.status === 'done' ? f.total || f.loaded : e.loaded || 0;
        files.set(e.file, f);
        let l = 0, t = 0; for (const v of files.values()) { l += v.loaded; t += v.total; }
        post({ req, type: 'progress', step: 'download', p: t ? l / t : 0, loaded: l, total: t });
      }
    },
  });
  loadedModel = model;
}

self.onmessage = async ({ data }) => {
  const { req, cmd } = data;
  try {
    if (cmd === 'load') { await load(req, data.model); return post({ req, type: 'done' }); }
    if (cmd === 'run') {
      await load(req, data.model);
      post({ req, type: 'progress', step: 'transcribe', p: 0 });
      const dur = data.audio.length / 16000;
      let t0 = performance.now();
      // rough progress: whisper processes ~30 s chunks; tick a timer estimate
      const est = Math.max(4, dur * (data.model.includes('base') ? 0.9 : 0.45));
      const tick = setInterval(() => post({ req, type: 'progress', step: 'transcribe', p: Math.min(0.95, (performance.now() - t0) / 1000 / est) }), 400);
      let out;
      try {
        out = await asr(data.audio, {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5,
          language: data.language || null,
          task: 'transcribe',
        });
      } finally { clearInterval(tick); }
      const words = (out.chunks || []).map((c) => ({ text: c.text, start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 0.2 }));
      return post({ req, type: 'done', text: out.text, words });
    }
    throw new Error('Unknown command ' + cmd);
  } catch (e) {
    post({ req, type: 'error', message: e?.message || String(e) });
  }
};
