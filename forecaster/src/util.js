'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`${new Date().toISOString()} [FORECASTER] ${msg}`);
}

// GET JSON con timeout y reintentos con espera creciente.
async function fetchJson(url) {
  const c = config();
  let lastErr;
  for (let i = 0; i <= c.HTTP_RETRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(c.HTTP_TIMEOUT_MS),
      });
      if (res.status === 404) { const e = new Error(`HTTP 404 ${url}`); e.status = 404; throw e; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.status === 404) break;
      if (i < c.HTTP_RETRIES) await sleep(c.RETRY_BASE_MS * 2 ** i);
    }
  }
  throw lastErr;
}

const file = (name) => path.join(config().DATA_DIR, name);

function appendJsonl(name, obj) {
  fs.mkdirSync(config().DATA_DIR, { recursive: true });
  fs.appendFileSync(file(name), JSON.stringify(obj) + '\n');
}

function readJsonl(name) {
  let txt;
  try { txt = fs.readFileSync(file(name), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* linea corrupta (corte a mitad de escritura): se ignora */ }
  }
  return out;
}

// Gamma devuelve varios campos como string JSON.
function parseField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);

module.exports = { sleep, log, fetchJson, appendJsonl, readJsonl, parseField, utcDate };
