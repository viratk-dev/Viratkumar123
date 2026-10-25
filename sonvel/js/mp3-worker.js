// MP3 encoding with lamejs (classic worker so importScripts works with the UMD build).
importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
self.onmessage = ({ data }) => {
  const { req, x, sampleRate, kbps } = data;
  try {
    const enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const chunks = []; const BLOCK = 1152 * 20; const pcm = new Int16Array(BLOCK);
    for (let o = 0; o < x.length; o += BLOCK) {
      const n = Math.min(BLOCK, x.length - o);
      for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, x[o + i])); pcm[i] = s < 0 ? s * 32768 : s * 32767; }
      const b = enc.encodeBuffer(n === BLOCK ? pcm : pcm.subarray(0, n));
      if (b.length) chunks.push(new Uint8Array(b));
      if ((o / BLOCK) % 20 === 0) self.postMessage({ req, type: 'progress', step: 'mp3', p: o / x.length });
    }
    const end = enc.flush(); if (end.length) chunks.push(new Uint8Array(end));
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    self.postMessage({ req, type: 'done', blob });
  } catch (e) { self.postMessage({ req, type: 'error', message: e?.message || String(e) }); }
};
