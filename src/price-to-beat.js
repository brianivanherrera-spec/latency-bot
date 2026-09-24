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
          // Reglas de resolución y configuración del mercado cripto, tal cual las publica Gamma
          const txt = v => (v == null ? 'n/a' : (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 800));
          logger.info(`[PTB] Reglas: ${txt(m0?.description ?? event.description)}`);
          logger.info(`[PTB] resolutionSource=${txt(m0?.resolutionSource ?? event.resolutionSource)} | cryptoMarketConfigId=${txt(m0?.cryptoMarketConfigId)} | cryptoMarketConfig=${txt(m0?.cryptoMarketConfig)}`);
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
  /**
   * Revisa mercados ya resueltos de las últimas `hours` horas y compara la resolución real
   * (outcomePrices de Gamma) con dos precios de referencia: openPrice de la web (= Chainlink
   * en la apertura, lo que usa el bot) y eventMetadata.priceToBeat de Gamma. Loguea los
   * mercados donde ambos predicen resultados distintos y un resumen.
   */
  async backfill(hours) {
    const nowMs = Date.now();
    const lastStart = Math.floor((nowMs - 10 * 60000) / 300000) * 300000; // cerrado hace >5 min
    const n = Math.floor((hours * 3600000) / 300000);
    const st = { total: 0, sinDatos: 0, openOk: 0, ptbOk: 0, ptbN: 0, difieren: 0, sinPtb: 0 };
    const up = (close, ref) => close >= ref;
    logger.info(`[PTB-BACKFILL] Revisando ${n} mercados de las últimas ${hours} h...`);
    for (let i = n; i >= 1; i--) {
      const startMs = lastStart - (i - 1) * 300000;
      const endMs = startMs + 300000;
      let ptb = null, real = null, open = null, close = null;
      try {
        const data = await getJson(`${GAMMA}/events?slug=btc-updown-5m-${Math.floor(startMs / 1000)}`);
        const event = Array.isArray(data) ? data[0] : (data.events || data.data || [])[0];
        const meta = typeof event?.eventMetadata === 'string' ? JSON.parse(event.eventMetadata) : event?.eventMetadata;
        ptb = meta?.priceToBeat != null ? Number(meta.priceToBeat) : null;
        let op = event?.markets?.[0]?.outcomePrices;
        if (typeof op === 'string') op = JSON.parse(op);
        const outs = event?.markets?.[0]?.outcomes;
        const outcomes = typeof outs === 'string' ? JSON.parse(outs) : outs;
        if (Array.isArray(op)) {
          const p0 = Number(op[0]);
          const upFirst = !Array.isArray(outcomes) || /up/i.test(outcomes[0]);
          if (p0 >= 0.99) real = upFirst ? 'UP' : 'DOWN';
          else if (p0 <= 0.01) real = upFirst ? 'DOWN' : 'UP';
        }
        const qs = new URLSearchParams({ symbol: 'BTC', eventStartTime: new Date(startMs).toISOString(), variant: 'fiveminute', endDate: new Date(endMs).toISOString() });
        const web = await getJson(`https://polymarket.com/api/crypto/crypto-price?${qs}`);
        open = web?.openPrice != null ? Number(web.openPrice) : null;
        close = web?.closePrice != null ? Number(web.closePrice) : null;
      } catch (e) { /* mercado sin datos: se cuenta abajo */ }
      await new Promise(r => setTimeout(r, 250));
      if (!real || open == null || close == null) { st.sinDatos++; continue; }
      st.total++;
      const byOpen = up(close, open) ? 'UP' : 'DOWN';
      if (byOpen === real) st.openOk++;
      if (ptb == null) { st.sinPtb++; continue; }
      st.ptbN++;
      const byPtb = up(close, ptb) ? 'UP' : 'DOWN';
      if (byPtb === real) st.ptbOk++;
      if (byOpen !== byPtb || byOpen !== real) {
        st.difieren++;
        logger.info(`[PTB-BACKFILL] ${new Date(startMs).toISOString().slice(0, 16)} | real=${real} | openPrice=${open.toFixed(2)}→${byOpen} | priceToBeat=${ptb.toFixed(2)}→${byPtb} | close=${close.toFixed(2)}`);
      }
    }
    logger.info(`[PTB-BACKFILL] RESUMEN ${st.total} mercados resueltos (${st.sinDatos} sin datos) | resolución = openPrice (Chainlink apertura): ${st.openOk}/${st.total} | resolución = priceToBeat de Gamma: ${st.ptbOk}/${st.ptbN} (${st.sinPtb} sin priceToBeat) | casos con diferencia: ${st.difieren}`);
    return st;
  }
}

module.exports = { PriceToBeat };
