/**
 * SmartSpectra session management for CalmPulse.
 *
 * This module is the ONLY place that talks to the Presage SmartSpectra SDK
 * (`@smartspectra/node-sdk`). It loads the SDK lazily (dynamic import), probes
 * the environment (SDK present? cameras present?), and owns at most one
 * measurement session at a time — the native SDK keeps process-global state,
 * so a session must be destroyed before a replacement is constructed.
 *
 * Privacy choices made here:
 *  - `enableTelemetry: false` — opts out of the SDK's session-summary
 *    telemetry (which can contain free text, paths and platform context).
 *  - The optional LLM "insight" feature is never called, so no derived
 *    vitals are sent to Presage's AI Insights service.
 *  - Only decoded metric values leave this module. Video frames never do:
 *    capture and processing happen inside the SDK on this machine.
 */

import { EventEmitter } from 'node:events';

let sdkModulePromise = null;

function loadSdk() {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@smartspectra/node-sdk').catch((err) => {
      sdkModulePromise = null; // allow a later retry
      throw err;
    });
  }
  return sdkModulePromise;
}

function toFiniteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lastOf(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : undefined;
}

function normalizeError(err, fallbackCode) {
  const error = new Error(err?.message || 'Unknown SmartSpectra error');
  error.code = typeof err?.code === 'number' || typeof err?.code === 'string'
    ? err.code
    : fallbackCode;
  error.retryable = Boolean(err?.retryable);
  return error;
}

/**
 * Probe the environment without starting a measurement.
 * Returns { sdkLoaded, sdkVersion, cameras: [{id, name, facing}], error }.
 * `availableCameras()` is a static SDK call that needs no authentication.
 */
export async function probeEnvironment() {
  const probe = { sdkLoaded: false, sdkVersion: null, cameras: [], error: null };
  try {
    const mod = await loadSdk();
    probe.sdkLoaded = true;
    probe.sdkVersion = mod.SmartSpectraSDK.version ?? null;
    try {
      probe.cameras = mod.SmartSpectraSDK.availableCameras().map((cam) => ({
        id: cam?.id ?? null,
        name: cam?.name ?? null,
        facing: cam?.facing ?? null,
      }));
    } catch (err) {
      probe.error = `Camera discovery failed: ${err.message}`;
    }
  } catch (err) {
    probe.error = `SmartSpectra SDK failed to load: ${err.message}`;
  }
  return probe;
}

/**
 * One live measurement session.
 *
 * Events:
 *  - 'sample'  ({ t, pulse, pulseConfidence, breathingRate,
 *                breathingConfidence, chestTrace, abdomenTrace, hrvRmssd })
 *  - 'hint'    ({ code, hint })   — SDK validation guidance for the user
 *  - 'status'  (statusValue)      — SDK processing lifecycle value
 *  - 'sessionError' (Error with .code / .retryable)
 */
export class VitalsSession extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey;
    this.sdk = null;
    this.state = 'idle'; // idle | starting | running | stopping | error
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';

    let mod;
    try {
      mod = await loadSdk();
    } catch (err) {
      this.state = 'error';
      throw normalizeError(err, 'SDK_LOAD_FAILED');
    }

    let cameras = [];
    try {
      cameras = mod.SmartSpectraSDK.availableCameras();
    } catch {
      cameras = [];
    }
    if (cameras.length === 0) {
      this.state = 'error';
      const err = new Error(
        'No camera was found on this device. SmartSpectra needs a webcam to measure.'
      );
      err.code = 'NO_CAMERA';
      err.retryable = false;
      throw err;
    }

    const sdk = new mod.SmartSpectraSDK({
      apiKey: this.apiKey,
      requestedMetrics: [...mod.breathingMetrics, ...mod.cardioMetrics],
      enableTelemetry: false,
      logLevel: mod.SmartSpectraLogLevel?.kWarning,
    });
    this.sdk = sdk;

    sdk.on('metrics', (buf) => {
      let metrics;
      try {
        metrics = mod.decodeMetrics(buf);
      } catch {
        return; // ignore undecodable packets
      }
      if (!metrics || Buffer.isBuffer(metrics)) return;
      const breathing = metrics.breathing;
      const cardio = metrics.cardio;
      this.emit('sample', {
        t: Date.now(),
        pulse: toFiniteOrNull(lastOf(cardio?.pulseRate)?.value),
        pulseConfidence: toFiniteOrNull(lastOf(cardio?.pulseRate)?.confidence),
        breathingRate: toFiniteOrNull(lastOf(breathing?.rate)?.value),
        breathingConfidence: toFiniteOrNull(lastOf(breathing?.rate)?.confidence),
        chestTrace: toFiniteOrNull(lastOf(breathing?.upperTrace)?.value),
        abdomenTrace: toFiniteOrNull(lastOf(breathing?.lowerTrace)?.value),
        hrvRmssd: toFiniteOrNull(lastOf(cardio?.hrv)?.rmssd),
      });
    });

    sdk.on('validationStatus', (code, _timestampUs, hint) => {
      if (hint) this.emit('hint', { code, hint });
    });

    sdk.on('processingStatus', (status) => {
      this.emit('status', status);
    });

    sdk.on('error', (code, message, retryable) => {
      this.state = 'error';
      const err = new Error(message || 'SmartSpectra session error');
      err.code = code;
      err.retryable = Boolean(retryable);
      this.emit('sessionError', err);
    });

    try {
      // Prefer an explicitly discovered camera; fall back to SDK default.
      if (cameras[0]?.id != null) {
        sdk.useCamera(mod.CameraSelection.byId(cameras[0].id), {
          width: 1280,
          height: 720,
        });
      } else {
        sdk.useCamera(mod.CameraSelection.default);
      }
      sdk.start();
    } catch (err) {
      this.state = 'error';
      await this.#teardown();
      throw normalizeError(err, 'START_FAILED');
    }

    this.state = 'running';
  }

  async #teardown() {
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) {
      try {
        await sdk.destroy();
      } catch {
        // Teardown is best-effort; the native side is idempotent.
      }
    }
  }

  async stop() {
    if (!this.sdk) {
      this.state = 'idle';
      return;
    }
    this.state = 'stopping';
    try {
      await this.sdk.stopAsync();
    } catch {
      // Ignore stop failures; destroy below still releases the camera.
    }
    await this.#teardown();
    this.state = 'idle';
  }
}
