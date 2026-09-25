'use strict';
// Chainlink BTC/USD vía el RTDS de Polymarket — la fuente con la que se resuelven los mercados.
// Un socket por tópico: los updates del RTDS no siempre traen el campo "topic", así que
// mezclar tópicos en un socket vuelve ambiguos los mensajes.
//   crypto_prices_chainlink   → spot (~1 punto/s)
//   crypto_prices_twap_sixty  → TWAP de 60 s publicado (el de la apertura ES el precio a superar)
const { WsClient } = require('./ws-client');

class ChainlinkSeries {
  constructor({ cfg, log, topic, name, keepMs = 20 * 60000 }) {
    Object.assign(this, { cfg, log, topic, name, keepMs });
    this.points = []; // [{ ts (hora de la fuente, ms), value, recv }]
    this.onPoint = null;
  }

  start() {
    this.client = new WsClient({
      url: this.cfg.RTDS_WS, name: this.name, log: this.log, pingText: 'PING', pingMs: 5000,
      onOpen: (c) => {
        c.send({ action: 'subscribe', subscriptions: [{ topic: this.topic, type: '*', filters: '{"symbol":"btc/usd"}' }] });
        this.log.info(`✅ ${this.name} suscripto (${this.topic})`);
      },
      onMessage: (raw) => {
        if (raw[0] !== '{') return;
        const msg = JSON.parse(raw);
        if (msg.topic && msg.topic !== this.topic) return;
        const p = msg.payload;
        if (!p) return;
        const list = Array.isArray(p.data) ? p.data : [p]; // snapshot inicial o update
        for (const pt of list) this.add(Number(pt.timestamp), parseFloat(pt.value));
      },
    }).start();
    return this;
  }

  add(ts, value, recv = Date.now()) {
    if (!(value > 1000 && value < 10_000_000) || !Number.isFinite(ts)) return;
    ts = ts > 1e12 ? ts : ts * 1000;
    const a = this.points, n = a.length;
    if (n && ts <= a[n - 1].ts) {
      if (a.some(x => x.ts === ts)) return;
      const i = a.findIndex(x => x.ts > ts);
      a.splice(i === -1 ? n : i, 0, { ts, value, recv });
    } else {
      a.push({ ts, value, recv });
      this.onPoint?.(a[a.length - 1]);
    }
    while (a.length && a[0].ts < Date.now() - this.keepMs && a.length > 1) a.shift();
  }

  last() { return this.points[this.points.length - 1] || null; }

  // Punto con timestamp dentro de ±tolMs de ts (el más cercano)
  at(ts, tolMs = 1000) {
    let best = null;
    for (let i = this.points.length - 1; i >= 0; i--) {
      const d = Math.abs(this.points[i].ts - ts);
      if (d <= tolMs && (!best || d < Math.abs(best.ts - ts))) best = this.points[i];
      if (this.points[i].ts < ts - tolMs) break;
    }
    return best;
  }

  // Último valor en o antes de ts (forward-fill)
  valueAtOrBefore(ts) {
    for (let i = this.points.length - 1; i >= 0; i--) if (this.points[i].ts <= ts) return this.points[i].value;
    return null;
  }

  // Promedio de los puntos en (endTs − windowMs, endTs]; null si cubre < minCoverage de los segundos
  average(endTs, windowMs, minCoverage = 0.8) {
    let sum = 0, n = 0;
    for (let i = this.points.length - 1; i >= 0; i--) {
      const t = this.points[i].ts;
      if (t > endTs) continue;
      if (t <= endTs - windowMs) break;
      sum += this.points[i].value; n++;
    }
    return n >= (windowMs / 1000) * minCoverage ? sum / n : null;
  }

  stop() { this.client?.stop(); }
}

module.exports = { ChainlinkSeries };
