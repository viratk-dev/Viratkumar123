# Sonvel — studio voice, on your phone

Free, unlimited, fully client-side voice cleanup (think Adobe Podcast Enhance), built as a static PWA for
GitHub Pages: `https://viratk-dev.github.io/voice-studio/`. No server, no API keys, no limits. Audio never
leaves the device.

## Deploy (GitHub Pages)
1. Push the contents of this folder to the `voice-studio` repo (root of the default branch).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open the URL in Android Chrome → menu → **Add to Home screen**.

No build step. All libraries load from jsdelivr with pinned versions and are cached by the service worker.
COOP/COEP headers are **not** needed: nothing uses SharedArrayBuffer (ffmpeg.wasm runs the single-thread core;
onnxruntime falls back to one thread).

## Features
| Area | What it does | How |
|---|---|---|
| Input | Audio (wav/mp3/m4a/ogg/webm) and video (mp4/webm). Unreadable containers fall back to ffmpeg.wasm | `decodeAudioData` @48 kHz → mono |
| Record | Mic recording with **live RNNoise** in an AudioWorklet, level meter, timer, pause | `@sapphi-red/web-noise-suppressor` worklet + own capture worklet |
| Noise | RNNoise over the whole file, strength = wet/dry, latency-compensated (960 samples) | `@shiguredo/rnnoise-wasm` in a Web Worker |
| De-click | 2nd-difference transient detector + cubic Hermite repair | `dsp.js · declick` |
| Breaths | Low-energy, airy (HF ratio + ZCR), non-voiced segments between words ducked | `dsp.js · reduceBreaths` |
| Fillers | Whisper word timestamps (um/uh/hmm/erm + toggleable Hindi: matlab/toh/haan/acha, Latin + Devanagari) **plus** an acoustic hesitation finder, reviewable list with untick + preview | transformers.js + `findHesitations` |
| Silence trim | Adaptive threshold from noise floor/speech level, long gaps → max pause (default 0.4 s), short pauses kept, equal-power crossfades | `silenceKeeps` + `applyKeeps` |
| De-esser | Split-band (6.5 kHz band) dynamic reduction, amount slider | `deess` |
| Voice presets | Natural, Clear, Warm, Deep, Radio, Podcast Pro (EQ + compression) | RBJ biquads |
| Leveling | Gentle zero-phase AGC that never boosts pauses + compressor | `levelVoice` |
| Loudness | BS.1770-4 integrated LUFS (K-weighting, gating), iterative normalise + 4× oversampled true-peak lookahead limiter. YouTube −14, Podcast −16, Reels −14 (brighter), Audiobook −18/−3 dBTP, Custom | `measureLUFS`, `normalizeLoudness` |
| Speed / pitch | Pitch-preserving tempo + semitone pitch | SoundTouchJS |
| Music bed | Upload a track, auto-ducking under speech, volume slider, loop + fades | `mixMusic` |
| Edit | Before/After toggle that keeps your place while playing (time maps through every cut), canvas waveform, trim handles, select-and-cut, undo | `waveform.js` |
| Export | WAV 16/24-bit, MP3 128/192/320 (lamejs), `-clean` suffix, LUFS + true peak shown, Web Share | |
| Subtitles | SRT from the same Whisper run, mapped through all cuts and speed | `buildSRT` |
| Video | Remux clean audio into the original MP4/WebM (H.264 copy + AAC, or VP9 copy + Opus). "Video sync" keeps the timeline so it stays in sync | ffmpeg.wasm 0.12 single-thread |
| Batch | Many files with the current settings, optional filler removal, auto-download each | |
| PWA | Manifest, maskable icons, service worker (app shell precache, CDN cache-first) — works offline after first use | `sw.js` |

**Processing order:** decode → mono/48k → noise → de-click → breath → filler cut → silence trim → de-ess →
EQ preset → leveling → speed/pitch → music → loudness + limiter → fades → export.

## Files
```
index.html            app shell (Clean / Record / Batch / Settings)
css/app.css           design tokens (light + dark), mobile-first layout
js/app.js             UI controller, player, A/B, export, batch, record
js/dsp.js             pure DSP (runs in worker, main thread and Node)
js/pipeline.js        processing chain (stage A repair, stage B edit+master)
js/dsp-worker.js      heavy DSP off the main thread
js/whisper-worker.js  speech recognition (Whisper tiny/base, word timestamps)
js/mp3-worker.js      lamejs MP3 encoding
js/engine.js          decode, worker RPC, ffmpeg remux, live recorder
js/capture-worklet.js mic capture + level
js/waveform.js        canvas waveform + live meter
sw.js, manifest.webmanifest, icons/
tests/                Node unit tests + fixture generator
```

## Tests
```
python3 tests/make_test_audio.py   # espeak speech + noise + hum + clicks + long gaps (needs espeak-ng, ffmpeg, numpy)
npm test                            # node --test tests/*.test.mjs
```

## Notes
- Whisper usually omits "um/uh" from transcripts; Sonvel pairs it with an acoustic hesitation detector and snaps
  filler cuts to the real sound. The first use downloads the model (Fast ≈ 65 MB, Better ≈ 140 MB), then it is
  cached for offline use.
- Whisper must use an fp32 encoder; the q8 encoder hallucinates. The decoder is q8.
- Brand: **Sonvel**. Logo files in `icons/` (`logo.svg`, `logo-dark.svg`, `logo-mark.svg`, `favicon.svg`, PNGs).
