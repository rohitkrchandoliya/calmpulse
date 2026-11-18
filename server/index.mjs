/**
 * CalmPulse local server.
 *
 * Serves the web UI from ../public and owns the SmartSpectra session
 * (see vitals.mjs). The browser never talks to the SDK and never sees the
 * API key; it only receives decoded metric values over Server-Sent Events.
 *
 * Routes:
 *   GET  /api/status         environment + session readiness (no secrets)
 *   POST /api/session/start  start live measurement (needs consent in UI)
 *   POST /api/session/stop   stop measurement and release the camera
 *   GET  /api/stream         SSE stream: hello / sample / hint / status /
 *                            sessionError / sessionState
 *   GET  /*                  static files from ../public
 *
 * The API key is read from the SMARTSPECTRA_API_KEY environment variable
 * (or a local .env file). It is used only inside this process.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEnvironment, VitalsSession } from './vitals.mjs';

try {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
} catch {
  // No .env file — environment variables alone are fine.
}

const PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public'
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};








































let session = null;
let latestSample = null;
let sampleDirty = false;
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Forward samples at most every 100 ms so the UI stays smooth without
// flooding the browser with one event per SDK packet.
setInterval(() => {
  if (sampleDirty && latestSample) {
    sampleDirty = false;
    broadcast('sample', latestSample);
  }
}, 100);

async function getStatus() {
  const probe = await probeEnvironment();
  const hasApiKey = Boolean(process.env.SMARTSPECTRA_API_KEY);
  const reasons = [];
  if (!probe.sdkLoaded) reasons.push('sdk_unavailable');
  if (!hasApiKey) reasons.push('no_api_key');
  if (probe.sdkLoaded && probe.cameras.length === 0) reasons.push('no_camera');
  return {
    sdkLoaded: probe.sdkLoaded,
    sdkVersion: probe.sdkVersion,
    hasApiKey,
    cameras: probe.cameras,
    probeError: probe.error,
    liveReady: reasons.length === 0,
    reasons,
    sessionState: session ? session.state : 'idle',
  };
}

function wireSession(sess) {
  sess.on('sample', (sample) => {
    latestSample = sample;
    sampleDirty = true;
  });
  sess.on('hint', (hint) => broadcast('hint', hint));
  sess.on('status', (status) => broadcast('status', { status }));
  sess.on('sessionError', (err) => {
    broadcast('sessionError', {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
    });
    broadcast('sessionState', { state: 'error' });
  });
}





















































async function handleStart(res) {
  if (!process.env.SMARTSPECTRA_API_KEY) {
    return sendJson(res, 400, {
      error: {
        code: 'NO_API_KEY',
        message:
          'No SmartSpectra API key is configured on the server. Add SMARTSPECTRA_API_KEY to .env and restart, or use demo mode.',
      },
    });
  }
  if (session && (session.state === 'running' || session.state === 'starting')) {
    return sendJson(res, 200, { state: session.state });
  }
  session = new VitalsSession(process.env.SMARTSPECTRA_API_KEY);
  wireSession(session);
  try {
    await session.start();
    broadcast('sessionState', { state: session.state });
    return sendJson(res, 200, { state: session.state });
  } catch (err) {
    broadcast('sessionState', { state: 'error' });
    return sendJson(res, 500, {
      error: { code: err.code, message: err.message, retryable: err.retryable },
    });
  }
}

async function handleStop(res) {
  if (session) {
    const old = session;
    session = null;
    latestSample = null;
    await old.stop();
  }
  broadcast('sessionState', { state: 'idle' });
  return sendJson(res, 200, { state: 'idle' });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}





























































const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, await getStatus());
    }
    if (url.pathname === '/api/session/start' && req.method === 'POST') {
      return await handleStart(res);
    }
    if (url.pathname === '/api/session/stop' && req.method === 'POST') {
      return await handleStop(res);
    }
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(
        `event: hello\ndata: ${JSON.stringify({
          sessionState: session ? session.state : 'idle',
        })}\n\n`
      );
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    sendJson(res, 500, { error: { code: 'INTERNAL', message: err.message } });
  }
});

server.listen(PORT, () => {
  console.log(`CalmPulse is running at http://localhost:${PORT}`);
  console.log(
    process.env.SMARTSPECTRA_API_KEY
      ? 'SmartSpectra API key: configured (live mode available)'
      : 'SmartSpectra API key: NOT set — live mode disabled, demo mode available'
  );
});

async function shutdown() {
  if (session) await session.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

























































