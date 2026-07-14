/**
 * LATENCY BOT - VERSIÓN FINAL
 * ✅ SignalEngine + PnLTracker + Cooldown + Live orders + Diagnóstico
 */

const { BinanceWS } = require('./binance');
const { PolymarketWS } = require('./polymarket-ws');
const marketResearch = require('./market-research');
const RESEARCH_MODE = process.env.RESEARCH_MODE === 'true';
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');
const { alertTradeSignal, alertBotStart } = require('./alerts');
const signalLogger = require('./signal-logger');

const logger = new Logger('MAIN');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Servidor HTTP para descargar signals.jsonl desde el browser ──────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.DOWNLOAD_SECRET || 'latency2026';

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sigStats = signal?.getStats() || {};
    const trackerStats = tracker?.getStats() || {};
    res.end(JSON.stringify({
      status: 'ok',
      mode: process.env.DRY_RUN === 'true' ? 'paper' : 'live',
      orderType: process.env.ORDER_TYPE || 'GTC',
      btcTrendFilter: parseInt(process.env.BTC_TREND_FILTER || '0'),
      uptime: process.uptime(),
      btcPrice: sigStats.lastPrice || null,
      polyYes: sigStats.polyYes || null,
      wins: trackerStats.wins || 0,
      losses: trackerStats.losses || 0,
      totalPnL: trackerStats.totalPnL || 0,
      openPositions: trackerStats.openPositions || 0,
      signals: sigStats.signals || 0,
    }));
    return;
  }
  
  if (url.pathname === '/signals' && url.searchParams.get('key') === SECRET) {
    const file = path.join(process.env.DATA_DIR || '/data', 'signals.jsonl');
    if (!fs.existsSync(file)) {
      res.writeHead(404); res.end('No signals file yet'); return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename=signals.jsonl',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  
  if (url.pathname === '/stats' && url.searchParams.get('key') === SECRET) {
    const stats = signalLogger.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats || { message: 'No stats yet' }, null, 2));
    return;
  }
  
  res.writeHead(401); res.end('Unauthorized');
});

httpServer.listen(PORT, () => {
  logger.info(`🌐 HTTP server en puerto ${PORT} — /signals?key=${SECRET} para descargar`);
});

const tracker = new PnLTracker();
const activePositions = new Map();

let lastTradeTime = 0;
const COOLDOWN = 3 * 60 * 1000; // 3 MINUTOS

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY BOT - Versión Final');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE 🔴'}`);
  logger.info(`Cooldown: 3 minutos | Min edge: ${config.MIN_EDGE_PCT}%`);
  logger.info('');
  alertBotStart({ dryRun: config.DRY_RUN });

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const polyWs = new PolymarketWS(); // Fix B: WebSocket en tiempo real

  let cachedMarket = null;
  let nextMarketCache = null;   // FIX A: mercado pre-fetcheado
  let lastPolyPrice = '';
  let preFetchScheduled = false;

  // FIX A: calcular timestamp del próximo mercado de 5 minutos
  function getNextWindowTs() {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = now - (now % 300);
    return currentWindow + 300; // próximo múltiplo de 300s
  }

  // FIX A: pre-fetchear el próximo mercado antes de que el actual cierre
  async function preFetchNextMarket() {
    if (preFetchScheduled) return;
    preFetchScheduled = true;
    const nextTs = getNextWindowTs();
    const msUntilNext = (nextTs * 1000) - Date.now();
    // Pre-fetchear 30s antes del próximo mercado
    const delay = Math.max(0, msUntilNext - 30000);
    logger.info(`[POLY] Pre-fetch próximo mercado en ${Math.round(delay/1000)}s (T-30s antes de apertura)`);
    setTimeout(async () => {
      preFetchScheduled = false;
      const m = await poly.findNextBTCMarket(nextTs);
      if (m) {
        nextMarketCache = m;
        logger.info(`[POLY] ✅ Próximo mercado pre-cacheado: ${m.question}`);
      }
    }, delay);
  }

  async function actualizarPrecioPolymarket() {
    // Si no hay mercado activo, usar el pre-cacheado si está disponible
    if (!cachedMarket?.gammaId) {
      if (nextMarketCache) {
        // Verificar que el próximo mercado ya empezó
        const now = Date.now();
        const marketStart = new Date(nextMarketCache.endDate).getTime() - 300000;
        if (now >= marketStart) {
          cachedMarket = nextMarketCache;
          nextMarketCache = null;
          logger.info(`[POLY] ✅ Mercado pre-cacheado activado: ${cachedMarket.question}`);
          logger.info(`[POLY] yesToken: ${cachedMarket.yesTokenId}`);
          logger.info(`[POLY] noToken: ${cachedMarket.noTokenId}`);
          // Fix B: suscribir al nuevo mercado via WS
          polyWs.unsubscribeAll();
          polyWs.subscribe(cachedMarket.yesTokenId, cachedMarket.noTokenId);
          if (RESEARCH_MODE) {
            marketResearch.startMarket({
              marketId: cachedMarket.conditionId || cachedMarket.gammaId,
              question: cachedMarket.question,
              endDate: cachedMarket.endDate,
              priceAtOpen: signal.getStats()?.lastPrice || 0,
            });
          }
        }
      }
      // Si no hay pre-cache, buscar normalmente
      if (!cachedMarket?.gammaId) {
        const m = await poly.findBTCMarket();
        if (m) {
          cachedMarket = m;
          logger.info(`[POLY] Mercado: ${m.question}`);
          logger.info(`[POLY] yesToken: ${m.yesTokenId}`);
          logger.info(`[POLY] noToken: ${m.noTokenId}`);
          // Fix B: suscribir al WS de Polymarket para precio en tiempo real
          polyWs.unsubscribeAll();
          polyWs.subscribe(m.yesTokenId, m.noTokenId);
          if (RESEARCH_MODE) {
            marketResearch.startMarket({
              marketId: m.conditionId || m.gammaId,
              question: m.question,
              endDate: m.endDate,
              priceAtOpen: signal.getStats()?.lastPrice || 0,
            });
          }
        } else {
          return;
        }
      }
    }

    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${cachedMarket.gammaId}`);
      if (!res.ok) {
        logger.warn(`[POLY] Gamma API error: ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.outcomePrices) {
        const prices = typeof data.outcomePrices === 'string'
          ? JSON.parse(data.outcomePrices)
          : data.outcomePrices;
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (yes >= 0.05 && yes <= 0.95) {
          signal.updatePolyPrice(yes, no);
          const tag = `YES=${yes.toFixed(3)} NO=${no.toFixed(3)}`;
          if (tag !== lastPolyPrice) {
            logger.info(`[POLY] ${tag}`);
            lastPolyPrice = tag;
          }
          if (RESEARCH_MODE && marketResearch.isActive()) {
            marketResearch.recordTick({
              btcPrice: signal.getStats()?.lastPrice,
              polyYes: yes, polyNo: no,
            });
          }
          // FIX A: pre-fetchear próximo mercado cuando quedan ~60s
          const msRestantes = new Date(cachedMarket.endDate).getTime() - Date.now();
          if (msRestantes < 60000 && msRestantes > 0 && !nextMarketCache) {
            preFetchNextMarket();
          }
        } else {
          logger.info(`[POLY] Mercado resuelto (YES=${yes}), activando pre-cache...`);
          if (RESEARCH_MODE && marketResearch.isActive()) {
            marketResearch.closeMarket({
              finalPrice: signal.getStats()?.lastPrice,
              winner: yes >= 0.95 ? 'UP' : 'DOWN',
            });
          }
          cachedMarket = null;
          lastPolyPrice = '';
          preFetchScheduled = false;
        }
      }
    } catch (err) {
      logger.warn(`[POLY] Error actualizando precio: ${err.message}`);
    }
  }

  // Fix B: callback del WS de Polymarket — precio en tiempo real (<50ms)
  polyWs.onPrice((yes, no) => {
    signal.updatePolyPrice(yes, no);
    const tag = `YES=${yes.toFixed(3)} NO=${no.toFixed(3)}`;
    if (tag !== lastPolyPrice) {
      logger.info(`[POLY-WS] ${tag}`);
      lastPolyPrice = tag;
    }
  });

  polyWs.onResolved((winner) => {
    logger.info(`[POLY-WS] Mercado resuelto (${winner}), preparando transición...`);
    cachedMarket = null;
    lastPolyPrice = '';
    preFetchScheduled = false;
    polyWs.unsubscribeAll();
  });

  // Conectar WS de Polymarket en paralelo
  polyWs.connect().catch(err => logger.warn(`Polymarket WS no disponible: ${err.message} — usando HTTP polling`));

  logger.info('[POLY] Obteniendo precio inicial...');
  await actualizarPrecioPolymarket();

  // HTTP polling cada 2s como fallback si el WS falla
  setInterval(actualizarPrecioPolymarket, 2000);

  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  // Historial de precio BTC con timestamp para filtro de tendencia exacto
  const btcPriceHistory = []; // [{price, ts}]
  const BTC_TREND_WINDOW_MS = 60 * 60 * 1000; // 1 hora en ms

  ws.onPrice(async (priceData) => {
    const btcPriceNow = priceData.price || priceData.currentPrice || priceData.lastPrice || 0;
    const nowMs = Date.now();
    if (btcPriceNow > 0) {
      btcPriceHistory.push({ price: btcPriceNow, ts: nowMs });
      // Limpiar entradas más viejas de 1 hora
      while (btcPriceHistory.length > 0 && nowMs - btcPriceHistory[0].ts > BTC_TREND_WINDOW_MS) {
        btcPriceHistory.shift();
      }
    }

    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;
    const MIN_BUFFER = parseInt(process.env.MIN_BUFFER_SIZE || '100');
    if (sig.bufferSize !== undefined && sig.bufferSize < MIN_BUFFER) return; // warmup

    // ─── Filtro de horario ────────────────────────────────────────────
    if (config.TRADING_HOURS_ENABLED) {
      const utcHour = new Date().getUTCHours();
      if (config.TRADING_HOURS_BLOCKED_UTC.includes(utcHour)) {
        return; // hora bloqueada — win rate histórico < 45%
      }
    }

    // ─── Filtro de tendencia BTC ──────────────────────────────────────
    const trendFilter = parseInt(process.env.BTC_TREND_FILTER || '0');
    if (trendFilter > 0 && btcPriceHistory.length > 0) {
      const btcPriceNow = sig.currentPrice || btcPriceHistory[btcPriceHistory.length-1]?.price || 0;
      const oldestEntry = btcPriceHistory[0];
      const ageMinutes = (Date.now() - oldestEntry.ts) / 60000;
      const btcMoveLastHour = btcPriceNow - oldestEntry.price;

      // Loggear estado del historial cada 5 minutos
      if (btcPriceHistory.length % 300 === 1) {
        logger.info(`[TREND] Historial: ${ageMinutes.toFixed(0)}min | BTC move: $${btcMoveLastHour.toFixed(0)} | filtro: $${trendFilter}`);
      }

      // Solo aplicar filtro si tenemos al menos 5 minutos de historial
      if (ageMinutes >= 5) {
        if (btcMoveLastHour > trendFilter && sig.direction === 'DOWN') {
          logger.warn(`[SKIP] 📈 BTC +$${btcMoveLastHour.toFixed(0)} en ${ageMinutes.toFixed(0)}min — bloqueando DOWN`);
          return;
        }
        if (btcMoveLastHour < -trendFilter && sig.direction === 'UP') {
          logger.warn(`[SKIP] 📉 BTC $${btcMoveLastHour.toFixed(0)} en ${ageMinutes.toFixed(0)}min — bloqueando UP`);
          return;
        }
      }
    }

    const now = Date.now();

    if (now - lastTradeTime < COOLDOWN) return;

    // ─── Circuit Breaker ──────────────────────────────────────────────────
    // 3 losses consecutivos → pausa 30 minutos para evitar rachas malas
    const CIRCUIT_BREAKER_LOSSES = parseInt(process.env.CIRCUIT_BREAKER_LOSSES || '3');
    const CIRCUIT_BREAKER_PAUSE_MS = parseInt(process.env.CIRCUIT_BREAKER_PAUSE_MIN || '30') * 60 * 1000;
    const consecLosses = signalLogger.getConsecutiveLosses();
    if (consecLosses >= CIRCUIT_BREAKER_LOSSES) {
      if (!global._lastCircuitBreakTime) global._lastCircuitBreakTime = now;
      const pauseRemaining = Math.max(0, CIRCUIT_BREAKER_PAUSE_MS - (now - global._lastCircuitBreakTime));
      if (pauseRemaining > 0) {
        logger.warn(`[CIRCUIT BREAKER] ${consecLosses} losses seguidos — pausa ${Math.ceil(pauseRemaining/60000)}min restantes`);
        return;
      }
    } else {
      global._lastCircuitBreakTime = null;
    }

    // ✅ LOG DE DIAGNÓSTICO - ver qué pasa con cada señal
    logger.info(`[SIG] ${sig.direction} | Z:${sig.zScore.toFixed(2)} Move:${sig.movePct.toFixed(3)}% | ${sig.edge?.reason} ${sig.edge?.edgePct ?? 'n/a'}%`);

    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < config.MIN_EDGE_PCT || sig.edge.edgePct > 15) return;

    if (activePositions.size >= 1) return; // máximo 1 posición simultánea

    // Fix: bloquear doble entry en el mismo mercado (mismo conditionId)
    // El cooldown de 3min puede expirar mientras el mercado de 5min sigue abierto
    if (cachedMarket?.conditionId) {
      const alreadyInThisMarket = Array.from(activePositions.values())
        .some(p => p.marketId === cachedMarket.conditionId);
      if (alreadyInThisMarket) {
        logger.warn(`[SKIP] Ya hay posición abierta en este mercado — evitando doble entry`);
        return;
      }
    }

    const exposure = config.ORDER_SIZE_USDC;
    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    const maxExposure = Math.min(config.MAX_TOTAL_EXPOSURE_USDC, config.ORDER_SIZE_USDC * 2);
    if (totalExposure + exposure > maxExposure) return;

    if (!cachedMarket?.gammaId) {
      logger.warn('[SKIP] No hay mercado disponible');
      return;
    }

    const marketEnd = new Date(cachedMarket.endDate).getTime();
    const msRestantes = marketEnd - now;
    const segsRestantes = Math.floor(msRestantes / 1000);

    if (msRestantes <= 0) {
      logger.warn(`[SKIP] ⏱️ Mercado YA CERRADO hace ${Math.abs(segsRestantes)}s`);
      cachedMarket = null;
      return;
    }

    const MIN_SECS = parseInt(process.env.MIN_SECONDS_REMAINING || '60');
    if (segsRestantes < MIN_SECS) {
      logger.warn(`[SKIP] ⏱️ Solo ${segsRestantes}s restantes — muy tarde (mín ${MIN_SECS}s)`);
      return;
    }

    // ─── Modo entrada tardía con confirmación (LATE_ENTRY_MODE) ────────
    // Estrategia alternativa: en vez de anticiparse (latency arb clásico),
    // esperar a que la dirección ya esté confirmada dentro del período
    // y el precio del token ya refleje esa convicción (no cerca de 50/50).
    const lateEntryMode = process.env.LATE_ENTRY_MODE === 'true';
    if (lateEntryMode) {
      const maxSecs = parseInt(process.env.MAX_SECONDS_REMAINING || '150');
      if (segsRestantes > maxSecs) {
        logger.info(`[SKIP] 🕐 LATE_ENTRY: ${segsRestantes}s restantes — muy pronto (máx ${maxSecs}s), esperando confirmación`);
        return;
      }
      // Precio del token en la dirección elegida debe reflejar convicción
      const tokenPrice = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
      const minConviction = parseFloat(process.env.LATE_ENTRY_MAX_PRICE || '0.30');
      if (tokenPrice > minConviction) {
        logger.info(`[SKIP] 🕐 LATE_ENTRY: precio $${tokenPrice.toFixed(3)} > $${minConviction} — sin convicción suficiente todavía`);
        return;
      }
      logger.info(`[LATE_ENTRY] ✅ Confirmado: ${segsRestantes}s restantes, precio $${tokenPrice.toFixed(3)} — alta convicción`);
    }

    logger.info(`[TIMING] ✅ ${segsRestantes}s restantes — OK para entrar`);
    logger.info(`  [IND] Imbalance:${sig.imbalance?.toFixed(2)} Spread:${sig.spreadRatio?.toFixed(2)}x Ticks/10s:${sig.tickFreq} RSI:${sig.rsi?.toFixed(1)} Score:${sig.signalScore}`);

    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const priceRaw = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const tokenId = sig.direction === 'UP' ? cachedMarket.yesTokenId : cachedMarket.noTokenId;

    // PRICE_TOLERANCE: acepta fills hasta N ticks arriba del precio detectado
    // Cubre el movimiento de precio entre detección y ejecución (HTTP polling 0-2s)
    // Default 0.02 = 2 ticks — sube fill rate de ~74% a ~90% con mínimo impacto en edge
    const priceTolerance = parseFloat(process.env.PRICE_TOLERANCE || '0.02');
    const price = Math.min(0.97, parseFloat((priceRaw + priceTolerance).toFixed(3)));
    const size = Math.floor(exposure / price);

    logger.info(`[PRICE] Raw: $${priceRaw.toFixed(3)} + tolerance: $${priceTolerance} → orden: $${price.toFixed(3)}`);

    // Fix 1: size check ANTES del Discord alert — no alertar órdenes que no van a ejecutarse
    if (size < 5) {
      logger.warn(`[SKIP] Size ${size} < mínimo 5 tokens de Polymarket (ORDER_SIZE_USDC=$${exposure} muy bajo)`);
      return;
    }

    // Fire-and-forget — no bloquea la ejecución de la orden
    alertTradeSignal({
      direction: sig.direction,
      price,
      edge: sig.edge.edgePct,
      move: sig.movePct,
      zscore: sig.zScore,
      segsRestantes,
      market: cachedMarket,
      size,
      exposure,
    }).catch(e => logger.warn(`Discord alert failed: ${e.message}`));

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure} | Size: ${size} | Token: ${tokenId}`);

    // Cooldown siempre activo — sin excepción
    lastTradeTime = now;
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, { exposure, openTime: now });

    // Registrar señal en volumen persistente
    const utcHour = new Date().getUTCHours();
    const btcPriceAtSignal = sig.currentPrice;
    signalLogger.logSignalOpen({
      posId,
      direction: sig.direction,
      price,
      size,
      market: cachedMarket,
      sig,
      utcHour,
      btcPrice: btcPriceAtSignal,
      // getPolyPrice: usa los precios de la señal (ya disponibles)
      getPolyPrice: (dir) => dir === 'UP' ? sig.edge?.polyYes : sig.edge?.polyNo,
    });

    // BTC snapshot 30s después
    setTimeout(() => {
      signalLogger.logBtcSnapshot30s(posId, btcPriceAtSignal, signal.getStats()?.lastPrice);
    }, 30000);

    // ✅ Ejecutar orden real (solo en LIVE)
    if (!config.DRY_RUN) {
      try {
        const orderResult = await poly.placeLimitOrder({
          marketId: cachedMarket.conditionId,
          tokenId,
          side: 'BUY',
          price,
          size,
          marketQuestion: cachedMarket.question,
        });

        // Fix 2: GTC — verificar fill antes de abrir posición en tracker
        if (!orderResult.success) {
          const reason = orderResult.error === 'gtc_timeout'
            ? `timeout ${config.GTC_TIMEOUT_SECONDS || 60}s sin fill`
            : (orderResult.error || 'sin liquidez');
          logger.warn(`[LIVE] ⚠️ Orden no llenada — ${reason}`);
          // Marcar señal como NO ejecutada en signal logger
          signalLogger.logSignalClose(posId, 'NO_FILL', 0);
          activePositions.delete(posId);
          return;
        }

        const fillMs = orderResult.fillTimeMs || null;
        logger.info(`[LIVE] ✅ Orden llenada (GTC): ${orderResult.orderId} | fill_time: ${fillMs ? fillMs+'ms' : 'instantáneo'}`);

        // Guardar fill_time_ms en signal logger
        if (fillMs !== null) signalLogger.updateFillTime(posId, fillMs);

        // Fix 2: tracker solo se abre DESPUÉS de fill confirmado
        tracker.openPosition({
          marketId: cachedMarket.conditionId,
          gammaId: cachedMarket.gammaId,
          marketQuestion: cachedMarket.question,
          side,
          price,
          size,
          endDate: cachedMarket.endDate,
          posId,
          mode: 'live',  // Fix 4: marcar como live
        });

        setTimeout(() => activePositions.delete(posId), 8 * 60 * 1000);

      } catch (err) {
        logger.error(`[LIVE] ❌ Error: ${err.message}`);
        signalLogger.logSignalClose(posId, 'NO_FILL', 0);
        activePositions.delete(posId);
        return;
      }

    } else {
      // PAPER: simular fill rate realista (GTC no siempre llena)
      const paperFillRate = parseFloat(process.env.PAPER_FILL_RATE || '0.75');
      const filled = Math.random() < paperFillRate;

      if (!filled) {
        logger.warn(`[PAPER] ⚠️ Simulando GTC sin fill (fill rate ${(paperFillRate*100).toFixed(0)}%)`);
        signalLogger.logSignalClose(posId, 'NO_FILL', 0);
        activePositions.delete(posId);
        return;
      }

      tracker.openPosition({
        marketId: cachedMarket.conditionId,
        gammaId: cachedMarket.gammaId,
        marketQuestion: cachedMarket.question,
        side,
        price,
        size,
        endDate: cachedMarket.endDate,
        posId,
        mode: 'paper',
      });

      setTimeout(() => activePositions.delete(posId), 8 * 60 * 1000);
    }
  });

  ws.onError((err) => logger.error(`WS error: ${err.message}`));

  logger.info('Conectando a Coinbase WebSocket...');
  await ws.connect();
  logger.info('✓ Conectado\n');

  // Balance inicial al arrancar
  let initialBalance = null;
  let currentBalance = null;

  poly.getBalance().then(b => {
    if (b !== null) {
      initialBalance = b;
      currentBalance = b;
      logger.info(`💰 Balance inicial Polymarket: $${b} USDC`);
    }
  }).catch(() => {});

  setInterval(async () => {
    const stats = tracker.getSummary();
    const sigStats = signal.getStats();

    // Actualizar balance real cada 5 minutos
    if (!config.DRY_RUN) {
      const bal = await poly.getBalance().catch(() => null);
      if (bal !== null) currentBalance = bal;
    }

    const pnlReal = (currentBalance !== null && initialBalance !== null)
      ? (currentBalance - initialBalance).toFixed(2)
      : 'n/a';
    const pnlSign = parseFloat(pnlReal) >= 0 ? '+' : '';

    // Mostrar stats del volumen si hay datos
    const volStats = signalLogger.getStats();
    if (volStats && volStats.closedTrades >= 5) {
      logger.info(`  📊 Stats volumen: ${volStats.closedTrades} trades | WR: ${volStats.winRate} | P&L: $${volStats.totalPnL}`);
    }
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${sigStats.signals} | BTC: $${sigStats.lastPrice?.toFixed(2) ?? 'n/a'}`);
    logger.info(`  Poly YES: ${sigStats.polyYes ?? 'n/a'} | Poly age: ${sigStats.polyAge}`);
    logger.info(`  Active slots: ${activePositions.size}/10`);
    logger.info(`  Cooldown: ${Math.max(0, Math.ceil((lastTradeTime + COOLDOWN - Date.now()) / 1000))}s`);
    logger.info('');
    logger.info('=== BALANCE REAL ===');
    if (config.DRY_RUN) {
      const s = tracker.getSummary();
      const paperPnL = parseFloat((s.totalPnL ?? '0').replace('+','').replace('$','')) || 0;
      const paperBalance = (parseFloat(process.env.PAPER_CAPITAL || '25') + paperPnL).toFixed(2);
      const sign = paperPnL >= 0 ? '+' : '';
      logger.info(`  📋 PAPER TRADING (capital inicial: $${process.env.PAPER_CAPITAL || '25'})`);
      logger.info(`  💰 Balance simulado: $${paperBalance} USDC`);
      logger.info(`  📈 P&L simulado: ${sign}$${paperPnL.toFixed(2)}`);
      logger.info(`  Trades W:${s.wins} L:${s.losses} | Win Rate: ${s.winRate}`);
    } else {
      logger.info(`  💰 Balance: $${currentBalance ?? 'consultando...'} USDC`);
      logger.info(`  📈 P&L sesión: ${pnlSign}$${pnlReal}`);
      logger.info(`  Trades W:${stats.wins} L:${stats.losses} | Win Rate: ${stats.winRate}`);
    }
    logger.info('─'.repeat(60));
  }, 5 * 60 * 1000);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
