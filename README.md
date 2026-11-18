# CalmPulse — Breathe With Your Own Rhythm

A **consent-first breathing & relaxation companion** powered by the
**Presage SmartSpectra SDK**. CalmPulse measures your pulse and breathing
rate from your webcam, shows them live, and then guides a breathing exercise
whose pace is **adapted to your own measured breathing** — a little slower
than your natural rhythm, the way a good instructor would.

Built for the DEV **Presage SmartSpectra SDK Challenge** (`#presagechallenge`),
targeting the *Best Thoughtful Real-World Use* category: a clear real-world
need (a calmer two-to-ten minutes, on demand) with consent and responsible
data handling designed in from the first screen, not bolted on.

> **Wellness only.** CalmPulse is a relaxation aid, not a medical device. It
does not diagnose, treat, or monitor any condition. SmartSpectra metrics
are estimates for general wellness and informational purposes.

---

## How it works

```
┌──────────────┐   webcam    ┌──────────────────────────────┐
│  Your webcam │ ──────────▶ │ Node server (this computer)  │
└──────────────┘             │  @smartspectra/node-sdk      │
                             │  → pulse, breathing, HRV     │
                             └──────────────┬───────────────┘
                                            │ decoded metrics only
                                            │ (Server-Sent Events)
                             ┌──────────────▼───────────────┐
                             │ Browser UI (localhost)       │
                             │ live dashboard + waveform +  │
                             │ adaptive guided breathing    │
                             └──────────────────────────────┘
```

SmartSpectra has no in-browser SDK; its JavaScript path is a Node.js binding
over a prebuilt native runtime. CalmPulse therefore runs the SDK in a small
local Node server (headless mode, `useCamera`) and streams **decoded metric
values** — never video — to the page. See `SDK-NOTES.md` for the full
research trail.

**Adaptive pacing:** press “Measure my pace & begin” and CalmPulse collects
your breathing rate for ~20 seconds, takes the median as your baseline, and
guides you at 85% of that pace (clamped to 4.5–9 breaths/min, inhale 45% /
exhale 55%). A manual pace slider (4–10 br/min) is always available.

## Quick start

**Requirements**

- Node.js ≥ 20 (Node 24 LTS recommended), Linux x64/ARM64, macOS Apple
  Silicon, or Windows x64
- A webcam
- A free SmartSpectra API key (below)
- Internet access at runtime (the SDK authenticates the key with Presage)

**1. Get an API key (free, ~3 minutes, one-time)**

1. Go to <https://physiology.presagetech.com/auth/register>
2. Fill in first name, last name, and email (company / job title / phone /
   university are optional), choose a password (≥ 12 characters with upper,
   lower, number, and symbol), and agree to the Terms of Service and Privacy
   Policy.
3. Log in at the same portal and copy your API key from the developer/API
   key section. (If a verification email arrives, confirm it first.)
   The challenge runs on Presage's free trial.

**2. Run CalmPulse**

```bash
git clone <this-repo> calmpulse
cd calmpulse
npm install          # downloads the SDK's prebuilt native runtime (~380 MB)
cp .env.example .env # paste your key after SMARTSPECTRA_API_KEY=
npm start            # → http://localhost:4173
```

Open <http://localhost:4173>, read the consent screen, tick the consent box,
and press **Start with camera**.

**No key or no camera?** The consent screen shows exactly what is missing,
and **demo mode** runs the complete experience — dashboard, waveform,
calibration, adaptive pacing — on clearly labelled simulated signals.

## Consent & data handling (summary)

- The camera is opened **only** after explicit in-app consent, per session,
  by the local server process. Nothing runs before that or in the background.
- Video frames are processed **on this device** by the SDK and exist only in
  memory during measurement. CalmPulse **never records, saves, or uploads
  video**, and it does not store readings; closing the tab or pressing
  










































“Stop camera” ends measurement and releases the camera.
- The SDK contacts Presage servers only to **authenticate the API key and
  validate the subscription** (and fetch processing models).
- **SDK telemetry is disabled** in CalmPulse (`enableTelemetry: false`).
  Presage documents telemetry as aggregate session summaries that can
  contain free text, paths, and platform context — we opt out.
- The optional **AI Insights** feature is never called, so no vitals are sent
  for LLM analysis.
- The API key lives only in the server process (`.env`, git-ignored). The
  browser never sees it.

The same disclosure, in full, appears in the DEV submission post for the
challenge.












## Project structure

```
server/
  index.mjs    HTTP server: static UI, /api/status, session start/stop, SSE
  vitals.mjs   The only file that talks to the SmartSpectra SDK
public/
  index.html   Consent gate + dashboard + guided breathing UI
  styles.css   Calm, low-stimulation design; no external assets
  app.js       UI controller; live and demo samples share one code path
  breathing.js Adaptive pacing math + guided-breathing engine
  demo.js      Clearly labelled simulated signal generator
SDK-NOTES.md   SDK research: platforms, API, registration, feasibility
```

## Development checks

```bash
npm run check   # syntax-check all JavaScript
npm start       # then open http://localhost:4173
```

Verified in a headless Linux VM (Node 24, glibc 2.39): SDK v3.5.0 installs
and loads natively; environment probe, status API, session endpoints, SSE
stream, and the full demo-mode flow all work. Live camera measurement
requires a machine with a webcam and an API key (see Quick start).

## License

CalmPulse's own code is MIT. The SmartSpectra SDK is Presage Technologies'
software, used under their terms via the official npm package
`@smartspectra/node-sdk`.




















