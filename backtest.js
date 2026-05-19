/**
 * BACKTEST — Análisis histórico de mercados BTC 5min de Polymarket
 *
 * Descarga todos los mercados BTC Up/Down 5min de los últimos 30 días,
 * busca el precio de BTC en Coinbase para cada ventana, y calcula
 * qué parámetros hubieran dado el mejor win rate.
 *
 * Uso: node backtest.js
 * Output: backtest_results.json + resumen en consola
 */

const fs = require('fs');

const GAMMA_API   = 'https://gamma-api.polymarket.com';
const COINBASE_API = 'https://api.exchange.coinbase.com';
const DAYS_BACK   = 30;
const OUTPUT_FILE = 'backtest_results.json';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// ─── Coinbase: precio de BTC en un timestamp específico ─────────────────────

async function getBTCPriceAt(timestamp, windowSecs = 300) {
  // Coinbase candles API: /products/BTC-USD/candles
  // granularity 60 = velas de 1 minuto
  const start = new Date(timestamp - windowSecs * 1000).toISOString();
  const end   = new Date(timestamp + windowSecs * 1000).toISOString();
  const url = `${COINBASE_API}/products/BTC-USD/candles?granularity=60&start=${start}&end=${end}`;

  try {
    const data = await fetchJSON(url);
    // Coinbase devuelve [timestamp, low, high, open, close, volume]
    if (!data?.length) return null;
    // La vela más cercana al timestamp pedido
    const target = timestamp / 1000;
    const closest = data.reduce((best, candle) => {
      return Math.abs(candle[0] - target) < Math.abs(best[0] - target) ? candle : best;
    });
    return { open: closest[3], close: closest[4], high: closest[2], low: closest[1], volume: closest[5] };
  } catch (e) {
    return null;
  }
}

// ─── Polymarket: mercados BTC 5min históricos ────────────────────────────────

async function fetchBTCMarkets() {
  const markets = [];
  const now = Date.now();
  const cutoff = now - DAYS_BACK * 24 * 60 * 60 * 1000;

  console.log(`Descargando mercados BTC 5min de los últimos ${DAYS_BACK} días...`);

  let offset = 0;
  const limit = 100;
  let totalFetched = 0;

  while (true) {
    const url = `${GAMMA_API}/markets?slug_contains=btc-updown-5m&limit=${limit}&offset=${offset}&closed=true&order=startDate&ascending=false`;

    let data;
    try {
      data = await fetchJSON(url);
    } catch (e) {
      console.log(`Error fetching markets at offset ${offset}: ${e.message}`);
      break;
    }

    const batch = Array.isArray(data) ? data : (data.markets || data.data || []);
    if (!batch.length) break;

    for (const m of batch) {
      const startTs = new Date(m.startDate || m.startDateIso).getTime();
      if (startTs < cutoff) {
        console.log(`Llegamos al límite de ${DAYS_BACK} días (${new Date(startTs).toLocaleDateString()})`);
        return markets;
      }

      const outcomePrices = m.outcomePrices
        ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)
        : null;

      if (!outcomePrices) continue;

      const yesPrice = parseFloat(outcomePrices[0]);
      const noPrice  = parseFloat(outcomePrices[1]);

      // Determinar resultado: YES ganó si YES=1, NO ganó si NO=1
      let result = null;
      if (yesPrice > 0.95) result = 'YES';
      else if (noPrice > 0.95) result = 'NO';
      else continue; // mercado no resuelto todavía

      markets.push({
        slug:      m.slug || m.marketSlug,
        question:  m.question,
        startDate: m.startDate || m.startDateIso,
        endDate:   m.endDate   || m.endDateIso,
        startTs,
        endTs:     new Date(m.endDate || m.endDateIso).getTime(),
        result,    // 'YES' o 'NO' (BTC subió o bajó)
        volume:    parseFloat(m.volume || 0),
      });
    }

    totalFetched += batch.length;
    console.log(`  Procesados: ${totalFetched} | Válidos: ${markets.length}`);
    offset += limit;
    await sleep(200); // rate limit gentil
  }

  return markets;
}

// ─── Backtesting: simular señales sobre datos históricos ─────────────────────

function calcZScore(prices) {
  const n = prices.length;
  const mean = prices.reduce((a, b) => a + b, 0) / n;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  return stdDev === 0 ? 0 : (prices[prices.length - 1] - mean) / stdDev;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const recent = prices.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function simulateTrade(openPrice, closePrice, direction) {
  // direction: 'UP' = apostamos YES, 'DOWN' = apostamos NO
  const btcWentUp = closePrice > openPrice;
  if (direction === 'UP') return btcWentUp ? 'WIN' : 'LOSS';
  if (direction === 'DOWN') return !btcWentUp ? 'WIN' : 'LOSS';
  return null;
}

async function runBacktest(markets) {
  console.log(`\nCorriendo backtest sobre ${markets.length} mercados...`);

  const results = [];
  let processed = 0;

  for (const market of markets) {
    // Obtener velas de BTC para la ventana del mercado
    // Miramos 5 minutos ANTES del mercado (señal de entrada)
    const signalTime  = market.startTs;
    const openCandle  = await getBTCPriceAt(signalTime, 300);
    const closeCandle = await getBTCPriceAt(market.endTs, 60);

    if (!openCandle || !closeCandle) {
      await sleep(100);
      continue;
    }

    const openPrice  = openCandle.open;
    const closePrice = closeCandle.close;

    // Simular ventana de precios pre-mercado (últimos 5 min antes del inicio)
    // Usamos high/low/open de las velas previas como proxy del buffer
    const priceBuffer = [
      openCandle.open,
      openCandle.low,
      openCandle.high,
      openCandle.close,
    ];

    const movePct = ((closePrice - openPrice) / openPrice) * 100;
    const rsi = calcRSI(priceBuffer, Math.min(14, priceBuffer.length - 1));
    const volume = openCandle.volume;

    // La dirección real del mercado
    const actualDirection = market.result === 'YES' ? 'UP' : 'DOWN';

    results.push({
      date:            new Date(market.startTs).toISOString(),
      slug:            market.slug,
      openPrice,
      closePrice,
      movePct:         parseFloat(movePct.toFixed(4)),
      actualDirection, // qué pasó realmente
      result:          market.result,
      volume,
      rsi:             parseFloat(rsi.toFixed(1)),
      // Para cada combinación de parámetros, calculamos si hubiéramos ganado
    });

    processed++;
    if (processed % 10 === 0) {
      console.log(`  ${processed}/${markets.length} procesados...`);
      await sleep(300); // respetar rate limit de Coinbase
    }
  }

  return results;
}

// ─── Análisis: encontrar parámetros óptimos ──────────────────────────────────

function analyzeResults(results) {
  console.log(`\nAnalizando ${results.length} mercados con datos completos...`);

  // 1. Win rate general si apostamos SIEMPRE DOWN
  const alwaysDown = results.map(r => r.actualDirection === 'DOWN' ? 'WIN' : 'LOSS');
  const alwaysDownWR = alwaysDown.filter(r => r === 'WIN').length / alwaysDown.length * 100;

  // 2. Win rate si apostamos SIEMPRE UP
  const alwaysUp = results.map(r => r.actualDirection === 'UP' ? 'WIN' : 'LOSS');
  const alwaysUpWR = alwaysUp.filter(r => r === 'WIN').length / alwaysUp.length * 100;

  // 3. Distribución de movePct
  const moves = results.map(r => r.movePct).sort((a, b) => a - b);
  const avgMove = moves.reduce((a, b) => a + b, 0) / moves.length;

  // 4. Win rate por hora del día
  const byHour = {};
  for (const r of results) {
    const hour = new Date(r.date).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { wins: 0, total: 0 };
    byHour[hour].total++;
    if (r.actualDirection === 'DOWN') byHour[hour].wins++; // "win" si apostamos always DOWN
  }

  // 5. Win rate por magnitud de movimiento
  const byMagnitude = {
    'small (<0.02%)':   { wins: 0, total: 0 },
    'medium (0.02-0.05%)': { wins: 0, total: 0 },
    'large (>0.05%)':  { wins: 0, total: 0 },
  };
  for (const r of results) {
    const absMov = Math.abs(r.movePct);
    const won = r.actualDirection === 'DOWN';
    let bucket;
    if (absMov < 0.02) bucket = 'small (<0.02%)';
    else if (absMov < 0.05) bucket = 'medium (0.02-0.05%)';
    else bucket = 'large (>0.05%)';
    byMagnitude[bucket].total++;
    if (won) byMagnitude[bucket].wins++;
  }

  // 6. Correlación: si BTC bajó en los 5min previos, ¿sigue bajando?
  const momentum = results.filter(r => r.movePct < -0.02);
  const momentumWR = momentum.filter(r => r.actualDirection === 'DOWN').length / momentum.length * 100;

  const reversal = results.filter(r => r.movePct > 0.02);
  const reversalWR = reversal.filter(r => r.actualDirection === 'DOWN').length / reversal.length * 100;

  return {
    totalMarkets: results.length,
    alwaysDownWinRate: parseFloat(alwaysDownWR.toFixed(1)),
    alwaysUpWinRate:   parseFloat(alwaysUpWR.toFixed(1)),
    avgMovePct:        parseFloat(avgMove.toFixed(4)),
    momentumContinuation: {
      description: 'Si BTC bajó >0.02% en ventana, ¿siguió bajando?',
      markets: momentum.length,
      winRate: parseFloat(momentumWR.toFixed(1)),
    },
    reversalRate: {
      description: 'Si BTC subió >0.02% en ventana, ¿bajó después?',
      markets: reversal.length,
      winRate: parseFloat(reversalWR.toFixed(1)),
    },
    byHour: Object.fromEntries(
      Object.entries(byHour)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([h, d]) => [h, {
          winRate: parseFloat((d.wins / d.total * 100).toFixed(1)),
          markets: d.total,
        }])
    ),
    byMagnitude: Object.fromEntries(
      Object.entries(byMagnitude).map(([k, d]) => [k, {
        winRate: d.total ? parseFloat((d.wins / d.total * 100).toFixed(1)) : 0,
        markets: d.total,
      }])
    ),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  BACKTEST — Mercados BTC 5min Polymarket');
  console.log(`  Período: últimos ${DAYS_BACK} días`);
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Descargar mercados
  const markets = await fetchBTCMarkets();
  console.log(`\nTotal mercados válidos: ${markets.length}`);

  if (!markets.length) {
    console.log('No se encontraron mercados. Verificá la API.');
    return;
  }

  // 2. Enriquecer con datos de BTC
  const results = await runBacktest(markets);

  // 3. Analizar
  const analysis = analyzeResults(results);

  // 4. Guardar resultados
  const output = { analysis, rawData: results, generatedAt: new Date().toISOString() };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // 5. Mostrar resumen
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RESULTADOS');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mercados analizados: ${analysis.totalMarkets}`);
  console.log(`  Win rate apostando SIEMPRE DOWN: ${analysis.alwaysDownWinRate}%`);
  console.log(`  Win rate apostando SIEMPRE UP:   ${analysis.alwaysUpWinRate}%`);
  console.log(`  Movimiento promedio por ventana:  ${analysis.avgMovePct}%`);
  console.log('');
  console.log(`  Momentum (BTC bajó → siguió bajando): ${analysis.momentumContinuation.winRate}% (n=${analysis.momentumContinuation.markets})`);
  console.log(`  Reversión (BTC subió → después bajó): ${analysis.reversalRate.winRate}% (n=${analysis.reversalRate.markets})`);
  console.log('');
  console.log('  Win rate por hora UTC:');
  for (const [h, d] of Object.entries(analysis.byHour)) {
    const bar = '█'.repeat(Math.round(d.winRate / 5));
    console.log(`    ${h.padStart(2,'0')}h: ${d.winRate}% ${bar} (${d.markets} mercados)`);
  }
  console.log('');
  console.log('  Win rate por magnitud de movimiento:');
  for (const [k, d] of Object.entries(analysis.byMagnitude)) {
    console.log(`    ${k}: ${d.winRate}% (${d.markets} mercados)`);
  }
  console.log('');
  console.log(`  Resultados completos guardados en: ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════');
}

main().catch(console.error);
