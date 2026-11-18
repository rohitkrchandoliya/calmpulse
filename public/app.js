/**
 * CalmPulse UI controller.
 *
 * Flow: consent view -> (live SmartSpectra session | demo mode) -> dashboard
 * + adaptive guided breathing. Both modes feed the SAME sample handler, so
 * every visual behaves identically; only the source differs, and demo mode
 * is permanently labelled in the UI.
 */

import { DemoVitals } from './demo.js';
import { BreathingGuide, paceFromMeasurement, median } from './breathing.js';

const $ = (id) => document.getElementById(id);

const els = {
  consentView: $('consent-view'),
  mainView: $('main-view'),
  modeBadge: $('mode-badge'),
  consentCheckbox: $('consent-checkbox'),
  startLiveBtn: $('start-live-btn'),
  startDemoBtn: $('start-demo-btn'),
  readySdk: $('ready-sdk').querySelector('span'),
  readyKey: $('ready-key').querySelector('span'),
  readyCamera: $('ready-camera').querySelector('span'),
  readinessNote: $('readiness-note'),
  demoBanner: $('demo-banner'),
  sessionStatus: $('session-status'),
  stopBtn: $('stop-btn'),
  exitDemoBtn: $('exit-demo-btn'),
  pulseValue: $('pulse-value'),
  pulseSub: $('pulse-sub'),
  breathValue: $('breath-value'),
  breathSub: $('breath-sub'),
  hrvValue: $('hrv-value'),
  hintLine: $('hint-line'),
  waveform: $('waveform'),
  breathCircle: $('breath-circle'),
  breathPhase: $('breath-phase'),
  guidePaceLabel: $('guide-pace-label'),
  yourPaceLabel: $('your-pace-label'),
  breathCount: $('breath-count'),
  timeRemaining: $('time-remaining'),
  durationSelect: $('duration-select'),
  paceSlider: $('pace-slider'),
  paceSliderLabel: $('pace-slider-label'),
  calibrateBtn: $('calibrate-btn'),
  guideStartBtn: $('guide-start-btn'),
  guidePauseBtn: $('guide-pause-btn'),
  guideStopBtn: $('guide-stop-btn'),
  calibrationStatus: $('calibration-status'),
};

const state = {
  mode: 'none', // 'live' | 'demo'
  status: null,
  eventSource: null,
  demo: null,
  guide: new BreathingGuide(),
  latest: null,
  calibration: null, // { samples: number[], endsAt: number }
  traceBuffer: [], // { t, v }
};

const CALIBRATION_SECONDS = 20;
const TRACE_WINDOW_MS = 12000;

/* ---------------- setup / consent ---------------- */

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    state.status = await res.json();
  } catch {
    state.status = null;
  }
  const s = state.status;
  if (!s) {
    els.readySdk.textContent = 'server unreachable';
    els.readyKey.textContent = 'unknown';
    els.readyCamera.textContent = 'unknown';
    els.modeBadge.textContent = 'Server unreachable';
    return;
  }
  els.readySdk.textContent = s.sdkLoaded
    ? `loaded (v${s.sdkVersion ?? '?'})`
    : 'not available on this machine';
  els.readyKey.textContent = s.hasApiKey
    ? 'configured on the server'
    : 'not configured — add SMARTSPECTRA_API_KEY to .env';
  els.readyCamera.textContent =
    s.cameras.length > 0
      ? `${s.cameras.length} found`
      : 'none found on this device';
  els.readinessNote.textContent = s.liveReady
    ? 'Live measurement is ready. The camera stays off until you consent and press Start.'
    : 'Live measurement is not available right now (' +
      s.reasons.join(', ').replaceAll('_', ' ') +
      '). Demo mode below works everywhere.';
  els.modeBadge.textContent = s.liveReady ? 'Live ready' : 'Demo available';
  updateStartButton();
}

function updateStartButton() {
  const consented = els.consentCheckbox.checked;
  els.startLiveBtn.disabled = !(consented && state.status?.liveReady);
}

els.consentCheckbox.addEventListener('change', updateStartButton);

/* ---------------- session control ---------------- */

function showMain(mode) {
  state.mode = mode;
  els.consentView.hidden = true;
  els.mainView.hidden = false;
  const isDemo = mode === 'demo';
  els.demoBanner.hidden = !isDemo;
  els.stopBtn.hidden = isDemo;
  els.exitDemoBtn.hidden = !isDemo;
  els.modeBadge.textContent = isDemo ? 'DEMO MODE' : 'LIVE — SmartSpectra';
  els.modeBadge.className = 'badge ' + (isDemo ? 'badge-demo' : 'badge-live');
  els.sessionStatus.textContent = isDemo
    ? 'Session: demo (simulated signals)'
    : 'Session: live measurement running';
}

function showConsent() {
  state.mode = 'none';
  els.mainView.hidden = true;
  els.consentView.hidden = false;
  els.modeBadge.className = 'badge badge-idle';
  resetDashboard();
  refreshStatus();
}

function resetDashboard() {
  state.latest = null;
  state.traceBuffer = [];
  state.calibration = null;
  els.pulseValue.textContent = '––';
  els.breathValue.textContent = '––';
  els.hrvValue.textContent = '––';
  els.pulseSub.textContent = 'Waiting for signal…';
  els.breathSub.textContent = 'Waiting for signal…';
  els.hintLine.textContent = '';
  els.calibrationStatus.textContent = '';
  stopGuide();
}

els.startLiveBtn.addEventListener('click', async () => {
  els.startLiveBtn.disabled = true;
  try {
    const res = await fetch('/api/session/start', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not start the session.');
    openStream();
    showMain('live');
  } catch (err) {
    els.readinessNote.textContent = `Could not start live measurement: ${err.message} You can still use demo mode.`;
    updateStartButton();
  }
});

els.startDemoBtn.addEventListener('click', () => {
  state.demo = new DemoVitals(handleSample);
  state.demo.start();
  showMain('demo');
});

els.stopBtn.addEventListener('click', async () => {
  closeStream();
  await fetch('/api/session/stop', { method: 'POST' }).catch(() => {});
  showConsent();
});

els.exitDemoBtn.addEventListener('click', () => {
  state.demo?.stop();
  state.demo = null;
  showConsent();
});

function openStream() {
  closeStream();
  const es = new EventSource('/api/stream');
  state.eventSource = es;
  es.addEventListener('sample', (e) => handleSample(JSON.parse(e.data)));
  es.addEventListener('hint', (e) => {
    const { hint } = JSON.parse(e.data);
    if (hint) els.hintLine.textContent = hint;
  });
  es.addEventListener('sessionError', (e) => {
    const err = JSON.parse(e.data);
    els.hintLine.textContent = `Measurement problem: ${err.message} You can stop and switch to demo mode.`;
    els.sessionStatus.textContent = 'Session: error';
  });
  es.addEventListener('sessionState', (e) => {
    const { state: s } = JSON.parse(e.data);
    els.sessionStatus.textContent = `Session: ${s}`;
  });
}

function closeStream() {
  state.eventSource?.close();
  state.eventSource = null;
}

/* ---------------- samples ---------------- */

function handleSample(sample) {
  state.latest = sample;
  const traceValue = sample.chestTrace ?? sample.abdomenTrace;
  if (traceValue != null) {
    state.traceBuffer.push({ t: sample.t, v: traceValue });
    const cutoff = sample.t - TRACE_WINDOW_MS - 1000;
    while (state.traceBuffer.length && state.traceBuffer[0].t < cutoff) {
      state.traceBuffer.shift();
    }
  }
  if (state.calibration && sample.breathingRate != null) {
    state.calibration.samples.push(sample.breathingRate);
  }
  updateMetricCards(sample);
}

let lastCardUpdate = 0;
// The SDK reports confidence on a 0-100 scale; accept a 0-1 fraction too
// and always clamp into range before displaying a percentage.
function confidencePct(v) {
  if (v == null) return null;
  const pct = v > 1 ? v : v * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
function updateMetricCards(sample) {
  const now = performance.now();
  if (now - lastCardUpdate < 200) return; // 5 Hz is plenty for numbers
  lastCardUpdate = now;
  if (sample.pulse != null) {
    els.pulseValue.textContent = Math.round(sample.pulse);
    els.pulseSub.textContent =
      sample.pulseConfidence != null
        ? `Signal confidence ${confidencePct(sample.pulseConfidence)}%`
        : 'Live estimate';
  }
  if (sample.breathingRate != null) {
    els.breathValue.textContent = Math.round(sample.breathingRate * 10) / 10;
    els.breathSub.textContent =
      sample.breathingConfidence != null
        ? `Signal confidence ${confidencePct(sample.breathingConfidence)}%`
        : 'Live estimate';
    els.yourPaceLabel.textContent = `${(Math.round(sample.breathingRate * 10) / 10).toFixed(1)} br/min`;
  }
  if (sample.hrvRmssd != null) {
    els.hrvValue.textContent = Math.round(sample.hrvRmssd);
  }
}

/* ---------------- waveform ---------------- */

const ctx = els.waveform.getContext('2d');

function drawWaveform() {
  const canvas = els.waveform;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  // Baseline grid
  ctx.strokeStyle = '#e3e8e4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const buf = state.traceBuffer;
  if (buf.length < 2) {
    ctx.fillStyle = '#8aa298';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText('Waiting for breathing signal…', 16, height / 2 - 10);
    return;
  }
  const now = buf[buf.length - 1].t;
  const points = buf.filter((p) => now - p.t <= TRACE_WINDOW_MS);
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (max - min < 0.2) {
    max += 0.1;
    min -= 0.1;
  }
  const pad = (max - min) * 0.15;
  max += pad;
  min -= pad;

  ctx.strokeStyle = '#1f7a5f';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const p of points) {
    const x = width - ((now - p.t) / TRACE_WINDOW_MS) * width;
    const y = height - ((p.v - min) / (max - min)) * height;
    if (p === points[0]) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* ---------------- guided breathing ---------------- */

function startGuide(pace) {
  const guide = state.guide;
  guide.setPace(pace);
  guide.start(Number(els.durationSelect.value));
  guide.onFinish = () => {
    els.calibrationStatus.textContent =
      'Exercise complete. Well done — notice how your body feels before you move on.';
    state.demo?.clearGuidePace();
    syncGuideButtons();
  };
  state.demo?.setGuidePace(guide.pace);
  els.guidePaceLabel.textContent = `${guide.pace.toFixed(1)} br/min`;
  els.calibrationStatus.textContent = 'Guided breathing in progress. Follow the circle.';
  syncGuideButtons();
}

function stopGuide() {
  state.guide.stop();
  state.demo?.clearGuidePace();
  els.breathPhase.textContent = 'Ready';
  els.breathCircle.style.transform = 'scale(0.78)';
  syncGuideButtons();
}

function syncGuideButtons() {
  const running = state.guide.running;
  els.guidePauseBtn.disabled = !running;
  els.guideStopBtn.disabled = !running;
  els.guidePauseBtn.textContent = state.guide.paused ? 'Resume' : 'Pause';
}

els.paceSlider.addEventListener('input', () => {
  els.paceSliderLabel.textContent = Number(els.paceSlider.value).toFixed(1);
});

els.guideStartBtn.addEventListener('click', () => {
  startGuide(Number(els.paceSlider.value));
});

els.calibrateBtn.addEventListener('click', () => {
  if (state.mode === 'none') return;
  state.calibration = { samples: [], endsAt: Date.now() + CALIBRATION_SECONDS * 1000 };
  els.calibrationStatus.textContent =
    `Measuring your natural breathing for ${CALIBRATION_SECONDS} seconds — sit comfortably and breathe normally…`;
  els.calibrateBtn.disabled = true;
});

els.guidePauseBtn.addEventListener('click', () => {
  if (state.guide.paused) state.guide.resume();
  else state.guide.pause();
  syncGuideButtons();
});

els.guideStopBtn.addEventListener('click', () => {
  stopGuide();
  els.calibrationStatus.textContent = 'Exercise ended.';
});

function tickCalibration() {
  const cal = state.calibration;
  if (!cal) return;
  const remaining = Math.ceil((cal.endsAt - Date.now()) / 1000);
  if (remaining > 0) {
    els.calibrationStatus.textContent =
      `Measuring your natural breathing — ${remaining}s left (${cal.samples.length} readings)…`;
    return;
  }
  state.calibration = null;
  els.calibrateBtn.disabled = false;
  const baseline = median(cal.samples);
  if (baseline == null || cal.samples.length < 5) {
    els.calibrationStatus.textContent =
      'Not enough clean readings to measure your pace. Check the hint above, sit still, and try again — or begin at the slider pace.';
    return;
  }
  const pace = paceFromMeasurement(baseline);
  els.calibrationStatus.textContent =
    `Your natural pace is about ${baseline.toFixed(1)} breaths/min. Guiding you at ${pace.toFixed(1)} — a little slower.`;
  startGuide(pace);
}

/* ---------------- render loop ---------------- */

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderLoop() {
  drawWaveform();
  tickCalibration();
  const g = state.guide.getState();
  if (g.running || g.phase === 'done') {
    els.breathCircle.style.transform = `scale(${g.scale.toFixed(3)})`;
    els.breathPhase.textContent = g.phaseLabel;
    els.breathCount.textContent = g.breathsCompleted;
    els.timeRemaining.textContent = formatTime(g.remainingSec);
    if (g.phase === 'done') syncGuideButtons();
  }
  requestAnimationFrame(renderLoop);
}

refreshStatus();
requestAnimationFrame(renderLoop);
