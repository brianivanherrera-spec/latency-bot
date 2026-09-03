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
const fs   = require('fs');
const path = require('path');
const { Logger } = require('./logger');

const logger = new Logger('POLY-WS');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_MS = 10_000;
const RECONNECT_MIN = 1_000;
const RECONNECT_MAX = 30_000;
const TRADE_MAP_FILE = path.join(process.env.DATA_DIR || '/data', 'last-trades.json');

// Cargar trade map persistido (sobrevive reinicios)
function loadTradeMap() {
  try {
    if (fs.existsSync(TRADE_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRADE_MAP_FILE, 'utf8'));
      const now = Date.now();
      const map = new Map();
      // Solo cargar trades de los últimos 5 minutos — más viejos no son útiles
      for (const [tokenId, trade] of Object.entries(data)) {
        if (now - trade.timestamp < 5 * 60 * 1000) {
          map.set(tokenId, trade);
        }
      }
      logger.debug(`[TRADE-MAP] Cargado desde disco: ${map.size} trades recientes`);
      return map;
    }
  } catch (e) {
    logger.warn(`[TRADE-MAP] Error al cargar: ${e.message}`);
  }
  return new Map();
}

// Guardar trade map en disco (llamar después de cada update)
function saveTradeMap(map) {
  try {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    fs.writeFileSync(TRADE_MAP_FILE, JSON.stringify(obj));
  } catch (e) {
    // No crítico — solo logging
    logger.warn(`[TRADE-MAP] Error al guardar: ${e.message}`);
  }
}

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
    this._lastPriceByToken = new Map();   // precio combinado (para emitPair)
    this._marketPriceByToken = new Map(); // precio SOLO del canal market/best_bid_ask
    this._bestAskByToken = new Map();     // best_ask en tiempo real por tokenId — sin REST
    this._lastTradeByToken = loadTradeMap(); // último trade ejecutado por token — persiste reinicios

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
  // Debug: ver estado interno del book
  debugBookState() {
    const keys = [...this._bookByToken.keys()];
    logger.info(`[BOOK-DEBUG] _bookByToken tiene ${keys.length} tokens: ${keys.map(k=>k.slice(0,8)).join(', ')}`);
    logger.info(`[BOOK-DEBUG] _yesTokenId=${this._yesTokenId?.slice(0,8)} _noTokenId=${this._noTokenId?.slice(0,8)}`);
    keys.forEach(k => {
      const b = this._bookByToken.get(k);
      logger.info(`[BOOK-DEBUG] token ${k.slice(0,8)}: bid=${b?.bid} ask=${b?.ask} updatedAt=${b?.updatedAt ? new Date(b.updatedAt).toISOString() : 'n/a'}`);
    });
  }

  // Retorna el best_ask en tiempo real desde el WS — sin REST call, latencia ~0ms
  // Se actualiza con cada evento best_bid_ask del canal market
  getBestAskForToken(tokenId) {
    if (!tokenId) return null;
    return this._bestAskByToken.get(tokenId) ?? null;
  }

  // Retorna el último precio REAL de transacción para un tokenId
  // Usa _marketPriceByToken (canal market/best_bid_ask) que NO se sobreescribe
  // con el mid del book — así los snapshots t1/t2/t5 son precios reales
  getPriceForToken(tokenId) {
    if (!tokenId) return null;
    return this._marketPriceByToken.get(tokenId) ?? null;
  }

  // Retorna el último trade ejecutado para el par YES/NO
  // Incluye precio, tamaño y timestamp — indica convicción real del mercado
  // (distinto al book que solo muestra órdenes pendientes)
  getLastTradeSnapshot() {
    const yesId = this._yesTokenId;
    const noId  = this._noTokenId;
    if (!yesId && !noId) return null;

    let yesTrade = yesId ? this._lastTradeByToken.get(yesId) : null;
    let noTrade  = noId  ? this._lastTradeByToken.get(noId)  : null;

    // Fallback: si el mercado acaba de cambiar y todavía no llegaron trades
    // con los nuevos tokenIds, usar los trades más recientes del Map
    // (son del mercado anterior, expirarán en 30s pero son señal de actividad reciente)
    if (!yesTrade && !noTrade && this._lastTradeByToken.size > 0) {
      const now = Date.now();
      let latestEntry = null;
      for (const [, trade] of this._lastTradeByToken) {
        if (!latestEntry || trade.timestamp > latestEntry.timestamp) {
          latestEntry = trade;
        }
      }
      // Solo usar si tiene menos de 5 minutos de antigüedad (ventana amplia para el fallback entre mercados)
      if (latestEntry && (now - latestEntry.timestamp) < 5 * 60 * 1000) {
        logger.debug(`[POLY-WS] [TRADE SNAP] usando trade de mercado anterior (age=${now - latestEntry.timestamp}ms)`);
        // Calcular imbalance con todos los trades del Map (mercado anterior)
        let prevYesSize = 0, prevNoSize = 0;
        for (const [, trade] of this._lastTradeByToken) {
          if (now - trade.timestamp < 5 * 60 * 1000) {
            // No sabemos cuál es YES/NO del mercado actual — acumulamos todo
            if (trade.trade_side === 'BUY') prevYesSize += trade.size;
            else prevNoSize += trade.size;
          }
        }
        const prevTotal = prevYesSize + prevNoSize;
        const prevImbalance = prevTotal > 0 ? parseFloat(((prevYesSize - prevNoSize) / prevTotal).toFixed(3)) : null;
        return {
          latest_token:      'PREV',
          latest_trade_side: latestEntry.trade_side || null,
          latest_price:      parseFloat(latestEntry.price.toFixed(4)),
          latest_size:       parseFloat(latestEntry.size.toFixed(2)),
          latest_age_ms:     now - latestEntry.timestamp,
          yes_trade_size:    parseFloat(prevYesSize.toFixed(2)),
          no_trade_size:     parseFloat(prevNoSize.toFixed(2)),
          trade_imbalance:   prevImbalance,
        };
      }
      logger.debug(`[POLY-WS] [TRADE SNAP] null — map vacío (yesId=${yesId?.slice(0,8)} noId=${noId?.slice(0,8)} mapSize=${this._lastTradeByToken.size})`);
      return null;
    }

    if (!yesTrade && !noTrade) {
      logger.debug(`[POLY-WS] [TRADE SNAP] null — sin trades (yesId=${yesId?.slice(0,8)} noId=${noId?.slice(0,8)})`);
      return null;
    }

    // El trade más reciente entre YES y NO
    const isYesLatest = !noTrade || (yesTrade && yesTrade.timestamp >= noTrade.timestamp);
    const latestTrade = isYesLatest ? yesTrade : noTrade;
    const latestToken = isYesLatest ? 'YES' : 'NO';

    // El trade más grande en la ventana de 30s (para imbalance)
    const yesSize = yesTrade?.size || 0;
    const noSize  = noTrade?.size  || 0;
    const totalSize = yesSize + noSize;
    // Positivo = más volumen en YES, negativo = más volumen en NO
    const sideImbalance = totalSize > 0 ? (yesSize - noSize) / totalSize : 0;

    return {
      latest_token:      latestToken,                                    // YES o NO (qué token se tradeó)
      latest_trade_side: latestTrade.trade_side || null,                 // BUY o SELL (agressor del WS)
      latest_price:      parseFloat(latestTrade.price.toFixed(4)),
      latest_size:       parseFloat(latestTrade.size.toFixed(2)),
      latest_age_ms:     Date.now() - latestTrade.timestamp,
      yes_trade_size:    parseFloat(yesSize.toFixed(2)),
      no_trade_size:     parseFloat(noSize.toFixed(2)),
      // Positivo = más tokens YES ejecutados, negativo = más NO ejecutados
      trade_imbalance:   parseFloat(sideImbalance.toFixed(3)),
    };
  }

  getBookSnapshot() {
    const yesBook = this._bookByToken.get(this._yesTokenId) || null;
    const noBook  = this._bookByToken.get(this._noTokenId)  || null;
    if (!yesBook && !noBook) return null;

    // Usar profundidad del snapshot si existe, sino usar bestBid/bestAsk del best_bid_ask
    // best_bid_ask llega en tiempo real (<100ms) vs snapshot que llega cada 2-5s
    const yesBidDepth = yesBook?.bid ?? yesBook?.bestBid ?? 0;
    const yesAskDepth = yesBook?.ask ?? yesBook?.bestAsk ?? 0;
    const noBidDepth  = noBook?.bid  ?? noBook?.bestBid  ?? 0;
    const noAskDepth  = noBook?.ask  ?? noBook?.bestAsk  ?? 0;

    // Indicar si viene de snapshot real (profundidad) o de best_bid_ask (tiempo real)
    const hasDepth = (yesBook?.bid != null) || (noBook?.bid != null);
    if (!hasDepth) {
      // Imbalance desde best_bid_ask: YES_bid vs NO_bid
      // Con solo bid/ask top, usar bid como proxy de profundidad
      // Un bestBid alto en YES = más compradores de YES = imbalance positivo
    }

    const totalBid = yesBidDepth + noBidDepth;
    const volImbalance = totalBid > 0
      ? parseFloat(((yesBidDepth - noBidDepth) / totalBid).toFixed(3))
      : 0;

    return {
      yes_bid_depth: yesBidDepth,
      yes_ask_depth: yesAskDepth,
      no_bid_depth:  noBidDepth,
      no_ask_depth:  noAskDepth,
      vol_imbalance: volImbalance,
      from_best_bid_ask: !hasDepth, // flag para saber la fuente
    };
  }

  // Imbalance instantáneo desde best_bid_ask — latencia <100ms vs snapshot 2-5s
  // Usa el precio del mejor bid de YES/NO como proxy del sentimiento del mercado
  // YES_bid alto = más compradores de YES = mercado yendo UP
  // Menos preciso que la profundidad pero MUCHO más rápido
  getInstantImbalance() {
    const yesBook = this._bookByToken.get(this._yesTokenId);
    const noBook  = this._bookByToken.get(this._noTokenId);
    if (!yesBook?.bestBid && !noBook?.bestBid) return null;

    const yesBid = yesBook?.bestBid ?? 0.50;
    const noBid  = noBook?.bestBid  ?? 0.50;

    // Con mercado binario: YES + NO = 1 siempre
    // Si YES_bid = 0.70, implícitamente NO_bid ≈ 0.30
    // Imbalance = (YES_bid - NO_bid) / (YES_bid + NO_bid)
    const total = yesBid + noBid;
    if (total <= 0) return null;
    return parseFloat(((yesBid - noBid) / total).toFixed(3));
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
    // Solo limpiar precios y book cuando cambia el mercado (nuevos tokenIds)
    // No limpiar en reconexiones al mismo mercado — el book sigue siendo válido
    if (!same) {
      this._lastPriceByToken.clear();
      this._marketPriceByToken.clear();
      this._bookByToken.clear();
      // NO limpiar _lastTradeByToken — los trades del mercado anterior
      // expiran solos (ventana de 30s). Limpiarlos aquí deja en null las
      // primeras señales del mercado nuevo, que son las más valiosas.
    }

    if (this._connected && yesTokenId && noTokenId) {
      this._sendSubscribe([yesTokenId, noTokenId]);
      logger.info(`Suscrito a 2 tokens`);
    }
  }

  /**
   * Solo limpia estado local de tokens. NO limpia el book — puede haber
   * una reconexión inminente al mismo mercado y los datos siguen siendo válidos.
   */
  unsubscribeAll() {
    this._yesTokenId = null;
    this._noTokenId = null;
    this._subscribedTokens.clear();
    this._lastPriceByToken.clear();
    this._marketPriceByToken.clear();
    this._bookByToken.clear();
    // NO limpiar _lastTradeByToken — igual que en subscribe(),
    // los trades expiran solos en 30s. Limpiarlos acá deja en null
    // las señales del mercado siguiente.
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
      // RAW LOG — diagnóstico temporal para ver qué campos manda Polymarket
      // Remover cuando se confirmen los campos correctos
      if (this._rawTradeLogCount === undefined) this._rawTradeLogCount = 0;
      if (this._rawTradeLogCount < 10) {
        logger.debug(`[POLY-WS] [RAW last_trade_price] ${JSON.stringify(msg)}`);
        this._rawTradeLogCount++;
      }

      const price = parseFloat(msg.price);
      const size  = parseFloat(msg.size || msg.amount || 0);
      const tokenId = msg.asset_id;

      if (!isNaN(price) && price > 0 && tokenId) {
        // Actualizar precio con el último trade ejecutado
        this._lastPriceByToken.set(tokenId, price);
        this._marketPriceByToken.set(tokenId, price);

        // Guardar el último trade grande para análisis de order flow
        // Un trade ejecutado de tamaño significativo indica convicción real
        // (distinto al book que solo muestra intención)
        if (!isNaN(size) && size > 0) {
          const existing = this._lastTradeByToken.get(tokenId);
          const now = Date.now();
          const isYes = tokenId === this._yesTokenId;
          const isNo  = tokenId === this._noTokenId;

          // Siempre guardar el trade más reciente.
          // También actualizar el peak size si este trade es más grande dentro de los últimos 30s.
          const peakSize = (existing && existing.timestamp >= now - 30000)
            ? Math.max(existing.peak_size || existing.size, size)
            : size;

          this._lastTradeByToken.set(tokenId, {
            price,
            size,
            peak_size:  peakSize,
            trade_side: msg.side || null,
            timestamp:  now,
          });
          saveTradeMap(this._lastTradeByToken);

          if (isYes || isNo) {
            logger.debug(`[POLY-WS] [TRADE SAVED] ${isYes ? 'YES' : 'NO'} side=${msg.side} price=${price} size=${size} peak=${peakSize}`);
          }
        } else {
          // size llegó como 0 o NaN — loggear para detectar si hay eventos sin size
          if (this._rawTradeLogCount <= 10) {
            logger.info(`[POLY-WS] [TRADE NO-SIZE] asset=${tokenId?.slice(0,8)} price=${msg.price} size_raw=${msg.size}`);
          }
        }

        if (price >= 0.995 || price <= 0.005) {
          this._emitPair({ allowExtreme: true });
        } else {
          this._emitPair();
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
    // El canal book actualiza _lastPriceByToken (para emitPair/display)
    // pero NO _marketPriceByToken — los snapshots t1/t2/t5 solo usan precios
    // reales de transacciones del canal market, no el mid calculado del book
    // que puede alternar entre 0.50 y 0.90+ causando lecturas falsas
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
      if (mid != null) {
        this._lastPriceByToken.set(tokenId, mid);
        // También actualizar el precio de mercado real (canal market)
        // Este es el precio que usan los snapshots t1/t2/t5
        this._marketPriceByToken.set(tokenId, mid);
      }
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
      const price = ask >= 0.99 ? 0.999 : ask;
      this._lastPriceByToken.set(tokenId, price);
      this._marketPriceByToken.set(tokenId, price);
      this._emitPair({ allowExtreme: true });
      return;
    }
    if (bid <= 0 || ask <= 0 || ask > 1) return;
    const mid = (bid + ask) / 2;
    this._lastPriceByToken.set(tokenId, mid);
    // Guardar best_ask real para uso directo sin REST call
    this._bestAskByToken.set(tokenId, ask);
    // Precio real de transacción — actualizar _marketPriceByToken
    this._marketPriceByToken.set(tokenId, mid);

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
