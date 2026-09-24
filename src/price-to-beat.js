/**
 * PriceToBeat — precio de referencia oficial de Polymarket ("Price to Beat") y cierre
 * de cada mercado BTC Up/Down 5m, para compararlo con el strike que calcula el bot.
 * Solo diagnóstico: no afecta ninguna decisión.
 *
 * Fuentes (se prueban las dos; se loguea cuál responde):
 *  1. Gamma /events?slug=btc-updown-5m-<inicio>: busca en el evento y sus mercados
 *     cualquier campo tipo priceToBeat / openPrice / closePrice / eventMetadata.
 *  2. polymarket.com/api/crypto/crypto-price (lo usa la web para mostrar el Price to Beat).
 */
'use strict';
const { Logger } = require('./logger');
const logger = new Logger('PTB');

const GAMMA = 'https://gamma-api.polymarket.com';
const KEY_RE = /beat|strike|open_?price|close_?price|reference|final_?price|eventmetadata|outcomeprices/i;

// Recorre el objeto y junta { ruta: valor } de las claves que parecen precio de referencia
function scan(obj, path = '', out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (KEY_RE.test(k) && v != null && v !== '') {
      out[p] = typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v;
    } else if (typeof v === 'object') {
      scan(v, p, out, depth + 1);
    }
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

class PriceToBeat {
  constructor() {
    this._keysLogged = false;
    this._webFailLogged = false;
  }

  async fetch(startMs) {
    const endMs = startMs + 300000;
    const found = {};
    try {
      const data = await getJson(`${GAMMA}/events?slug=btc-updown-5m-${Math.floor(startMs / 1000)}`);
      const event = Array.isArray(data) ? data[0] : (data.events || data.data || [])[0];
      if (event) {
        if (!this._keysLogged) {
          this._keysLogged = true;
          logger.info(`[PTB] Campos del evento Gamma: ${Object.keys(event).join(',')}`);
          const m0 = event.markets?.[0];
          if (m0) logger.info(`[PTB] Campos del mercado Gamma: ${Object.keys(m0).join(',')}`);
        }
        Object.assign(found, scan(event, 'gamma'));
      }
    } catch (e) {
      found.gamma_error = e.message;
    }
    try {
      const qs = new URLSearchParams({
        symbol: 'BTC',
        eventStartTime: new Date(startMs).toISOString(),
        variant: 'fiveminute',
        endDate: new Date(endMs).toISOString(),
      });
      const web = await getJson(`https://polymarket.com/api/crypto/crypto-price?${qs}`);
      Object.assign(found, scan(web, 'web'));
      if (!Object.keys(scan(web)).length) found.web_raw = JSON.stringify(web).slice(0, 200);
    } catch (e) {
      if (!this._webFailLogged) { this._webFailLogged = true; found.web_error = e.message; }
    }
    return found;
  }

  // Loguea lo oficial junto al strike/cierre Chainlink del bot. Se llama al cierre del mercado.
  async report(label, startMs, ours) {
    const found = await this.fetch(startMs);
    const fmt = Object.entries(found).map(([k, v]) => `${k}=${v}`).join(' ');
    logger.info(`[PTB] ${label} | oficial: ${fmt || 'sin campos de precio'} | bot CL strike=${ours.strike?.toFixed(2) ?? 'n/a'} close=${ours.close?.toFixed(2) ?? 'n/a'}`);
  }
}

module.exports = { PriceToBeat };
