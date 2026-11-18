# SmartSpectra SDK — Research Notes (Phase 1)

Researched 17 Nov 2026 for the DEV **Presage SmartSpectra SDK Challenge**
(runs 4–22 Nov 2026; submissions due **22 Nov 2026, 11:59 PM PST**; $3,000 across
10 winners; one entry per participant, 18+, no teams).

## Challenge requirements (from the official DEV challenge page)

Every submission must:

- Integrate the SmartSpectra SDK into a functional app and use **at least one
  live Presage signal** (pulse, breathing rate, HRV, expressions, ...).
- Include a **DEV post** (template provided by DEV, tag `#presagechallenge`),
  a **public code repository**, **setup instructions**, and a **demo video**
  (public hosting of the app itself is optional).
- **Explain camera consent and data handling**, disclosing any storage,
  sharing, retention, deletion, SDK telemetry, or optional AI service use.
- **Not allowed:** diagnosis or treatment claims, medical decision-making, or
  covert / non-consensual monitoring.
- Prize categories include **Best Thoughtful Real-World Use** — "strong
  usability, consent, and responsible data handling" — which CalmPulse targets.
- The challenge runs on Presage's **free trial**; no extra credits are
  provided. If trial limits are hit, Presage suggests their Discord.

## SDK platforms — there is NO browser/JavaScript Web SDK

| Platform | Form | Usable here? |
| --- | --- | --- |
| Android | Kotlin SDK | No (no Android toolchain/device) |
| iOS | Swift SDK (`SmartSpectra-Swift`) | No (no macOS/Xcode) |
| **Node.js / Electron** | npm package `@smartspectra/node-sdk` | **Yes — chosen route** |
| C++ | Native SDK for Win/macOS/Linux | Possible, but far slower to build with |

Key fact: SmartSpectra does **not** ship a pure web SDK that runs in a browser
tab. The JavaScript path is the **Node.js SDK**: a pure-FFI binding (via
`koffi`) over a prebuilt native runtime (`libsmartspectra_capi`), published as
per-platform npm packages (`@smartspectra/node-sdk-linux-x64`, etc.). No
`node-gyp`, no native addon compilation, no install scripts.

Docs: https://smartspectra.presagetech.com/docs/nodejs/ ·
API reference: https://smartspectra.presagetech.com/docs/nodejs/api-reference ·
Metrics guide: https://smartspectra.presagetech.com/docs/nodejs/metrics ·
GitHub org: https://github.com/Presage-Security (main repo: `SmartSpectra`)

## Chosen route: headless Node.js server + browser UI (no Electron)

The Node SDK supports three shapes:

1. **Electron** (`/main` + `/preload` + `/renderer` entry points) — desktop
   only, heavyweight, pointless in a headless Linux VM.
2. **Headless Node with a local camera** — `require('@smartspectra/node-sdk')`
   directly, `sdk.useCamera(CameraSelection.default)`, `sdk.start()`. The SDK
   opens the camera **in the server process** and emits metrics events.
3. **Headless Node with custom input** — `useCustomInput()` + `sendFrame()`,
   or `useFile(path)` to measure from a recorded video file.

CalmPulse uses **route 2**: a small Node server owns the SmartSpectra session
and streams decoded metrics to a polished browser UI over Server-Sent Events.
This is the same architecture already proven by another challenge entry
("Retro Techno Generator": Node server + WebSocket to a localhost page), minus
Electron and minus extra dependencies.

Why this is the fastest reliable route in this VM:

- VM has **Node v24.22.1** (SDK needs ≥ 20; 24 LTS recommended) and
  **glibc 2.39** (native runtime needs ≥ 2.35, built on Ubuntu 22.04). ✓
- `npm install @smartspectra/node-sdk` pulls prebuilt binaries — nothing to
  compile. (Note: it downloads the native runtime for *every* platform, a few
  hundred MB total; only the host's package is loaded at runtime.)
- No Electron download, no display server, no GUI needed to develop or test.
- The UI is still a normal web page (HTML/CSS/JS), so the deliverable reads
  and demos like a web app; the camera used is the webcam of the machine
  running the server (for the owner: his laptop, `http://localhost:4173`).

## API essentials (from the official docs)

```js
import {
  SmartSpectraSDK, CameraSelection,
  breathingMetrics, cardioMetrics, decodeMetrics,
} from '@smartspectra/node-sdk';

const sdk = new SmartSpectraSDK({
  apiKey: process.env.SMARTSPECTRA_API_KEY,
  requestedMetrics: [...breathingMetrics, ...cardioMetrics],
  enableTelemetry: false,          // opt out of session-summary telemetry
});

sdk.on('metrics', (buf, tsUs) => {
  const m = decodeMetrics(buf);
  const pulseBpm   = m.cardio?.pulseRate?.at(-1)?.value;     // beats / min
  const breathRate = m.breathing?.rate?.at(-1)?.value;       // breaths / min
  const chestTrace = m.breathing?.upperTrace?.at(-1)?.value; // waveform
  const abdomenTrace = m.breathing?.lowerTrace?.at(-1)?.value;
  const hrvRmssd   = m.cardio?.hrv?.at(-1)?.rmssd;           // ms
});
sdk.on('validationStatus', (code, tsUs, hint) => { /* user-facing hint */ });
sdk.on('processingStatus', (status) => { /* lifecycle */ });
sdk.on('error', (code, message, retryable) => { /* surface in UI */ });

sdk.useCamera(CameraSelection.default);   // or .byId(id) from
                                          // SmartSpectraSDK.availableCameras()
sdk.start();                              // capture begins
await sdk.stopAsync(); await sdk.destroy();
```

- Metric bundles: `breathingMetrics` = CHEST_BREATHING, ABDOMEN_BREATHING,
  BREATHING_RATE (the default). `cardioMetrics` = PULSE_RATE,
  ARTERIAL_PRESSURE_TRACE, HRV. Also `faceMetrics`, `edaMetrics`,
  `micromotionMetrics`. ⚠️ Five metrics are **Unavailable** (BREATHING_AMPLITUDE,
  APNEA, RESPIRATORY_LINE_LENGTH, BASELINE, INHALE_EXHALE_RATIO) — requesting
  any of them makes `start()` fail with `kConfigurationFailed`. We request
  breathing + cardio only.
- `SmartSpectraSDK.availableCameras()` — static, needs no auth; returns the
  cameras the SDK can see. Used by CalmPulse for its status endpoint.
- `checkDeviceReadiness()` — authenticated readiness check (available, unused
  by CalmPulse v1).
- Lifecycle methods throw JS `Error`s with numeric `code`, `message`,
  `retryable`. Native SDK state is process-global: destroy a session before
  constructing a replacement.
- Presage states all metric computation runs **on-device**; the SDK contacts
  Presage servers to **authenticate the API key / validate the subscription**
  (and to fetch processing models). The optional `requestInsight()` LLM
  feature would send derived vitals to Presage's AI Insights service —
  **CalmPulse never calls it.**
- **Telemetry:** `enableTelemetry` defaults to `true`. Per the API reference,
  telemetry sends session summaries / readiness reports; these "can contain
  free text, paths and platform context, and authenticated requests can
  correlate them with an account/device. No raw frames or measured vitals are
  sent." CalmPulse sets `enableTelemetry: false` and discloses this choice.
- Wellness scope (Presage's own wording): SDK metrics are "for general
  wellness and informational purposes only… not cleared by the FDA and may not
  be used for medical diagnosis or treatment." CalmPulse repeats this
  disclaimer in-app and in the submission draft.

## API key — owner-only registration (do NOT automate)

Registration page: https://physiology.presagetech.com/auth/register
(free; the challenge runs on the free trial).

The form asks for:

- First name \*, Last name \*
- Company, Job title, Phone number, University affiliation (optional fields)
- **Email address \***
- **Password \*** — at least 12 characters, with an uppercase letter, a
  lowercase letter, a number, and a symbol — plus **Confirm password \***
- Checkbox: agree to the **Terms of Service** \*
- Checkbox: agree to the **Privacy Policy** \*

After registering: log in at the same portal (physiology.presagetech.com),
open the API key / developer section, and copy the API key. If the portal
sends a verification email, confirm it before logging in. Then:

```bash
cd ~/workspace/presage-challenge
cp .env.example .env   # paste the key after SMARTSPECTRA_API_KEY=
npm start
```

Estimated owner time: ~3 minutes. The key must never be committed to git
(`.env` is git-ignored; the browser UI never sees the key — it stays in the
server process).

## VM feasibility verdict

| Check | Result |
| --- | --- |
| Node ≥ 20 | ✓ v24.22.1 |
| glibc ≥ 2.35 | ✓ 2.39 (Ubuntu) |
| npm install of SDK | ✓ (see build log; package + linux-x64 runtime install cleanly) |
| SDK loads / native shim resolves | ✓ verified by smoke test |
| Camera in this VM | ✗ none (`/dev/video*` absent) — expected; live capture is an owner-machine step |
| API key | ✓ obtained 17 Nov 2026 (free tier, active) — live measurement verified on the owner's laptop 18 Nov 2026 |

Everything except (camera + key) is buildable and testable in this VM. The app
therefore ships with a clearly labelled demo mode so the full UX — consent
flow, live dashboard, adaptive breathing — can be exercised and recorded
before the owner ever adds a key.
