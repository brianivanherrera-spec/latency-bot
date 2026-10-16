'use strict';
const http = require('http');
const crypto = require('crypto');
const { config } = require('./config');
const { log } = require('./util');
const pipeline = require('./pipeline');
const { computeReport } = require('./metrics');

const status = { started: new Date().toISOString(), lastSelection: null, lastHourly: null, lastError: null };

function authorized(url) {
  const secret = config().DOWNLOAD_SECRET;
  if (!secret) return null; // 503
  const key = url.searchParams.get('key') || '';
  const a = crypto.createHash('sha256').update(key).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

function handler(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(200, { ok: true, ...status });
    const auth = authorized(url);
    if (auth === null) return send(503, { error: 'DOWNLOAD_SECRET no configurado' });
    if (!auth) return send(401, { error: 'clave invalida' });
    if (url.pathname === '/candidates') return send(200, pipeline.publishedCandidates(url.searchParams.get('date')));
    const st = pipeline.loadState();
    if (url.pathname === '/forecasts') return send(200, { forecasts: st.forecasts, decisions: st.decisions });
    if (url.pathname === '/report') return send(200, computeReport(st));
    return send(404, { error: 'no existe' });
  } catch (e) { log(`error en servidor: ${e.message}`); send(500, { error: 'error interno' }); }
}

function start() {
  const s = http.createServer(handler);
  s.listen(config().PORT, () => log(`servidor escuchando en puerto ${config().PORT}`));
  return s;
}

module.exports = { handler, start, status };
