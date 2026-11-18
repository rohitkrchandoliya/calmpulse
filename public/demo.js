/**
 * Demo-mode simulated vitals for CalmPulse.
 *
 * Generates plausible, smoothly varying pulse / breathing signals with the
 * exact same sample shape the live SmartSpectra path produces, so the whole
 * UI — dashboard, waveform, calibration, adaptive breathing — can be
 * exercised without a camera or API key.
 *
 * This is a simulation for demonstration only. It is always labelled
 * "DEMO MODE" in the UI and never presented as a measurement.
 *
 * Sample shape (identical to server 'sample' events):
 *   { t, pulse, pulseConfidence, breathingRate, breathingConfidence,
 *     chestTrace, abdomenTrace, hrvRmssd }
 */

export class DemoVitals {
  constructor(onSample) {
    this.onSample = onSample;
    this.timer = null;
    this.startedAt = 0;
    this.breathPhase = 0; // radians
    this.guidePace = null; // when set, the simulated user "follows" the guide
    this.baseBreathing = 12.8; // breaths/min at rest
    this.basePulse = 67; // bpm at rest
  }

  start() {
    this.startedAt = performance.now();
    const tickMs = 50; // 20 Hz — smooth waveform
    this.timer = setInterval(() => this.#tick(tickMs / 1000), tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tell the simulation the guided pace, so it can drift toward it. */
  setGuidePace(breathsPerMin) {
    this.guidePace = breathsPerMin;
  }

  clearGuidePace() {
    this.guidePace = null;
  }

  #tick(dt) {
    const t = (performance.now() - this.startedAt) / 1000;

    // Breathing rate: slow wander + small noise; eases toward the guide
    // pace while a guided exercise runs (simulating a user following along).
    let target = this.baseBreathing + 1.1 * Math.sin(t / 47) + 0.5 * Math.sin(t / 13.7);
    if (this.guidePace != null) target = this.guidePace + 0.25 * Math.sin(t / 9);
    this._rate = this._rate == null ? target : this._rate + (target - this._rate) * 0.02;
    const breathingRate = this._rate + 0.15 * Math.sin(t * 1.7);

    // Advance the breathing phase at the current rate.
    this.breathPhase += (Math.PI * 2 * breathingRate / 60) * dt;
    // Shaped breath waveform: quicker rise (inhale), slower fall (exhale).
    const s = Math.sin(this.breathPhase);
    const trace = s + 0.18 * Math.sin(2 * this.breathPhase);

    // Pulse: gentle wander, slightly coupled to breathing (respiratory
    // sinus arrhythmia), slower when following a calm guide pace.
    let pulseTarget = this.basePulse + 5 * Math.sin(t / 61) + 2.2 * s;
    if (this.guidePace != null) pulseTarget -= 3.5;
    this._pulse = this._pulse == null ? pulseTarget : this._pulse + (pulseTarget - this._pulse) * 0.03;

    this.onSample({
      t: Date.now(),
      pulse: Math.round(this._pulse * 10) / 10,
      pulseConfidence: 0.86 + 0.08 * Math.sin(t / 23),
      breathingRate: Math.round(breathingRate * 10) / 10,
      breathingConfidence: 0.88 + 0.06 * Math.sin(t / 29),
      chestTrace: Math.round(trace * 1000) / 1000,
      abdomenTrace: Math.round(trace * 820) / 1000,
      hrvRmssd: Math.round((42 + 7 * Math.sin(t / 83)) * 10) / 10,
    });
  }
}
