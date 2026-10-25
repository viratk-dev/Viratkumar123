// Sonvel app controller: screens, state, player, export, batch, recording.
import * as D from './dsp.js';
import { DEFAULT_SETTINGS, MAGIC_SETTINGS, structuredCloneSafe } from './pipeline.js';
import { dspRPC, asrRPC, decodeToMono48k, encodeMP3, remuxVideo, LiveRecorder, downloadBlob, shareBlob } from './engine.js';
import { Waveform, Meter } from './waveform.js';

const VERSION = '1.0.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };
const fmtTime = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const fmtNum = (v, d = 1) => (isFinite(v) ? v.toFixed(d).replace('-', '−') : '—');
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const baseName = (n) => (n || 'audio').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '').trim() || 'audio';
const isDesktop = matchMedia('(min-width: 1024px)');

/* ---------------------------------------------------------------- persistence */
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function mergeDeep(base, over) { const o = structuredCloneSafe(base); for (const k in over || {}) o[k] = typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? { ...base[k], ...over[k] } : over[k]; return o; }

const S = {
  settings: mergeDeep(DEFAULT_SETTINGS, load('sonvel.settings', {})),
  prefs: { model: 'onnx-community/whisper-tiny_timestamped', lang: '', format: 'mp3-192', ...load('sonvel.prefs', {}) },
  file: null, name: '', isVideo: false, allowCuts: true,
  x: null, id: 0, workerId: null, aKey: null,
  result: null, trim: null, undo: [], sel: null,
  words: null, wordsId: -1, fillers: [], fillerSpans: [],
  music: null, musicName: '',
  exportCache: null,
};
const saveSettings = () => { const s = structuredCloneSafe(S.settings); save('sonvel.settings', s); };
const savePrefs = () => save('sonvel.prefs', S.prefs);

/* ---------------------------------------------------------------- toasts */
function toast(msg, { action, onAction, timeout = 3600 } = {}) {
  $$('#toasts .toast').forEach((t) => { if (t.firstChild.textContent === msg) t.remove(); });
  if ($$('#toasts .toast').length >= 2) $('#toasts .toast').remove();
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
  el.innerHTML = `<span></span>`; el.firstChild.textContent = msg;
  if (action) { const b = document.createElement('button'); b.textContent = action; b.onclick = () => { onAction?.(); close(); }; el.appendChild(b); }
  $('#toasts').appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  setTimeout(close, timeout);
}

/* ---------------------------------------------------------------- theme */
function setTheme(t, persist = true) {
  document.documentElement.dataset.theme = t;
  $('#theme-color').setAttribute('content', t === 'dark' ? '#0F0F0E' : '#F6F5F1');
  $('#theme-btn').innerHTML = `<svg><use href="#i-${t === 'dark' ? 'sun' : 'moon'}"/></svg>`;
  $('#theme-btn').setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  $$('#theme-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
  syncSeg($('#theme-seg'));
  if (persist) { try { localStorage.setItem('sonvel.theme', t); } catch {} }
  requestAnimationFrame(() => { waveIn?.draw(); waveOut?.draw(); meter?.draw(); });
}

/* ---------------------------------------------------------------- segmented controls */
function syncSeg(seg) {
  if (!seg || !seg.offsetParent) return;
  const b = seg.querySelector('button[aria-pressed="true"]'); const th = seg.querySelector('.thumb'); if (!b || !th) return;
  th.style.width = b.offsetWidth + 'px'; th.style.transform = `translateX(${b.offsetLeft - 4}px)`;
}
const syncAllSegs = () => $$('.seg').forEach(syncSeg);
addEventListener('resize', syncAllSegs);

/* ---------------------------------------------------------------- tabs */
function goTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
  player.stop();
  $$('#toasts .toast').forEach((t) => t.remove());
  $('#coach').classList.toggle('hidden', !(name === 'clean' && cleanScreen.dataset.state === 'empty' && !localStorage.getItem('sonvel.onboarded')));
  scrollTo({ top: 0 });
  requestAnimationFrame(() => { syncAllSegs(); waveIn?.resize(); waveOut?.resize(); meter?.resize(); });
}
$$('.tab').forEach((t) => t.addEventListener('click', () => { buzz(); goTab(t.dataset.tab); }));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.goto)));
addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', scrollY > 4), { passive: true });

/* ---------------------------------------------------------------- clean state */
const cleanScreen = $('[data-screen="clean"]');
function setState(st) {
  cleanScreen.dataset.state = st;
  if (st !== 'empty') $('#coach').classList.add('hidden');
  $$('#clean-main > [data-show]').forEach((el) => el.classList.toggle('hidden', el.dataset.show !== st));
  requestAnimationFrame(() => { syncAllSegs(); waveIn?.resize(); waveOut?.resize(); });
  updatePanelApply();
}

/* ---------------------------------------------------------------- player */
class Player {
  constructor() { this.ctx = null; this.src = null; this.playing = false; this.offset = 0; this.buf = null; this.range = null; this.listeners = new Set(); }
  ensure() { if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; this.ctx = new C({ sampleRate: D.SR }); } if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
  setAudio(x, key) { if (this.key === key && this.buf) return; this.stop(); this.key = key; const c = this.ensure(); this.buf = c.createBuffer(1, Math.max(1, x.length), D.SR); this.buf.copyToChannel(x, 0); this.offset = 0; }
  get duration() { return this.buf ? this.buf.duration : 0; }
  position() { if (!this.playing) return this.offset; return Math.min(this.end(), this.offset + (this.ctx.currentTime - this.t0)); }
  end() { return this.range ? this.range[1] : this.duration; }
  play(from = this.offset) {
    if (!this.buf) return; const c = this.ensure(); this.stopSrc();
    const start = this.range ? Math.max(this.range[0], Math.min(from, this.range[1])) : from;
    const s0 = start >= this.end() - 0.02 ? (this.range ? this.range[0] : 0) : start;
    const src = c.createBufferSource(); src.buffer = this.buf; src.connect(c.destination);
    src.start(0, s0, Math.max(0.01, this.end() - s0));
    src.onended = () => { if (this.src === src) { this.playing = false; this.offset = this.end(); this.emit(); } };
    this.src = src; this.t0 = c.currentTime; this.offset = s0; this.playing = true; this.emit(); loop();
  }
  pause() { if (!this.playing) return; this.offset = this.position(); this.stopSrc(); this.playing = false; this.emit(); }
  stop() { this.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) { const was = this.playing; this.offset = Math.max(0, Math.min(this.duration, t)); if (was) this.play(this.offset); else this.emit(); }
  stopSrc() { if (this.src) { this.src.onended = null; try { this.src.stop(); } catch {} this.src.disconnect(); this.src = null; } }
  on(fn) { this.listeners.add(fn); } emit() { this.listeners.forEach((f) => f()); }
}
const player = new Player();
let raf = 0;
function loop() { cancelAnimationFrame(raf); const tick = () => { player.emit(); if (player.playing) raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); }

let view = 'in'; // which waveform the player drives: 'in' | 'before' | 'after'
player.on(() => {
  const t = player.position();
  const icon = `<svg><use href="#i-${player.playing ? 'pause' : 'play'}"/></svg>`;
  if (view === 'in') { waveIn.setPos(t); $('#in-pos').textContent = fmtTime(t); if ($('#in-play').dataset.icon !== String(player.playing)) { $('#in-play').innerHTML = icon; $('#in-play').dataset.icon = String(player.playing); } }
  else {
    waveOut.setPos(t);
    $('#out-time').innerHTML = `<b>${fmtTime(t)}</b> / ${fmtTime(player.duration)}`;
    if ($('#out-play').dataset.icon !== String(player.playing)) { $('#out-play').innerHTML = icon; $('#out-play').dataset.icon = String(player.playing); $('#out-play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play'); }
  }
});

/* ---------------------------------------------------------------- waveforms */
const waveIn = new Waveform($('#wave-in'), { onSeek: (t) => { view = 'in'; player.seek(t); } });
waveIn.tone = 'idle';
const waveOut = new Waveform($('#wave-out'), {
  onSeek: (t) => player.seek(t),
  onTrim: (tr) => { S.trim = [...tr]; player.range = abMode === 'after' ? S.trim : null; updateStats(); },
  onSelect: (sel) => { S.sel = sel; $('#cut-apply').classList.toggle('hidden', !(sel && sel[1] - sel[0] > 0.05)); },
});
let meter = null;
const waveProc = new Waveform($('#wave-proc')); waveProc.tone = 'progress';

/* ---------------------------------------------------------------- loading files */
const fileInput = $('#file-input');
$('#drop').addEventListener('click', () => { buzz(); fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('dragging'); }));
['dragleave', 'drop'].forEach((ev) => addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && e.relatedTarget) return; $('#drop').classList.remove('dragging'); }));
addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
  const onBatch = $('[data-screen="batch"]').classList.contains('active');
  if (onBatch || files.length > 1) { addBatch(files); goTab('batch'); } else { goTab('clean'); openFile(files[0]); }
});

async function openFile(file) {
  dismissCoach();
  const video = /^video\//.test(file.type) || /\.(mp4|mov|m4v)$/i.test(file.name);
  setState('loaded');
  $('#file-name').textContent = file.name; $('#file-info').textContent = 'Reading…';
  $('#wave-in').classList.add('skeleton'); waveIn.set(null); $('#magic-btn').disabled = true; $('#in-play').disabled = true;
  try {
    const { x, duration, channels } = await decodeToMono48k(file, { onFallback: () => { $('#file-info').textContent = 'Opening with the video tool…'; } });
    loadAudio(x, file.name, { file, isVideo: video, channels });
    $('#file-info').textContent = `${fmtTime(duration)} · ${(file.name.split('.').pop() || '').toUpperCase()} · ${fmtSize(file.size)}`;
  } catch (e) {
    setState('empty'); toast(e.message || 'Could not read this file.');
  } finally { $('#wave-in').classList.remove('skeleton'); $('#magic-btn').disabled = false; $('#in-play').disabled = false; }
}

function loadAudio(x, name, { file = null, isVideo = false, channels = 1 } = {}) {
  player.stop();
  S.x = x; S.name = name; S.file = file; S.isVideo = isVideo; S.allowCuts = !isVideo;
  S.id++; S.aKey = null; S.result = null; S.words = null; S.fillers = []; S.fillerSpans = []; S.trim = null; S.undo = []; S.exportCache = null;
  $('#file-name').textContent = name;
  $('#file-info').textContent = `${fmtTime(x.length / D.SR)} · ${channels > 1 ? 'Stereo → mono' : 'Mono'} · 48 kHz`;
  $('#file-kind').innerHTML = `<use href="#i-${isVideo ? 'video' : 'file'}"/>`;
  $('#in-dur').textContent = fmtTime(x.length / D.SR); $('#in-pos').textContent = '0:00';
  $('#video-note').classList.toggle('hidden', !isVideo);
  waveIn.set(x); view = 'in'; player.setAudio(x, 'in' + S.id); player.range = null;
  resetFillerCard();
  setState('loaded');
}

$('#file-remove').addEventListener('click', () => { player.stop(); S.x = null; setState('empty'); });
$('#in-play').addEventListener('click', () => { buzz(); view = 'in'; player.setAudio(S.x, 'in' + S.id); player.range = null; player.toggle(); });
$('#video-sync-off').addEventListener('click', () => { S.allowCuts = true; $('#video-note').classList.add('hidden'); toast('Cuts are on. Export will be audio only.'); });

/* ---------------------------------------------------------------- settings panel */
const VOICE = Object.entries(D.VOICE_PRESETS).map(([k, v]) => [k, v.label]);
const LOUD = Object.entries(D.LOUDNESS_PRESETS).map(([k, v]) => [k, k === 'custom' ? 'Custom' : `${v.label} ${v.target}`]);
const panel = document.createElement('div'); panel.className = 'panel';
function sw(id, label) { return `<label class="switch"><input type="checkbox" data-k="${id}" aria-label="${label}"></label>`; }
function slider(id, min, max, step, label) { return `<div class="slider-row"><input type="range" data-k="${id}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><output data-o="${id}"></output></div>`; }
function setting(key, title, desc, sliderHtml = '') { return `<div class="setting" data-set="${key}"><div class="setting-head"><div class="t"><b>${title}</b><span>${desc}</span></div>${sw(key + '.on', title)}</div>${sliderHtml}</div>`; }
panel.innerHTML = `
  <div class="spread only-desktop" style="margin-bottom:6px"><h3>Cleaning steps</h3><button class="btn sm ghost" data-reset>Reset</button></div>
  <p class="label group-title">Voice</p>
  <div class="chips" data-chips="voice">${VOICE.map(([k, l]) => `<button class="chip" data-v="${k}">${l}</button>`).join('')}</div>
  <p class="label group-title">Loudness</p>
  <div class="chips" data-chips="loud">${LOUD.map(([k, l]) => `<button class="chip" data-v="${k}">${l.replace(/-(\d)/, '−$1')}</button>`).join('')}</div>
  <div class="setting hidden" data-custom-loud>
    <div class="setting-head"><div class="t"><b>Target loudness</b><span>Integrated LUFS</span></div></div>${slider('loud.target', -24, -9, 0.5, 'Target loudness')}
    <div class="setting-head"><div class="t"><b>Peak ceiling</b><span>True peak, dBTP</span></div></div>${slider('loud.tp', -6, -0.5, 0.5, 'Peak ceiling')}
  </div>
  <p class="label group-title">Repair</p>
  ${setting('noise', 'Remove noise', 'AI noise removal (RNNoise). Lower keeps more room sound.', slider('noise.strength', 0, 1, 0.05, 'Noise removal strength'))}
  ${setting('declick', 'Remove clicks', 'Fixes clicks, pops and mouth noise.')}
  ${setting('breath', 'Softer breaths', 'Turns down breaths between words.', slider('breath.amount', 3, 24, 1, 'Breath reduction'))}
  ${setting('deess', 'De-ess', 'Tames sharp “s” and “sh” sounds.', slider('deess.amount', 0.1, 1, 0.05, 'De-esser amount'))}
  <p class="label group-title">Edit</p>
  ${setting('trim', 'Trim long pauses', 'Shortens long silences. Short pauses stay.', slider('trim.maxPause', 0.2, 1.5, 0.05, 'Longest pause'))}
  <div class="setting" data-set="fillers"><div class="setting-head"><div class="t"><b>Cut filler words</b><span>Uses the list you review after cleaning.</span></div>${sw('fillers.on', 'Cut filler words')}</div>
    <div class="setting-head"><div class="t"><b style="font-weight:600">Hindi fillers</b><span>matlab · toh · haan · acha</span></div>${sw('fillers.hindi', 'Hindi fillers')}</div></div>
  <p class="label group-title">Polish</p>
  ${setting('level', 'Auto leveling', 'Evens out quiet and loud parts.', slider('level.amount', 0.1, 1, 0.05, 'Leveling amount'))}
  <div class="setting"><div class="setting-head"><div class="t"><b>Speed</b><span>Keeps your natural pitch.</span></div></div>${slider('speed.tempo', 0.75, 1.5, 0.05, 'Speed')}</div>
  <div class="setting"><div class="setting-head"><div class="t"><b>Pitch</b><span>In semitones.</span></div></div>${slider('speed.semitones', -6, 6, 0.5, 'Pitch')}</div>
  <div class="setting"><div class="setting-head"><div class="t"><b>Fade in / out</b><span>Soft start and end.</span></div></div>${slider('fades.in', 0, 2, 0.05, 'Fade in')}${slider('fades.out', 0, 3, 0.05, 'Fade out')}</div>
  <p class="label group-title">Background music</p>
  <div class="setting" data-set="music">
    <div class="setting-head"><div class="t"><b data-music-name>No track</b><span>Ducks automatically while you talk.</span></div>${sw('music.on', 'Background music')}</div>
    <div class="btn-row"><button class="btn sm" data-music-pick>Choose track</button><button class="btn sm ghost hidden" data-music-clear>Remove</button></div>
    ${slider('music.volume', 0.02, 0.6, 0.01, 'Music volume')}
    <div class="setting-head"><div class="t"><b style="font-weight:600">Auto ducking</b><span>Lower music under speech.</span></div>${sw('music.duck', 'Auto ducking')}</div>
  </div>
  <div class="only-desktop" style="margin-top:18px"><button class="btn primary block" data-apply>Apply changes</button></div>`;

const getK = (k) => k.split('.').reduce((o, p) => o?.[p], S.settings);
const setK = (k, v) => { const ps = k.split('.'); let o = S.settings; while (ps.length > 1) o = o[ps.shift()]; o[ps[0]] = v; };
const outFmt = {
  'noise.strength': (v) => Math.round(v * 100) + '%', 'breath.amount': (v) => '−' + v + ' dB', 'deess.amount': (v) => Math.round(v * 100) + '%',
  'trim.maxPause': (v) => (+v).toFixed(2) + ' s', 'level.amount': (v) => Math.round(v * 100) + '%', 'speed.tempo': (v) => (+v).toFixed(2) + '×',
  'speed.semitones': (v) => (v > 0 ? '+' : '') + (+v).toFixed(1), 'fades.in': (v) => 'in ' + (+v).toFixed(2) + ' s', 'fades.out': (v) => 'out ' + (+v).toFixed(2) + ' s',
  'music.volume': (v) => Math.round(v * 100) + '%', 'loud.target': (v) => fmtNum(+v, 1) + ' LUFS', 'loud.tp': (v) => fmtNum(+v, 1) + ' dB',
};
function fill(r) { r.style.setProperty('--fill', ((r.value - r.min) / (r.max - r.min)) * 100 + '%'); }
function renderPanel() {
  $$('input[data-k]', panel).forEach((i) => {
    const v = getK(i.dataset.k);
    if (i.type === 'checkbox') i.checked = !!v; else { i.value = v; fill(i); const o = panel.querySelector(`[data-o="${i.dataset.k}"]`); if (o) o.textContent = outFmt[i.dataset.k]?.(v) ?? v; }
  });
  $$('[data-set]', panel).forEach((s) => { const on = getK(s.dataset.set + '.on'); s.classList.toggle('off', on === false); });
  $$('[data-chips="voice"] .chip', panel).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.v === S.settings.voice.preset)));
  $$('[data-chips="loud"] .chip', panel).forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.v === S.settings.loud.preset)));
  $('[data-custom-loud]', panel).classList.toggle('hidden', S.settings.loud.preset !== 'custom');
  $('[data-music-name]', panel).textContent = S.musicName || 'No track';
  $('[data-music-clear]', panel).classList.toggle('hidden', !S.music);
}
panel.addEventListener('input', (e) => {
  const i = e.target.closest('input[data-k]'); if (!i) return;
  const v = i.type === 'checkbox' ? i.checked : parseFloat(i.value);
  setK(i.dataset.k, v); if (i.type !== 'checkbox') fill(i);
  if (i.dataset.k === 'music.on' && v && !S.music) { $('#music-input').click(); }
  saveSettings(); renderPanel(); markDirty();
});
panel.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    buzz(); const grp = chip.parentElement.dataset.chips;
    if (grp === 'voice') S.settings.voice.preset = chip.dataset.v;
    if (grp === 'loud') { S.settings.loud.preset = chip.dataset.v; const p = D.LOUDNESS_PRESETS[chip.dataset.v]; if (chip.dataset.v !== 'custom') { S.settings.loud.target = p.target; S.settings.loud.tp = p.tp; } }
    saveSettings(); renderPanel(); markDirty(); return;
  }
  if (e.target.closest('[data-reset]')) { S.settings = structuredCloneSafe(DEFAULT_SETTINGS); saveSettings(); renderPanel(); markDirty(); toast('Settings reset to recommended.'); }
  if (e.target.closest('[data-apply]')) { applySettings(); }
  if (e.target.closest('[data-music-pick]')) $('#music-input').click();
  if (e.target.closest('[data-music-clear]')) { S.music = null; S.musicName = ''; S.settings.music.on = false; saveSettings(); renderPanel(); markDirty(); }
});
$('#music-input').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) { if (!S.music) { S.settings.music.on = false; renderPanel(); } return; }
  try { const { x } = await decodeToMono48k(f); S.music = x; S.musicName = f.name; S.settings.music.on = true; saveSettings(); renderPanel(); markDirty(); toast('Music added. It ducks under your voice.'); }
  catch (err) { toast(err.message); S.settings.music.on = false; renderPanel(); }
});
let dirty = false;
function markDirty() { dirty = true; updatePanelApply(); }
function updatePanelApply() {
  const st = cleanScreen.dataset.state; const b = panel.querySelector('[data-apply]');
  if (b) { b.disabled = !(st === 'loaded' || st === 'result'); b.textContent = st === 'result' ? (dirty ? 'Apply changes' : 'Re-run with these settings') : 'Clean with these settings'; }
}
function placePanel() {
  if (isDesktop.matches) $('#side-panel').appendChild(panel); else $('#sheet-panel-host').appendChild(panel);
  renderPanel(); updatePanelApply();
}
isDesktop.addEventListener('change', () => { placePanel(); closeSheets(); });

/* ---------------------------------------------------------------- sheets */
let lastFocus = null;
function openSheet(id) {
  lastFocus = document.activeElement; document.body.classList.add('sheet-open');
  $('#scrim').classList.add('open'); const s = $(id); s.classList.add('open');
  setTimeout(() => { s.querySelector('[data-close]')?.focus(); syncAllSegs(); }, 60);
}
function closeSheets() { document.body.classList.remove('sheet-open'); $$('.sheet.open').forEach((s) => s.classList.remove('open')); $('#scrim').classList.remove('open'); lastFocus?.focus?.(); }
$('#scrim').addEventListener('click', closeSheets);
$$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheets();
  if (e.key === ' ' && cleanScreen.dataset.state === 'result' && cleanScreen.classList.contains('active') && !e.target.closest('input,button,textarea')) { e.preventDefault(); player.toggle(); }
});
$('#customize-btn').addEventListener('click', () => { buzz(); openSheet('#settings-sheet'); });
$('#tweak-btn').addEventListener('click', () => { buzz(); openSheet('#settings-sheet'); });
$('#sheet-apply').addEventListener('click', () => { closeSheets(); applySettings(); });
function applySettings() { dirty = false; if (S.x) runClean({ magic: false }); }

/* ---------------------------------------------------------------- processing */
const STEP_LABEL = {
  model: 'Loading noise model', noise: 'Removing noise', declick: 'Fixing clicks and pops', breath: 'Softening breaths',
  fillers: 'Cutting filler words', trim: 'Tightening long pauses', deess: 'Taming harsh S sounds', eq: 'Shaping your voice',
  level: 'Evening out volume', speed: 'Changing speed', music: 'Mixing music', loudness: 'Setting loudness',
};
function effective() {
  const s = structuredCloneSafe(S.settings);
  if (!S.allowCuts) { s.trim.on = false; s.fillers.on = false; s.speed.tempo = 1; }
  return s;
}
const aKeyOf = (s) => JSON.stringify([s.noise, s.declick, s.breath]);
function planSteps(s, needA) {
  const st = [];
  if (needA) { if (s.noise.on) st.push('noise'); if (s.declick.on) st.push('declick'); if (s.breath.on) st.push('breath'); }
  if (s.fillers.on && S.fillerSpans.length) st.push('fillers');
  if (s.trim.on) st.push('trim'); if (s.deess.on) st.push('deess'); st.push('eq'); if (s.level.on) st.push('level');
  if (Math.abs(s.speed.tempo - 1) > 1e-3 || Math.abs(s.speed.semitones) > 1e-3) st.push('speed');
  if (s.music.on && S.music) st.push('music'); st.push('loudness');
  return st;
}
let running = false, cancelled = false;
async function ensureWorkerAudio() {
  if (S.workerId === S.id) return;
  const copy = S.x.slice();
  await dspRPC.call('load', { id: 'main', x: copy }, [copy.buffer]);
  S.workerId = S.id; S.aKey = null;
}
async function runClean({ magic = false, quiet = false } = {}) {
  if (!S.x || running) return;
  if (magic) { const keep = { speed: S.settings.speed, music: S.settings.music, fades: S.settings.fades, fillers: S.settings.fillers }; S.settings = { ...MAGIC_SETTINGS(S.settings), ...keep }; saveSettings(); renderPanel(); }
  running = true; cancelled = false; dirty = false; player.stop();
  const s = effective(); const key = aKeyOf(s);
  const needA = S.aKey !== key || S.workerId !== S.id;
  const steps = planSteps(s, needA);
  const list = $('#proc-steps'); list.innerHTML = steps.map((k) => `<li data-step="${k}"><span class="dot"><svg><use href="#i-check"/></svg></span>${STEP_LABEL[k]}</li>`).join('');
  setState('processing');
  waveProc.set(S.x); waveProc.setPos(0);
  const t0 = performance.now();
  const onProgress = ({ step, p }) => {
    if (step === 'model') { $('#proc-title').textContent = STEP_LABEL.model + '…'; return; }
    const i = steps.indexOf(step); if (i < 0) return;
    $$('li', list).forEach((li, j) => { li.classList.toggle('done', j < i); li.classList.toggle('now', j === i); });
    $('#proc-title').textContent = STEP_LABEL[step] + '…';
    const pct = Math.round(((i + Math.min(1, p || 0)) / steps.length) * 100);
    $('#proc-bar > i').style.width = pct + '%'; $('#proc-bar').setAttribute('aria-valuenow', pct);
    $('#proc-kicker').textContent = `Cleaning · ${pct}%`;
    waveProc.setPos((pct / 100) * waveProc.dur);
  };
  $('#proc-bar > i').style.width = '0%'; $('#proc-title').textContent = 'Getting ready…'; $('#proc-kicker').textContent = 'Cleaning · 0%';
  try {
    await ensureWorkerAudio();
    if (needA) {
      const a = await dspRPC.call('stageA', { id: 'main', settings: s }, [], { onProgress, onWarn: (m) => toast(m) });
      S.aKey = key; S.aStats = a.stats;
    }
    const music = s.music.on && S.music ? S.music.slice() : null;
    const r = await dspRPC.call('stageB', { id: 'main', settings: s, fillerSpans: s.fillers.on ? S.fillerSpans : [], music, allowCuts: S.allowCuts }, music ? [music.buffer] : [], { onProgress, onWarn: (m) => toast(m) });
    if (cancelled) return;
    $$('li', list).forEach((li) => { li.classList.add('done'); li.classList.remove('now'); });
    $('#proc-bar > i').style.width = '100%'; waveProc.setPos(waveProc.dur);
    S.result = { y: r.y, chain: r.chain, stats: r.stats, settings: s, ms: performance.now() - t0 };
    S.trim = null; S.undo = []; S.sel = null; S.exportCache = null;
    await new Promise((res) => setTimeout(res, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260));
    showResult(); buzz(18);
    if (!quiet) toast(`Cleaned in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    if (!cancelled) { toast(e.message || 'Something went wrong while cleaning.'); setState(S.result ? 'result' : 'loaded'); }
  } finally { running = false; }
}
$('#magic-btn').addEventListener('click', () => { buzz(12); runClean({ magic: true }); });
$('#proc-cancel').addEventListener('click', () => {
  cancelled = true; running = false; dspRPC.terminate(); S.workerId = null; S.aKey = null;
  setState(S.result ? 'result' : 'loaded'); toast('Cancelled.');
});

/* ---------------------------------------------------------------- result */
let abMode = 'after';
function fullChain() { return S.result ? S.result.chain : []; }
function showResult() {
  setState('result');
  $('#res-file').textContent = S.name;
  setTool('seek');
  setAB('after', false);
  updateStats();
  $('#undo-btn').classList.toggle('hidden', !S.undo.length);
  renderFillerCard();
}
function setAB(mode, keepTime = true) {
  const was = player.playing; const t = player.position();
  let nt = 0;
  if (keepTime) nt = mode === 'after' ? D.chainFwd(fullChain(), t) : D.chainInv(fullChain(), t);
  abMode = mode; view = mode;
  $$('#ab button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ab === mode))); syncSeg($('#ab'));
  if (mode === 'after') { player.setAudio(S.result.y, 'out' + S.id + ':' + S.result.y.length + ':' + S.undo.length); player.range = S.trim; waveOut.tone = 'accent'; waveOut.set(S.result.y); waveOut.trim = S.trim ? [...S.trim] : null; }
  else { player.setAudio(S.x, 'in' + S.id); player.range = null; waveOut.tone = 'idle'; waveOut.set(S.x); waveOut.trim = null; }
  $('#tools').classList.toggle('hidden', mode !== 'after');
  if (mode !== 'after') { setTool('seek'); }
  $('#ab-label').textContent = mode === 'after' ? 'Cleaned' : 'Original';
  player.offset = Math.max(0, Math.min(player.duration, nt));
  if (was) player.play(player.offset); else player.emit();
}
$$('#ab button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.ab === abMode) return; buzz(); setAB(b.dataset.ab); }));
$('#out-play').addEventListener('click', () => { buzz(); player.toggle(); });

function setTool(mode) {
  waveOut.setMode(mode); if (mode === 'trim') { S.trim = waveOut.trim ? [...waveOut.trim] : [0, S.result.y.length / D.SR]; waveOut.trim = [...S.trim]; player.range = S.trim; }
  if (mode !== 'cut') { waveOut.sel = null; S.sel = null; $('#cut-apply').classList.add('hidden'); }
  $$('#tools .tool[data-mode]').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.mode === mode)));
  const hint = { trim: 'Drag the handles to trim the start and end.', cut: 'Drag across the part you want to remove, then tap Cut.' }[mode];
  $('#mode-hint').textContent = hint || ''; $('#mode-hint').classList.toggle('hidden', !hint);
  waveOut.draw(); updateStats();
}
$$('#tools .tool[data-mode]').forEach((t) => t.addEventListener('click', () => { buzz(); setTool(waveOut.mode === t.dataset.mode ? 'seek' : t.dataset.mode); }));
$('#cut-apply').addEventListener('click', () => {
  const sel = S.sel; if (!sel || !S.result) return; buzz(12);
  const dur = S.result.y.length / D.SR;
  S.undo.push({ y: S.result.y, chainLen: S.result.chain.length, trim: S.trim });
  const r = D.applyKeeps(S.result.y, D.spansToKeeps([sel], dur), { xfadeMs: 12 });
  S.result.y = r.y; S.result.chain.push({ type: 'cut', map: r.map, manual: true });
  if (S.trim) S.trim = [D.mapTime(r.map, S.trim[0]), D.mapTime(r.map, S.trim[1])];
  S.exportCache = null; S.sel = null; waveOut.sel = null;
  setAB('after', false); setTool('seek'); $('#undo-btn').classList.remove('hidden');
  toast(`Cut ${(sel[1] - sel[0]).toFixed(1)} s`, { action: 'Undo', onAction: undo });
});
function undo() {
  const u = S.undo.pop(); if (!u) return;
  S.result.y = u.y; S.result.chain.length = u.chainLen; S.trim = u.trim; S.exportCache = null;
  setAB('after', false); setTool('seek'); $('#undo-btn').classList.toggle('hidden', !S.undo.length);
}
$('#undo-btn').addEventListener('click', () => { buzz(); undo(); });

function finalDuration() { if (!S.result) return 0; const d = S.result.y.length / D.SR; return S.trim ? S.trim[1] - S.trim[0] : d; }
function updateStats() {
  if (!S.result) return;
  const inDur = S.x.length / D.SR, out = finalDuration();
  const saved = Math.max(0, inDur - out);
  $('#st-saved').innerHTML = saved >= 60 ? `${fmtTime(saved)}` : `${saved.toFixed(1)}<small>s</small>`;
  $('#st-fillers').textContent = String(S.result.stats.fillersRemoved || 0);
  $('#st-lufs').innerHTML = `${fmtNum(S.result.stats.lufs, 1)}<small>LUFS</small>`;
  $('#st-len').textContent = fmtTime(out);
}

/* ---------------------------------------------------------------- speech AI: fillers + subtitles */
function resetFillerCard() {
  $('#filler-empty').classList.remove('hidden'); $('#filler-progress').classList.add('hidden'); $('#filler-list-wrap').classList.add('hidden');
}
function renderFillerCard() {
  if (!S.allowCuts) {
    $('#filler-empty').innerHTML = `<div class="note"><svg><use href="#i-video"/></svg><div>Filler removal is off while <b>video sync</b> is on, so your voice stays in sync with the picture.</div></div>`;
    return;
  }
  if (S.fillers.length) showFillerList(); else resetFillerCard();
}
async function ensureWords(onProgress) {
  if (S.words && S.wordsId === S.id) return S.words;
  await ensureWorkerAudio();
  if (S.aKey === null) { // stage A is needed for the 16 kHz copy
    await dspRPC.call('stageA', { id: 'main', settings: effective() }, []); S.aKey = aKeyOf(effective());
  }
  const a16 = await dspRPC.call('get16k', { id: 'main' });
  const res = await asrRPC.call('run', { audio: a16.y, model: S.prefs.model, language: S.prefs.lang || null }, [a16.y.buffer], { onProgress });
  S.words = res.words; S.wordsId = S.id;
  return S.words;
}
function asrProgress(label, bar, pctEl) {
  return ({ step, p, loaded, total }) => {
    const pct = Math.round((p || 0) * 100);
    if (step === 'download') label.textContent = total ? `Downloading speech AI · ${fmtSize(loaded)} of ${fmtSize(total)}` : 'Downloading speech AI…';
    else label.textContent = 'Listening for filler words…';
    bar.style.width = pct + '%'; if (pctEl) pctEl.textContent = pct + '%';
  };
}
$('#find-fillers').addEventListener('click', async () => {
  buzz(); $('#filler-empty').classList.add('hidden'); $('#filler-progress').classList.remove('hidden');
  try {
    const words = await ensureWords(asrProgress($('#asr-label'), $('#asr-bar'), $('#asr-pct')));
    $('#asr-label').textContent = 'Checking pauses…';
    const found = D.detectFillers(words, { hindi: S.settings.fillers.hindi });
    let hes = [];
    try { hes = (await dspRPC.call('hesitations', { id: 'main', words })).list; } catch {}
    // Whisper's word timing for fillers is loose; snap each one to the acoustic hesitation next to it.
    const merged = found.map((f) => {
      const h = hes.find((q) => !q.used && q.start < f.end + 0.3 && q.end > f.start - 0.6);
      if (h) { h.used = true; return { ...f, start: Math.min(h.start, f.start), end: Math.max(h.end, Math.min(f.end, h.end + 0.15)) }; }
      return f;
    });
    S.fillers = [...merged, ...hes.filter((q) => !q.used)].sort((a, b) => a.start - b.start).map((f) => ({ ...f, checked: true }));
    showFillerList();
  } catch (e) {
    $('#filler-progress').classList.add('hidden'); $('#filler-empty').classList.remove('hidden');
    toast(`Speech AI couldn’t load. ${navigator.onLine ? '' : 'You’re offline. '}It downloads once, then works offline.`, { timeout: 6000 });
    console.warn('ASR failed:', e.message);
  }
});
function showFillerList() {
  $('#filler-progress').classList.add('hidden'); $('#filler-empty').classList.add('hidden'); $('#filler-list-wrap').classList.remove('hidden');
  const ul = $('#filler-list');
  if (!S.fillers.length) { ul.innerHTML = `<li><span class="lead" style="font-size:15px">No filler words found. Nice and clean.</span></li>`; $('#apply-fillers').classList.add('hidden'); return; }
  $('#apply-fillers').classList.remove('hidden');
  ul.innerHTML = S.fillers.map((f, i) => `<li><label><input type="checkbox" class="check" data-i="${i}" ${f.checked ? 'checked' : ''}><span class="w"></span><span class="label t">${fmtTime(f.start)} · ${(f.end - f.start).toFixed(1)}s</span></label><button class="icon-btn ghost" data-play="${i}" aria-label="Play this filler"><svg><use href="#i-play"/></svg></button></li>`).join('');
  $$('.w', ul).forEach((el, i) => { el.textContent = S.fillers[i].kind === 'sound' ? 'Hesitation' : S.fillers[i].word; });
  updateApplyFillers();
}
$('#filler-list').addEventListener('change', (e) => { const c = e.target.closest('[data-i]'); if (c) { S.fillers[+c.dataset.i].checked = c.checked; updateApplyFillers(); } });
$('#filler-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]'); if (!b) return; const f = S.fillers[+b.dataset.play];
  abMode = 'before'; setAB('before', false); player.seek(Math.max(0, f.start - 0.4)); player.play();
  setTimeout(() => player.pause(), (f.end - f.start + 0.8) * 1000);
});
function updateApplyFillers() { const n = S.fillers.filter((f) => f.checked).length; $('#apply-fillers').textContent = n ? `Remove ${n} filler${n > 1 ? 's' : ''}` : 'Select fillers to remove'; $('#apply-fillers').disabled = !n; }
$('#apply-fillers').addEventListener('click', async () => {
  buzz(12); S.fillerSpans = S.fillers.filter((f) => f.checked).map((f) => ({ start: f.start, end: f.end }));
  S.settings.fillers.on = true; saveSettings(); renderPanel();
  await runClean({ quiet: true }); toast(`Removed ${S.fillerSpans.length} filler${S.fillerSpans.length > 1 ? 's' : ''}.`);
});

/* ---------------------------------------------------------------- export */
const QUALITY = { mp3: [['128', '128 kbps'], ['192', '192 kbps'], ['320', '320 kbps']], wav: [['16', '16-bit'], ['24', '24-bit']] };
let exFmt = S.prefs.format.split('-')[0], exQ = S.prefs.format.split('-')[1];
function finalAudio() {
  if (S.exportCache) return S.exportCache;
  let y = S.result.y;
  if (S.trim) { const a = Math.round(S.trim[0] * D.SR), b = Math.round(S.trim[1] * D.SR); y = D.applyFades(y.slice(a, b), S.trim[0] > 0.01 ? 0.01 : 0, S.trim[1] < y.length / D.SR - 0.01 ? 0.03 : 0); }
  S.exportCache = { y, lufs: D.measureLUFS(y), tp: D.truePeakDb(y) };
  return S.exportCache;
}
function renderExport() {
  $$('#ex-format button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fmt === exFmt)));
  if (!QUALITY[exFmt].some(([k]) => k === exQ)) exQ = exFmt === 'mp3' ? '192' : '16';
  $('#ex-quality').innerHTML = QUALITY[exFmt].map(([k, l]) => `<button class="chip" data-q="${k}" aria-pressed="${k === exQ}">${l}</button>`).join('');
  const f = finalAudio(); const dur = f.y.length / D.SR;
  $('#ex-len').textContent = fmtTime(dur); $('#ex-lufs').textContent = fmtNum(f.lufs, 1); $('#ex-tp').textContent = fmtNum(f.tp, 1);
  const name = `${baseName(S.name)}-clean.${exFmt}`;
  $('#ex-name').textContent = name;
  const bytes = exFmt === 'mp3' ? (dur * +exQ * 1000) / 8 : dur * D.SR * (+exQ / 8) + 44;
  $('#ex-size').textContent = `About ${fmtSize(bytes)} · ${exFmt === 'mp3' ? exQ + ' kbps' : exQ + '-bit'} · 48 kHz mono`;
  const unchanged = S.result.chain.length === 0 && !S.trim && Math.abs((S.result.settings.speed.tempo || 1) - 1) < 1e-3;
  $('#ex-video').classList.toggle('hidden', !S.isVideo || !S.file);
  $('#ex-video').disabled = !unchanged;
  $('#ex-video-note').classList.toggle('hidden', !S.isVideo || unchanged);
  $('#ex-video-note').textContent = 'Video export needs the same length as the original. Turn on video sync (load the file again) and remove trims.';
  $('#ex-share').classList.toggle('hidden', !('canShare' in navigator));
  requestAnimationFrame(() => syncSeg($('#ex-format')));
}
$('#export-btn').addEventListener('click', () => { buzz(12); player.pause(); renderExport(); openSheet('#export-sheet'); });
$$('#ex-format button').forEach((b) => b.addEventListener('click', () => { buzz(); exFmt = b.dataset.fmt; renderExport(); }));
$('#ex-quality').addEventListener('click', (e) => { const c = e.target.closest('[data-q]'); if (!c) return; buzz(); exQ = c.dataset.q; renderExport(); });
async function buildExportBlob(y, fmt, q, onP) {
  if (fmt === 'wav') return new Blob([D.encodeWAV(y, D.SR, +q)], { type: 'audio/wav' });
  return encodeMP3(y, +q, onP);
}
async function doExport(share) {
  const btn = share ? $('#ex-share') : $('#ex-download'); btn.disabled = true;
  const bar = $('#ex-bar'); bar.classList.remove('hidden'); bar.firstElementChild.style.width = '5%';
  try {
    const f = finalAudio();
    const blob = await buildExportBlob(f.y, exFmt, exQ, (p) => (bar.firstElementChild.style.width = Math.round(p * 100) + '%'));
    bar.firstElementChild.style.width = '100%';
    const name = `${baseName(S.name)}-clean.${exFmt}`;
    S.prefs.format = `${exFmt}-${exQ}`; savePrefs();
    if (share) { try { if (!(await shareBlob(blob, name))) downloadBlob(blob, name); } catch (e) { if (e.name !== 'AbortError') downloadBlob(blob, name); } }
    else { downloadBlob(blob, name); toast(`Saved ${name}`); }
    buzz(18);
  } catch (e) { toast('Export failed: ' + e.message); }
  finally { btn.disabled = false; setTimeout(() => bar.classList.add('hidden'), 600); }
}
$('#ex-download').addEventListener('click', () => doExport(false));
$('#ex-share').addEventListener('click', () => doExport(true));
$('#ex-srt').addEventListener('click', async () => {
  const btn = $('#ex-srt'); btn.disabled = true; const bar = $('#ex-bar'); bar.classList.remove('hidden');
  const label = { set textContent(v) { btn.lastChild.textContent = ' ' + v; } };
  try {
    const words = await ensureWords(asrProgress(label, bar.firstElementChild));
    const chain = fullChain(); const off = S.trim ? S.trim[0] : 0; const end = S.trim ? S.trim[1] : Infinity;
    const mapped = [];
    for (const w of words) {
      let removed = false; let a = w.start, b = w.end;
      for (const c of chain) { if (c.type === 'cut') { if (D.isRemoved(c.map, a, b)) { removed = true; break; } a = D.mapTime(c.map, a); b = D.mapTime(c.map, b); } else { a /= c.tempo; b /= c.tempo; } }
      if (removed) continue;
      if (a < off || a > end) continue;
      mapped.push({ text: w.text, start: a - off, end: Math.min(b, end) - off });
    }
    const srt = D.buildSRT(mapped);
    downloadBlob(new Blob([srt], { type: 'application/x-subrip' }), `${baseName(S.name)}-clean.srt`); toast('Subtitles saved.');
  } catch (e) { toast('Subtitles need the speech AI. It couldn’t load: ' + e.message, { timeout: 6000 }); }
  finally { btn.disabled = false; btn.lastChild.textContent = ' Subtitles (.srt)'; bar.classList.add('hidden'); }
});
$('#ex-video').addEventListener('click', async () => {
  const btn = $('#ex-video'); btn.disabled = true; const bar = $('#ex-bar'); bar.classList.remove('hidden');
  toast('Preparing the video tool (about 32 MB, once)…', { timeout: 3500 });
  try {
    const wav = D.encodeWAV(finalAudio().y, D.SR, 16);
    const blob = await remuxVideo(S.file, wav, (p) => (bar.firstElementChild.style.width = Math.round(p * 100) + '%'));
    const ext = blob.type === 'video/webm' ? 'webm' : 'mp4';
    downloadBlob(blob, `${baseName(S.name)}-clean.${ext}`); toast('Video saved with clean audio.'); buzz(18);
  } catch (e) { toast('Video export isn’t available here: ' + e.message + '. You can still export the audio.', { timeout: 7000 }); }
  finally { btn.disabled = false; bar.classList.add('hidden'); }
});
$('#new-btn').addEventListener('click', () => { player.stop(); S.x = null; S.result = null; setState('empty'); fileInput.click(); });

/* ---------------------------------------------------------------- record */
let rec = null, recRaf = 0, recorded = null;
function recUI(state) {
  const card = $('#rec-card'); card.classList.toggle('recording', state === 'recording'); card.classList.toggle('paused', state === 'paused');
  $('#rec-status').textContent = { idle: 'Ready', recording: 'Recording', paused: 'Paused', done: 'Saved' }[state] + ((state === 'recording' || state === 'paused') && rec?.liveNC ? ' · Noise cancel on' : '');
  $('#rec-btn').setAttribute('aria-label', state === 'idle' || state === 'done' ? 'Start recording' : 'Stop recording');
  $('#rec-pause').disabled = !(state === 'recording' || state === 'paused');
  $('#rec-pause').innerHTML = `<svg><use href="#i-${state === 'paused' ? 'play' : 'pause'}"/></svg>`;
  $('#rec-pause').setAttribute('aria-label', state === 'paused' ? 'Resume' : 'Pause');
  $('#rec-discard').disabled = state !== 'done';
  $('#rec-done').classList.toggle('hidden', state !== 'done');
  $('#live-nc').disabled = state === 'recording' || state === 'paused';
}
function recTick() {
  const t = rec ? rec.seconds : 0; const m = Math.floor(t / 60), s = Math.floor(t % 60);
  $('#rec-time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (rec && rec.state !== 'idle') recRaf = requestAnimationFrame(recTick);
}
$('#rec-btn').addEventListener('click', async () => {
  buzz(14);
  if (!rec || rec.state === 'idle') {
    try {
      meter.reset(); recorded = null;
      rec = new LiveRecorder({ onLevel: (rms) => meter.push(rms), onWarn: (m) => toast(m) });
      await rec.start({ liveNC: $('#live-nc').checked });
      recUI('recording'); recTick();
    } catch (e) { rec = null; toast(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser settings.' : 'Could not start the mic: ' + e.message, { timeout: 6000 }); }
  } else {
    recorded = await rec.stop(); cancelAnimationFrame(recRaf); recTick();
    recUI(recorded.length ? 'done' : 'idle');
    if (!recorded.length) toast('Nothing was recorded.');
  }
});
$('#rec-pause').addEventListener('click', () => { buzz(); if (!rec) return; if (rec.state === 'recording') { rec.pause(); recUI('paused'); } else { rec.resume(); recUI('recording'); } });
$('#rec-discard').addEventListener('click', () => { recorded = null; rec = null; meter.reset(); $('#rec-time').textContent = '00:00'; recUI('idle'); });
const recName = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.wav`; };
$('#rec-use').addEventListener('click', () => { if (!recorded) return; buzz(); goTab('clean'); loadAudio(recorded, recName()); });
$('#rec-save').addEventListener('click', () => { if (recorded) downloadBlob(new Blob([D.encodeWAV(recorded, D.SR, 16)], { type: 'audio/wav' }), recName()); });

/* ---------------------------------------------------------------- batch */
const batch = [];
$('#batch-pick').addEventListener('click', () => $('#batch-input').click());
$('#batch-add').addEventListener('click', () => $('#batch-input').click());
$('#batch-input').addEventListener('change', (e) => { addBatch([...e.target.files]); e.target.value = ''; });
function addBatch(files) { for (const f of files) batch.push({ file: f, status: 'wait', p: 0 }); renderBatch(); }
function renderBatch() {
  const has = batch.length > 0;
  $('#batch-empty').classList.toggle('hidden', has); $('#batch-list').classList.toggle('hidden', !has);
  $('#batch-actions').classList.toggle('hidden', !has); $('#batch-opts').classList.toggle('hidden', !has);
  $('#batch-list').innerHTML = batch.map((b, i) => {
    const pill = { wait: '<span class="pill">Waiting</span>', run: `<span class="pill run">${Math.round(b.p * 100)}%</span>`, ok: '', err: '<span class="pill err">Failed</span>' }[b.status];
    const info = b.status === 'ok' ? `<span class="label" style="color:var(--ok)">Done</span><span class="label">${b.info}</span>` : `<span class="label">${b.info || fmtSize(b.file.size)}</span>`;
    return `<li><span class="file-icon"><svg><use href="#i-${b.status === 'ok' ? 'check' : 'file'}"/></svg></span><div class="file-text"><span class="file-name"></span>${info}</div>${pill}${b.blob ? `<button class="icon-btn" style="flex:none" data-dl="${i}" aria-label="Download"><svg><use href="#i-download"/></svg></button>` : b.status === 'wait' ? `<button class="icon-btn ghost" data-rm="${i}" aria-label="Remove"><svg><use href="#i-x"/></svg></button>` : ''}</li>`;
  }).join('');
  $$('#batch-list .file-name').forEach((el, i) => (el.textContent = batch[i].file.name));
  $('#batch-run').textContent = batch.some((b) => b.status === 'wait') ? `Clean all (${batch.filter((b) => b.status === 'wait').length})` : 'All done';
  $('#batch-run').disabled = batchRunning || !batch.some((b) => b.status === 'wait');
}
$('#batch-list').addEventListener('click', (e) => {
  const dl = e.target.closest('[data-dl]'); if (dl) { const b = batch[+dl.dataset.dl]; downloadBlob(b.blob, b.outName); }
  const rm = e.target.closest('[data-rm]'); if (rm) { batch.splice(+rm.dataset.rm, 1); renderBatch(); }
});
let batchRunning = false;
$('#batch-run').addEventListener('click', async () => {
  if (batchRunning) return; batchRunning = true; buzz(12); renderBatch();
  const s = structuredCloneSafe(S.settings); const [fmt, q] = S.prefs.format.split('-');
  for (const b of batch) {
    if (b.status !== 'wait') continue;
    b.status = 'run'; b.p = 0; renderBatch();
    try {
      const { x, duration } = await decodeToMono48k(b.file); b.info = fmtTime(duration);
      const isVid = /^video\//.test(b.file.type);
      const bs = structuredCloneSafe(s); if (isVid) { /* batch exports audio; cuts allowed */ }
      const copy = x.slice(); await dspRPC.call('load', { id: 'batch', x: copy }, [copy.buffer]);
      const prog = (base, span) => ({ p }) => { b.p = base + span * (p || 0); renderBatchProgress(b); };
      await dspRPC.call('stageA', { id: 'batch', settings: bs }, [], { onProgress: prog(0, 0.45) });
      let spans = [];
      if ($('#batch-fillers').checked && bs.fillers.on) {
        try {
          const a16 = await dspRPC.call('get16k', { id: 'batch' });
          const res = await asrRPC.call('run', { audio: a16.y, model: S.prefs.model, language: S.prefs.lang || null }, [a16.y.buffer], { onProgress: prog(0.45, 0.3) });
          spans = D.detectFillers(res.words, { hindi: bs.fillers.hindi }).map((f) => ({ start: f.start, end: f.end }));
        } catch (e) { toast('Speech AI unavailable — skipping fillers for ' + b.file.name); }
      }
      const music = bs.music.on && S.music ? S.music.slice() : null;
      const r = await dspRPC.call('stageB', { id: 'batch', settings: bs, fillerSpans: spans, music }, music ? [music.buffer] : [], { onProgress: prog(0.75, 0.2) });
      b.blob = await buildExportBlob(r.y, fmt, q, (p) => { b.p = 0.95 + 0.05 * p; renderBatchProgress(b); });
      const dup = batch.some((o) => o !== b && baseName(o.file.name) === baseName(b.file.name));
      b.outName = `${baseName(b.file.name)}${dup ? '-' + (b.file.name.split('.').pop() || '').toLowerCase() : ''}-clean.${fmt}`; b.status = 'ok'; b.info = `${fmtTime(r.stats.outDuration)} · ${fmtNum(r.stats.lufs)} LUFS`;
      downloadBlob(b.blob, b.outName);
    } catch (e) { b.status = 'err'; b.info = e.message; }
    renderBatch();
  }
  await dspRPC.call('free', { id: 'batch' }).catch(() => {});
  batchRunning = false; renderBatch(); buzz(18); toast('Batch finished.');
});
function renderBatchProgress(b) { const i = batch.indexOf(b); const pill = $$('#batch-list li')[i]?.querySelector('.pill'); if (pill) pill.textContent = Math.round(b.p * 100) + '%'; }

/* ---------------------------------------------------------------- settings screen */
function bindSeg(sel, attr, get, set) {
  const seg = $(sel);
  const render = () => { $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === get()))); syncSeg(seg); };
  $$('button', seg).forEach((b) => b.addEventListener('click', () => { buzz(); set(b.dataset[attr]); render(); }));
  render();
}
bindSeg('#theme-seg', 'themeSet', () => document.documentElement.dataset.theme, (v) => setTheme(v));
bindSeg('#model-seg', 'model', () => S.prefs.model, (v) => { S.prefs.model = v; savePrefs(); S.words = null; });
bindSeg('#lang-seg', 'lang', () => S.prefs.lang, (v) => { S.prefs.lang = v; savePrefs(); S.words = null; });
const FMT = [['mp3-128', 'MP3 128'], ['mp3-192', 'MP3 192'], ['mp3-320', 'MP3 320'], ['wav-16', 'WAV 16'], ['wav-24', 'WAV 24']];
function renderFmtDefault() { $('#fmt-default').innerHTML = FMT.map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${k === S.prefs.format}">${l}</button>`).join(''); }
$('#fmt-default').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (!c) return; buzz(); S.prefs.format = c.dataset.f; [exFmt, exQ] = S.prefs.format.split('-'); savePrefs(); renderFmtDefault(); });
renderFmtDefault();
$('#clear-cache').addEventListener('click', async () => {
  try { const keys = await caches.keys(); await Promise.all(keys.filter((k) => /transformers/i.test(k)).map((k) => caches.delete(k))); S.words = null; toast('Speech AI cache cleared.'); updateStorage(); }
  catch { toast('Nothing to clear.'); }
});
async function updateStorage() { try { const e = await navigator.storage?.estimate?.(); if (e) $('#storage-info').textContent = `Using ${fmtSize(e.usage || 0)} for offline files and AI models.`; } catch {} }
$('#version').textContent = 'v' + VERSION;
$('#theme-btn').addEventListener('click', () => { buzz(); setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); });

/* ---------------------------------------------------------------- coach mark */
function dismissCoach() { $('#coach').classList.add('hidden'); try { localStorage.setItem('sonvel.onboarded', '1'); } catch {} }
$('#coach-ok').addEventListener('click', (e) => { e.stopPropagation(); buzz(); dismissCoach(); });
$('#coach').addEventListener('click', (e) => e.stopPropagation());

/* ---------------------------------------------------------------- boot */
function boot() {
  meter = new Meter($('#meter'));
  setTheme(document.documentElement.dataset.theme || 'light', false);
  placePanel(); setState('empty'); recUI('idle'); renderBatch(); updateStorage();
  if (!localStorage.getItem('sonvel.onboarded')) setTimeout(() => $('#coach').classList.remove('hidden'), 500);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  document.fonts?.ready.then(syncAllSegs);
  window.__sonvel = { get rec() { return rec; }, S, runClean, loadAudio, D, setTheme, goTab, openSheet, closeSheets, finalAudio, setState, showResult, ensureWords };
}
boot();
