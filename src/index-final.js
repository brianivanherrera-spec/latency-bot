/**
 * LATENCY BOT - VERSIÓN FINAL
 * ✅ SignalEngine + PnLTracker + Cooldown + Live orders + Diagnóstico
 */

const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');
const { alertTradeSignal, alertBotStart } = require('./alerts');
const signalLogger = require('./signal-logger');

const logger = new Logger('MAIN');

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

  let cachedMarket = null;
  let lastPolyPrice = '';

  async function actualizarPrecioPolymarket() {
    if (!cachedMarket?.gammaId) {
      const m = await poly.findBTCMarket();
      if (m) {
        cachedMarket = m;
        logger.info(`[POLY] Mercado: ${m.question}`);
        logger.info(`[POLY] yesToken: ${m.yesTokenId}`);
        logger.info(`[POLY] noToken: ${m.noTokenId}`);
      } else {
        return;
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
        } else {
          logger.info(`[POLY] Mercado resuelto (YES=${yes}), buscando nuevo...`);
          cachedMarket = null;
          lastPolyPrice = '';
        }
      }
    } catch (err) {
      logger.warn(`[POLY] Error actualizando precio: ${err.message}`);
    }
  }

  logger.info('[POLY] Obteniendo precio inicial...');
  await actualizarPrecioPolymarket();

  setInterval(actualizarPrecioPolymarket, 2000);

  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  ws.onPrice(async (priceData) => {
    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;
    if (sig.bufferSize !== undefined && sig.bufferSize < 200) return; // warmup

    // ─── Filtro de horario ────────────────────────────────────────────
    // Basado en backtest de 2531 mercados: algunas horas tienen <45% win rate
    if (config.TRADING_HOURS_ENABLED) {
      const utcHour = new Date().getUTCHours();
      if (config.TRADING_HOURS_BLOCKED_UTC.includes(utcHour)) {
        return; // hora bloqueada — win rate histórico < 45%
      }
    }

    const now = Date.now();

    if (now - lastTradeTime < COOLDOWN) return;

    // ✅ LOG DE DIAGNÓSTICO - ver qué pasa con cada señal
    logger.info(`[SIG] ${sig.direction} | Z:${sig.zScore.toFixed(2)} Move:${sig.movePct.toFixed(3)}% | ${sig.edge?.reason} ${sig.edge?.edgePct ?? 'n/a'}%`);

    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < config.MIN_EDGE_PCT || sig.edge.edgePct > 15) return;

    if (activePositions.size >= 10) return;

    const exposure = config.ORDER_SIZE_USDC;
    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    if (totalExposure + exposure > config.MAX_TOTAL_EXPOSURE_USDC) return;

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

    if (segsRestantes < 90) {
      logger.warn(`[SKIP] ⏱️ Solo ${segsRestantes}s restantes — muy tarde`);
      return;
    }

    logger.info(`[TIMING] ✅ ${segsRestantes}s restantes — OK para entrar`);
    logger.info(`  [IND] Imbalance:${sig.imbalance?.toFixed(2)} Spread:${sig.spreadRatio?.toFixed(2)}x Ticks/10s:${sig.tickFreq} RSI:${sig.rsi?.toFixed(1)}`);

    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const price = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const tokenId = sig.direction === 'UP' ? cachedMarket.yesTokenId : cachedMarket.noTokenId;
    const size = Math.floor(exposure / price);

    // Registrar señal en volumen persistente
    const utcHour = new Date().getUTCHours();
    signalLogger.logSignalOpen({ posId, direction: sig.direction, price, size, market: cachedMarket, sig, utcHour });

    // 🔔 Alerta Discord para trade manual
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
    });

    if (size < 1) {
      logger.warn('[SKIP] Size < 1');
      return;
    }

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure} | Size: ${size} | Token: ${tokenId}`);

    // ✅ Actualizar cooldown ANTES de ejecutar
    lastTradeTime = now;
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, { exposure, openTime: now });

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

        if (!orderResult.success) {
          logger.error(`[LIVE] ❌ Orden fallida: ${orderResult.error}`);
          activePositions.delete(posId);
          return;
        }

        // Verificar si la orden se llenó (matched) o quedó pendiente (live)
        if (orderResult.status === 'live') {
          logger.warn(`[LIVE] ⚠️ Orden en libro, no llenada aún: ${orderResult.orderId}`);
          logger.warn(`[LIVE] No registramos posición hasta confirmar llenado`);
          activePositions.delete(posId);
          return;
        }

        logger.info(`[LIVE] ✅ Orden llenada (matched): ${orderResult.orderId}`);

      } catch (err) {
        logger.error(`[LIVE] ❌ Error: ${err.message}`);
        activePositions.delete(posId);
        return;
      }
    }

    tracker.openPosition({
      marketId: cachedMarket.conditionId,
      gammaId: cachedMarket.gammaId,
      marketQuestion: cachedMarket.question,
      side,
      price,
      size,
      endDate: cachedMarket.endDate,
    });

    setTimeout(() => activePositions.delete(posId), 8 * 60 * 1000);
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
