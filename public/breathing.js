/**
 * Guided breathing engine for CalmPulse.
 *
 * Runs a session at a configurable pace (breaths per minute). Each cycle is
 * split into an inhale phase (45% of the cycle) and an exhale phase (55%) —
 * a longer exhale is the common relaxation pattern. The engine is purely
 * time-based and rendering-agnostic: the UI polls `getState()` from a
 * requestAnimationFrame loop and draws the circle.
 *
 * Adaptation: `paceFromMeasurement(measuredRate)` converts a user's measured
 * resting breathing rate into a guide pace that is ~15% slower, clamped to a
 * calm, safe range. This is the function that makes the exercise "adaptive"
 * to the live SmartSpectra signal.
 */

export const MIN_PACE = 4; // breaths per minute
export const MAX_PACE = 10;

export function clampPace(pace) {
  return Math.min(MAX_PACE, Math.max(MIN_PACE, pace));
}

/**
 * Guide pace for a measured resting rate: 15% slower than the user's own
 * pace, clamped to [4.5, 9] br/min and rounded to one decimal.
 */
export function paceFromMeasurement(measuredRate) {
  if (!measuredRate || !Number.isFinite(measuredRate)) return 5.5;
  const target = measuredRate * 0.85;
  const clamped = Math.min(9, Math.max(4.5, target));
  return Math.round(clamped * 10) / 10;
}

/** Median of a numeric array (robust baseline for calibration). */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const INHALE_FRACTION = 0.45;

export class BreathingGuide {
  constructor() {
    this.pace = 5.5; // breaths per minute
    this.running = false;
    this.paused = false;
    this.startedAt = 0;
    this.pausedTotalMs = 0;
    this.pauseStartedAt = 0;
    this.durationSec = 300;
    this.onFinish = null; // optional callback
  }

  setPace(breathsPerMin) {
    this.pace = clampPace(breathsPerMin);
  }

  start(durationSec) {
    this.durationSec = durationSec;
    this.running = true;
    this.paused = false;
    this.startedAt = performance.now();
    this.pausedTotalMs = 0;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.pauseStartedAt = performance.now();
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.pausedTotalMs += performance.now() - this.pauseStartedAt;
    this.paused = false;
  }

  stop() {
    this.running = false;
    this.paused = false;
  }

  #elapsedMs(now) {
    let paused = this.pausedTotalMs;
    if (this.paused) paused += now - this.pauseStartedAt;
    return now - this.startedAt - paused;
  }

  /**
   * Current animation state.
   * Returns { running, paused, phase: 'inhale'|'exhale'|'done',
   *           phaseLabel, scale (0.72..1 circle scale), breathsCompleted,
   *           remainingSec, cycleProgress }
   */
  getState(now = performance.now()) {
    if (!this.running) {
      return {
        running: false, paused: false, phase: 'idle', phaseLabel: 'Ready',
        scale: 0.78, breathsCompleted: 0,
        remainingSec: this.durationSec, cycleProgress: 0,
      };
    }
    const elapsedSec = this.#elapsedMs(now) / 1000;
    const remainingSec = Math.max(0, this.durationSec - elapsedSec);
    if (remainingSec <= 0) {
      this.running = false;
      if (this.onFinish) this.onFinish();
      return {
        running: false, paused: this.paused, phase: 'done', phaseLabel: 'Complete',
        scale: 0.78, breathsCompleted: Math.floor(elapsedSec / (60 / this.pace)),
        remainingSec: 0, cycleProgress: 0,
      };
    }
    const cycleSec = 60 / this.pace;
    const cycleProgress = (elapsedSec % cycleSec) / cycleSec;
    const breathsCompleted = Math.floor(elapsedSec / cycleSec);
    const inhale = cycleProgress < INHALE_FRACTION;
    // Smooth ease in/out within each phase.
    let scale;
    if (inhale) {
      const p = cycleProgress / INHALE_FRACTION;
      scale = 0.72 + 0.28 * easeInOut(p);
    } else {
      const p = (cycleProgress - INHALE_FRACTION) / (1 - INHALE_FRACTION);
      scale = 1 - 0.28 * easeInOut(p);
    }
    return {
      running: true,
      paused: this.paused,
      phase: inhale ? 'inhale' : 'exhale',
      phaseLabel: this.paused ? 'Paused' : inhale ? 'Breathe in…' : 'Breathe out…',
      scale,
      breathsCompleted,
      remainingSec: Math.ceil(remainingSec),
      cycleProgress,
    };
  }
}

function easeInOut(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
