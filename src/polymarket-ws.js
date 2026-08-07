/**
 * Polymarket CLOB WebSocket — precios YES/NO en tiempo real
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe: { assets_ids, type: "market", custom_feature_enabled: true }
 * Heartbeat: texto "PING" cada 10s → "PONG"
 *
 * Fix 2026-08-05b (post-deploy):
 *   - NO declarar "resuelto" solo porque mid >= 0.99 (en 5m es normal cerca del cierre)
 *   - Solo market_resolved event (o last_trade 0/1 con debounce)
 *   - No enviar unsubscribe inválido → elimina "INVALID OPERATION"
 *   - Reconnect con backoff, nunca se rinde
 *   - Parser book / price_change / best_bid_ask
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('POLY-WS');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = 10_000;
const RECONNECT_MIN = 1_000;
const RECONNECT_MAX = 30_000;

class PolymarketWS {
  constructor() {
    this.ws = null;
    this._connected = false;
    this._intentionalClose = false;
    this._reconnectDelay = RECONNECT_MIN;
    this._reconnectTimer = null;
    this._pingInterval = null;
    this._connecting = false;

    this._yesTokenId = null;
    this._noTokenId = null;
    this._subscribedTokens = new Set();
    this._lastPriceByToken = new Map();

    // ─── Book depth state ─────────────────────────────────────────────────
    // Guardamos bid/ask depth por token para análisis de order flow.
    // Se actualiza con cada evento 'book' (snapshot) del WS.
    // Estructura: { bid: totalTokens, ask: totalTokens, bids: [{price,size}], asks: [{price,size}] }
    this._bookByToken = new Map();

    this._priceCallback = null;
    this._resolvedCallback = null;
    this._lastResolvedAt = 0; // debounce
    this._lastPongAt = 0;
    this._msgCount = 0;
  }

  onPrice(cb) { this._priceCallback = cb; }
  onResolved(cb) { this._resolvedCallback = cb; }
  isConnected() { return this._connected; }

  // Devuelve el estado actual del book para un par YES/NO
  // Usado por signal-logger para grabar profundidad al momento de cada señal
  getBookSnapshot() {
    const yesBook = this._bookByToken.get(this._yesTokenId) || null;
    const noBook  = this._bookByToken.get(this._noTokenId)  || null;
    if (!yesBook && !noBook) return null;

    const yesBidDepth = yesBook?.bid ?? 0;
    const yesAskDepth = yesBook?.ask ?? 0;
    const noBidDepth  = noBook?.bid  ?? 0;
    const noAskDepth  = noBook?.ask  ?? 0;

    // Imbalance de volumen: (YES_bid - NO_bid) / (YES_bid + NO_bid)
    // Positivo = más gente comprando YES, negativo = más gente comprando NO
    const totalBid = yesBidDepth + noBidDepth;
    const volImbalance = totalBid > 0
      ? parseFloat(((yesBidDepth - noBidDepth) / totalBid).toFixed(3))
      : 0;

    return {
      yes_bid_depth: yesBidDepth,
      yes_ask_depth: yesAskDepth,
      no_bid_depth:  noBidDepth,
      no_ask_depth:  noAskDepth,
      vol_imbalance: volImbalance,  // -1 = todo en NO, +1 = todo en YES
    };
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      this._connectOnce({ resolve, reject, isInitial: true });
    });
  }

  _connectOnce({ resolve, reject, isInitial } = {}) {
    if (this._intentionalClose) return;
    if (this._connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (resolve) resolve();
      return;
    }

    this._connecting = true;
    this._clearPing();
    this._teardownSocket();

    logger.info(`Conectando a ${WS_URL}...`);
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      this._connecting = false;
      logger.error(`No se pudo crear WS: ${err.message}`);
      if (isInitial && reject) reject(err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this._connecting = false;
      this._connected = true;
      this._reconnectDelay = RECONNECT_MIN;
      this._lastPongAt = Date.now();
      logger.info('✅ Polymarket WS conectado');

      if (this._yesTokenId && this._noTokenId) {
        this._sendSubscribe([this._yesTokenId, this._noTokenId]);
      } else if (this._subscribedTokens.size > 0) {
        this._sendSubscribe([...this._subscribedTokens]);
      }
      this._startPing();
      if (!settled && resolve) { settled = true; resolve(); }
    });

    ws.on('message', (data) => {
      const raw = data.toString();
      if (raw === 'PONG' || raw === 'pong') {
        this._lastPongAt = Date.now();
        return;
      }
      // Polymarket a veces responde texto plano a ops inválidas
      if (raw === 'INVALID OPERATION' || raw.startsWith('INVALID')) {
        return; // silencioso — suele ser unsubscribe viejo o subscribe duplicado
      }
      try {
        const parsed = JSON.parse(raw);
        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of events) this._handleMessage(msg);
      } catch (e) {
        if (raw && raw.length < 120) {
          logger.warn(`Parse error: ${e.message} | raw: ${raw.slice(0, 80)}`);
        }
      }
    });

    ws.on('error', (err) => {
      this._connected = false;
      logger.error(`WS error: ${err.message}`);
      if (!settled && isInitial && reject) {
        settled = true;
        reject(err);
      }
    });

    ws.on('close', (code, reason) => {
      this._connecting = false;
      const was = this._connected;
      this._connected = false;
      this._clearPing();
      if (was) logger.warn(`Desconectado (code=${code}${reason ? ` ${reason}` : ''})`);
      if (!settled && isInitial && reject) {
        settled = true;
        reject(new Error(`WS closed before open (code=${code})`));
      }
      if (!this._intentionalClose) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._intentionalClose) return;
    if (this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    logger.warn(`Reconectando en ${delay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX);
      this._connectOnce({ isInitial: false });
    }, delay);
  }

  _startPing() {
    this._clearPing();
    this._pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.send('PING'); } catch (_) {}
      if (this._lastPongAt && Date.now() - this._lastPongAt > PING_MS * 3) {
        logger.warn('Sin PONG en 30s — forzando reconexión');
        try { this.ws.terminate(); } catch (_) {}
      }
    }, PING_MS);
  }

  _clearPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  _teardownSocket() {
    if (!this.ws) return;
    try {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch (_) {}
    this.ws = null;
  }

  subscribe(yesTokenId, noTokenId) {
    const same = this._yesTokenId === yesTokenId && this._noTokenId === noTokenId;
    this._yesTokenId = yesTokenId || null;
    this._noTokenId = noTokenId || null;
    this._subscribedTokens.clear();
    [yesTokenId, noTokenId].filter(Boolean).forEach(t => this._subscribedTokens.add(t));
    if (!same) this._lastPriceByToken.clear(); this._bookByToken.clear();

    if (this._connected && yesTokenId && noTokenId) {
      this._sendSubscribe([yesTokenId, noTokenId]);
      logger.info(`Suscrito a 2 tokens`);
    }
  }

  /**
   * Solo limpia estado local. NO manda unsubscribe al server
   * (el payload viejo provocaba "INVALID OPERATION" en loop).
   */
  unsubscribeAll() {
    this._yesTokenId = null;
    this._noTokenId = null;
    this._subscribedTokens.clear();
    this._lastPriceByToken.clear();
    this._bookByToken.clear();
  }

  _sendSubscribe(tokenIds) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!tokenIds?.length) return;
    try {
      // Canal "market": recibe best_bid_ask y price_change en tiempo real
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        type: 'market',
        custom_feature_enabled: true,
      }));
      // Canal "book": recibe snapshot completo con bids[]/asks[] y su profundidad
      // Necesario para grabar book_yes_bid, book_no_bid, book_vol_imbalance
      this.ws.send(JSON.stringify({
        assets_ids: tokenIds,
        type: 'book',
      }));
    } catch (e) {
      logger.error(`Error subscribe: ${e.message}`);
    }
  }

  _emitResolved(winner) {
    const now = Date.now();
    // Debounce 15s — evita storm de YES/NO alternados
    if (now - this._lastResolvedAt < 15000) return;
    this._lastResolvedAt = now;
    logger.info(`Mercado resuelto via WS: ${winner}`);
    if (this._resolvedCallback) this._resolvedCallback(winner);
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.event_type || msg.type || '';
    if (!type || type === 'heartbeat' || type === 'subscribed') return;
    this._msgCount += 1;

    if (type === 'book') {
      this._onBook(msg);
      return;
    }
    if (type === 'price_change') {
      this._onPriceChange(msg);
      return;
    }
    if (type === 'best_bid_ask') {
      this._onBestBidAsk(msg);
      return;
    }
    if (type === 'last_trade_price') {
      // Solo resolución si el trade es exactamente al extremo Y tenemos contexto
      const price = parseFloat(msg.price);
      if (!isNaN(price) && (price >= 0.995 || price <= 0.005)) {
        // No emitir resolved por last_trade solo — genera falsos positivos en 5m
        // Actualizar precio sí
        const tokenId = msg.asset_id;
        if (tokenId && price > 0) {
          this._lastPriceByToken.set(tokenId, price);
          this._emitPair({ allowExtreme: true });
        }
      }
      return;
    }
    if (type === 'market_resolved') {
      // Única fuente confiable de resolución por WS
      let winner = null;
      if (msg.winning_asset_id) {
        if (msg.winning_asset_id === this._yesTokenId) winner = 'YES';
        else if (msg.winning_asset_id === this._noTokenId) winner = 'NO';
      }
      if (!winner && msg.outcome) {
        const o = String(msg.outcome).toUpperCase();
        if (o.includes('YES') || o === 'UP') winner = 'YES';
        if (o.includes('NO') || o === 'DOWN') winner = 'NO';
      }
      if (winner) this._emitResolved(winner);
      return;
    }
  }

  _onBook(msg) {
    const tokenId = msg.asset_id;
    if (!tokenId) return;
    const bids = msg.bids || [];
    const asks = msg.asks || [];
    const bestBid = parseFloat(bids[0]?.price);
    const bestAsk = parseFloat(asks[0]?.price);
    let mid = null;
    if (!isNaN(bestBid) && !isNaN(bestAsk)) mid = (bestBid + bestAsk) / 2;
    else if (!isNaN(bestAsk)) mid = bestAsk;
    else if (!isNaN(bestBid)) mid = bestBid;
    if (mid == null || mid <= 0) return;
    this._lastPriceByToken.set(tokenId, mid);

    // Calcular profundidad total del book (suma de tokens en todos los niveles)
    // Polymarket puede mandar size como string o número
    const parseSize = (s) => parseFloat(s?.size ?? s?.amount ?? 0) || 0;
    const bidDepth = bids.reduce((s, l) => s + parseSize(l), 0);
    const askDepth = asks.reduce((s, l) => s + parseSize(l), 0);

    const hadDepth = this._bookByToken.has(tokenId);
    this._bookByToken.set(tokenId, {
      bid: parseFloat(bidDepth.toFixed(2)),
      ask: parseFloat(askDepth.toFixed(2)),
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
      updatedAt: Date.now(),
    });

    // Loguear solo la primera vez que recibimos depth real para este token
    if (!hadDepth && (bidDepth > 0 || askDepth > 0)) {
      const isYes = tokenId === this._yesTokenId;
      logger.info(`[POLY-WS] 📊 Book depth ${isYes ? 'YES' : 'NO'}: bid=${bidDepth.toFixed(0)} ask=${askDepth.toFixed(0)} tokens`);
    }

    this._emitPair();
  }

  _onPriceChange(msg) {
    const changes = msg.price_changes;
    if (!Array.isArray(changes)) return;
    for (const ch of changes) {
      const tokenId = ch.asset_id;
      if (!tokenId) continue;
      const bid = parseFloat(ch.best_bid);
      const ask = parseFloat(ch.best_ask);
      let mid = null;
      if (!isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
      else {
        const p = parseFloat(ch.price);
        if (!isNaN(p) && p > 0) mid = p;
      }
      if (mid != null) this._lastPriceByToken.set(tokenId, mid);
    }
    this._emitPair();
  }

  _onBestBidAsk(msg) {
    const tokenId = msg.asset_id;
    if (!tokenId) return;
    const bid = parseFloat(msg.best_bid);
    const ask = parseFloat(msg.best_ask);
    if (isNaN(bid) || isNaN(ask)) return;
    if (bid <= 0 && ask >= 0.99) {
      this._lastPriceByToken.set(tokenId, ask >= 0.99 ? 0.999 : ask);
      this._emitPair({ allowExtreme: true });
      return;
    }
    if (bid <= 0 || ask <= 0 || ask > 1) return;
    const mid = (bid + ask) / 2;
    this._lastPriceByToken.set(tokenId, mid);

    // Actualizar el book con los mejores bid/ask — no tenemos profundidad completa
    // pero sí el nivel top, que es suficiente para el imbalance básico.
    // Preservar la profundidad del snapshot si ya la tenemos.
    const existing = this._bookByToken.get(tokenId) || {};
    this._bookByToken.set(tokenId, {
      ...existing,
      bestBid: bid,
      bestAsk: ask,
      updatedAt: Date.now(),
    });

    this._emitPair();
  }

  /**
   * Emite YES/NO al callback de precio.
   * IMPORTANTE: precios extremos (>=0.99) se pasan como precio normal
   * para que el bot los vea, pero NO disparan onResolved.
   * La resolución real viene solo de event market_resolved (o del poll Gamma).
   */
  _emitPair({ allowExtreme = false } = {}) {
    if (!this._priceCallback) return;
    const yesId = this._yesTokenId;
    const noId = this._noTokenId;
    if (!yesId || !noId) return;

    let yes = this._lastPriceByToken.get(yesId);
    let no = this._lastPriceByToken.get(noId);
    if (yes != null && no == null) no = 1 - yes;
    if (no != null && yes == null) yes = 1 - no;
    if (yes == null || no == null) return;

    yes = parseFloat(Number(yes).toFixed(3));
    no = parseFloat(Number(no).toFixed(3));

    // Validar coherencia: YES + NO deben sumar ~1
    // Si no suman, hay un precio stale de un mercado anterior mezclado — descartar
    const sum = yes + no;
    if (sum < 0.88 || sum > 1.12) {
      // Intentar recalcular: si tenemos ambos precios individuales, uno puede ser stale
      // Usar el más reciente (el que acaba de llegar) y calcular el complemento
      return;
    }

    // Rango de trading normal
    if (yes >= 0.05 && yes <= 0.95) {
      this._priceCallback(yes, no);
      return;
    }
    // Extremos: actualizar precio pero NO resolver
    if (allowExtreme && (yes > 0 && yes < 1)) {
      this._priceCallback(yes, no);
    }
  }

  close() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._clearPing();
    this._teardownSocket();
    this._connected = false;
  }
}

module.exports = { PolymarketWS };
