'use strict';
// Libro de Polymarket de UN mercado (tokens UP y DOWN), por el canal market del WebSocket.
// Un socket por mercado: el handshake {type:'market'} solo vale como primer mensaje, así que
// en vez de re-suscribir se abre un socket nuevo por mercado (se superponen unos segundos).
// Mantiene el libro completo: snapshot 'book' + deltas 'price_change' (size = total del nivel, 0 = se borra).
const { WsClient } = require('./ws-client');

const get = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined) return o[k]; return undefined; };

class MarketBook {
  constructor({ cfg, log, market }) {
    this.cfg = cfg; this.log = log; this.market = market;
    this.tokens = { [market.upToken]: 'UP', [market.downToken]: 'DOWN' };
    this.books = { UP: { bids: new Map(), asks: new Map(), snap: false }, DOWN: { bids: new Map(), asks: new Map(), snap: false } };
    this.tick = market.tickSize || 0.01;
    this.lastUpdate = 0;
    this.resolvedHint = null;   // winner según market_resolved, si llega
    this.consumed = new Map();  // paper: liquidez que ya "tomamos" → key side|book|price → shares
  }

  start() {
    this.client = new WsClient({
      url: this.cfg.POLY_WS, name: `Book ${this.market.label}`, log: this.log, pingText: 'PING', pingMs: 10000,
      onOpen: (c) => c.send({ assets_ids: [this.market.upToken, this.market.downToken], type: 'market', custom_feature_enabled: true }),
      onMessage: (raw) => {
        if (raw[0] !== '{' && raw[0] !== '[') return; // p. ej. "INVALID OPERATION"
        const parsed = JSON.parse(raw);
        for (const m of (Array.isArray(parsed) ? parsed : [parsed])) this.handle(m);
      },
    }).start();
    return this;
  }

  handle(m) {
    const type = get(m, 'event_type', 'type');
    const p = m.payload && typeof m.payload === 'object' ? { ...m, ...m.payload } : m; // formato nuevo con payload
    if (type === 'book') {
      const side = this.tokens[get(p, 'asset_id', 'tokenId', 'assetId')];
      if (!side) return;
      const b = this.books[side];
      b.bids = new Map(); b.asks = new Map();
      for (const l of p.bids || []) this._set(side, 'bids', l.price, l.size);
      for (const l of p.asks || []) this._set(side, 'asks', l.price, l.size);
      b.snap = true;
      this.lastUpdate = Date.now();
    } else if (type === 'price_change') {
      for (const ch of get(p, 'price_changes', 'priceChanges') || []) {
        const side = this.tokens[get(ch, 'asset_id', 'tokenId', 'assetId')];
        if (!side || !this.books[side].snap) continue;
        const bookSide = String(ch.side).toUpperCase() === 'BUY' ? 'bids' : 'asks';
        this._set(side, bookSide, ch.price, ch.size);
      }
      this.lastUpdate = Date.now();
    } else if (type === 'tick_size_change') {
      const t = parseFloat(get(p, 'new_tick_size', 'newTickSize'));
      if (t > 0) { this.tick = t; this.log.info(`tick size → ${t}`); }
    } else if (type === 'market_resolved') {
      const w = get(p, 'winning_asset_id', 'winningTokenId');
      if (this.tokens[w]) this.resolvedHint = this.tokens[w];
    } else if (type === 'best_bid_ask' || type === 'last_trade_price') {
      this.lastUpdate = Date.now();
    }
  }

  _set(side, bookSide, price, size) {
    const px = parseFloat(price), sz = parseFloat(size);
    if (!(px > 0 && px < 1) || !Number.isFinite(sz)) return;
    const key = px.toFixed(4);
    if (sz <= 0) this.books[side][bookSide].delete(key); else this.books[side][bookSide].set(key, sz);
    this.consumed.delete(`${side}|${bookSide}|${key}`); // el nivel cambió: lo que "tomamos" en paper ya no aplica
  }

  // Niveles ordenados (asks ascendente, bids descendente), descontando lo que el paper ya tomó
  levels(side, bookSide) {
    const arr = [];
    for (const [k, sz] of this.books[side][bookSide]) {
      const left = sz - (this.consumed.get(`${side}|${bookSide}|${k}`) || 0);
      if (left > 1e-9) arr.push({ price: parseFloat(k), size: left });
    }
    return arr.sort((a, b) => bookSide === 'asks' ? a.price - b.price : b.price - a.price);
  }

  best(side) {
    const a = this.levels(side, 'asks')[0], b = this.levels(side, 'bids')[0];
    return { ask: a?.price ?? null, askSize: a?.size ?? 0, bid: b?.price ?? null, bidSize: b?.size ?? 0 };
  }

  consume(side, bookSide, price, shares) {
    const key = `${side}|${bookSide}|${price.toFixed(4)}`;
    this.consumed.set(key, (this.consumed.get(key) || 0) + shares);
  }

  healthy(now = Date.now()) {
    return this.client?.connected && this.books.UP.snap && this.books.DOWN.snap && now - this.lastUpdate < this.cfg.STALE_BOOK_MS;
  }

  stop() { this.client?.stop(); }
}

module.exports = { MarketBook };
