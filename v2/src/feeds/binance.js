'use strict';
// BTC en tiempo real: Binance aggTrade (principal) y Coinbase ticker (respaldo automático).
// Guarda la cinta de los últimos minutos para: precio a una hora dada, y volatilidad.
const { WsClient } = require('./ws-client');

class BtcFeed {
  constructor({ cfg, log }) {
    this.cfg = cfg; this.log = log;
    this.last = null;             // { price, ts (recepción local), src }
    this.tape = [];               // [{ ts, price }] ticks crudos, últimos 3 min
    this.secs = []; this.px = []; // último precio por segundo, últimos VOL_WINDOW_S + 5 min
    this.source = 'binance';
    this._bn = null; this._cb = null;
  }

  start() {
    this._bn = new WsClient({
      url: this.cfg.BINANCE_WS, name: 'Binance', log: this.log,
      onOpen: () => this.log.info('✅ Binance aggTrade conectado'),
      onMessage: (raw) => {
        const m = JSON.parse(raw);
        const p = parseFloat(m.p);
        if (p > 0) { this.source = 'binance'; this.onTick(p, Date.now()); }
      },
    }).start();
    // Respaldo: si Binance no manda nada en 10 s, prender Coinbase
    this._watch = setInterval(() => {
      const stale = !this.last || Date.now() - this.last.ts > 10000;
      if (stale && !this._cb) {
        this.log.warn('Binance sin datos 10 s → usando Coinbase de respaldo');
        this._cb = new WsClient({
          url: this.cfg.COINBASE_WS, name: 'Coinbase', log: this.log,
          onOpen: (c) => c.send({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }),
          onMessage: (raw) => {
            const m = JSON.parse(raw);
            if (m.channel !== 'ticker') return;
            const t = m.events?.[0]?.tickers?.[0];
            const p = parseFloat(t?.price);
            // Solo si Binance sigue callado (evita mezclar USDT y USD)
            if (p > 0 && (!this._bnAlive())) { this.source = 'coinbase'; this.onTick(p, Date.now()); }
          },
        }).start();
      } else if (!stale && this._cb && this.source === 'binance') {
        this._cb.stop(); this._cb = null;
      }
    }, 5000);
    return this;
  }

  _bnAlive() { return this._bn?.connected && Date.now() - this._bn.lastMsgAt < 5000; }

  onTick(price, ts) {
    this.last = { price, ts, src: this.source };
    this.tape.push({ ts, price });
    while (this.tape.length && ts - this.tape[0].ts > 180000) this.tape.shift();
    const sec = Math.floor(ts / 1000), n = this.secs.length;
    if (n && this.secs[n - 1] === sec) this.px[n - 1] = price;
    else if (!n || sec > this.secs[n - 1]) { this.secs.push(sec); this.px.push(price); }
    const keep = this.cfg.VOL_WINDOW_S + 300;
    let drop = 0;
    while (drop < this.secs.length && this.secs[drop] < sec - keep) drop++;
    if (drop) { this.secs.splice(0, drop); this.px.splice(0, drop); }
  }

  // Precio de BTC en (o justo antes de) ts, desde la cinta cruda
  priceAt(ts) {
    for (let i = this.tape.length - 1; i >= 0; i--) if (this.tape[i].ts <= ts) return this.tape[i].price;
    return null;
  }

  // Volatilidad relativa por √segundo con retornos de h segundos. null si hay < 2 min de historia.
  sigma(now = Date.now()) {
    if (this._sig && now - this._sigAt < 5000) return this._sig;
    const n = this.secs.length;
    if (n < 2) return null;
    const end = this.secs[n - 1], start = Math.max(this.secs[0], end - this.cfg.VOL_WINDOW_S);
    if (end - start < this.cfg.VOL_MIN_HISTORY_S) return null;
    const series = []; let j = 0, last = null;
    for (let s = start; s <= end; s++) { while (j < n && this.secs[j] <= s) { last = this.px[j]; j++; } series.push(last); }
    const h = this.cfg.VOL_RET_S; let sum = 0, cnt = 0;
    for (let i = h; i < series.length; i++) {
      const a = series[i - h], b = series[i];
      if (a > 0 && b > 0) { const r = Math.log(b / a); sum += r * r; cnt++; }
    }
    if (cnt < Math.min(60, this.cfg.VOL_MIN_HISTORY_S / 2)) return null;
    this._sig = Math.sqrt(sum / cnt / h); this._sigAt = now;
    return this._sig;
  }

  stop() { clearInterval(this._watch); this._bn?.stop(); this._cb?.stop(); }
}

module.exports = { BtcFeed };
