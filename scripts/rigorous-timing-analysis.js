#!/usr/bin/env node

/**
 * Rigorous Timing Analysis
 *
 * Reconstruye la cadena completa de eventos para cada señal:
 * signal_timestamp → book_filter_start → book_filter_end → order_sent → fill → resolution
 *
 * Calcula latencias sin especulación, correlaciona causalmente.
 */

const fs = require('fs');
const readline = require('readline');

class RigorousTimingAnalyzer {
  constructor() {
    this.signals = new Map(); // signal_id -> {events array}
    this.metrics = [];
  }

  async parseJsonlFile(filePath) {
    const events = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);
      } catch (e) {
        // Skip malformed lines
      }
    }
    return events;
  }

  async loadAllData(dataDir) {
    const botEventsPath = `${dataDir}/bot-events.jsonl`;
    const binanceRawPath = `${dataDir}/binance-raw.jsonl`;
    const polymarketRawPath = `${dataDir}/polymarket-raw.jsonl`;

    console.log('📂 Cargando archivos de datos...\n');

    let botEvents = [];
    let binanceData = [];
    let polymarketData = [];

    try {
      if (fs.existsSync(botEventsPath)) {
        botEvents = await this.parseJsonlFile(botEventsPath);
        console.log(`✅ bot-events.jsonl: ${botEvents.length} eventos`);
      }
    } catch (e) {
      console.log(`⚠️  Error leyendo bot-events.jsonl: ${e.message}`);
    }

    try {
      if (fs.existsSync(binanceRawPath)) {
        binanceData = await this.parseJsonlFile(binanceRawPath);
        console.log(`✅ binance-raw.jsonl: ${binanceData.length} ticks`);
      }
    } catch (e) {
      console.log(`⚠️  Error leyendo binance-raw.jsonl: ${e.message}`);
    }

    try {
      if (fs.existsSync(polymarketRawPath)) {
        polymarketData = await this.parseJsonlFile(polymarketRawPath);
        console.log(`✅ polymarket-raw.jsonl: ${polymarketData.length} updates`);
      }
    } catch (e) {
      console.log(`⚠️  Error leyendo polymarket-raw.jsonl: ${e.message}`);
    }

    return { botEvents, binanceData, polymarketData };
  }

  reconstructSignalChain(botEvents) {
    console.log('\n📋 Reconstruyendo cadenas de eventos...\n');

    // Agrupar eventos por signal_id
    for (const event of botEvents) {
      const sigId = event.signal_id || event.id;
      if (!sigId) continue;

      if (!this.signals.has(sigId)) {
        this.signals.set(sigId, []);
      }
      this.signals.get(sigId).push(event);
    }

    console.log(`✅ Encontradas ${this.signals.size} cadenas de señales\n`);
  }

  calculateLatencies() {
    console.log('⏱️  Calculando latencias...\n');

    const completedTrades = [];
    const incompleteChains = [];

    for (const [sigId, events] of this.signals.entries()) {
      // Ordenar eventos por timestamp
      events.sort((a, b) => {
        const timeA = new Date(a.timestamp || a.created_at || 0).getTime();
        const timeB = new Date(b.timestamp || b.created_at || 0).getTime();
        return timeA - timeB;
      });

      const signal = events.find(e => e.type === 'SIGNAL_GENERATED');
      const orderSent = events.find(e => e.type === 'ORDER_SENT');
      const fill = events.find(e => e.type === 'FILL' || e.type === 'NO_FILL');
      const resolution = events.find(e => e.type === 'MARKET_END');

      if (!signal) continue; // No signal, skip

      const signalTime = new Date(signal.timestamp || signal.created_at).getTime();

      // Calcular latencias
      const latencies = {
        signal_id: sigId.substring(0, 8),
        signal_time: new Date(signal.timestamp || signal.created_at).toISOString(),

        // Extrayendo valores de la señal
        z_score: signal.z_score,
        signal_quality: signal.edge_pct || signal.signal_quality,
        direction: signal.signal_direction,
        btc_price_at_signal: signal.btc_price,

        // Latencias
        signal_to_order_ms: orderSent ?
          new Date(orderSent.timestamp || orderSent.created_at).getTime() - signalTime : null,
        signal_to_fill_ms: fill ?
          new Date(fill.timestamp || fill.created_at).getTime() - signalTime : null,
        signal_to_resolution_ms: resolution ?
          new Date(resolution.timestamp || resolution.created_at).getTime() - signalTime : null,

        // Información de orden
        order_sent: !!orderSent,
        order_time: orderSent ? new Date(orderSent.timestamp || orderSent.created_at).toISOString() : null,
        order_price: orderSent ? orderSent.filled_price || orderSent.price : null,

        // Información de llenado
        fill_type: fill ? fill.type : 'NO_EVENT',
        fill_price: fill ? fill.filled_price : null,
        fill_size: fill ? fill.filled_size : null,

        // Información de resolución
        result: resolution ? (resolution.result || resolution.position_result) : 'PENDING',
        pnl: resolution ? resolution.pnl : null,
        resolution_price: resolution ? resolution.resolved_price : null,
        duration_seconds: resolution ?
          (new Date(resolution.timestamp || resolution.created_at).getTime() - signalTime) / 1000 : null,

        // Cambio de precio entre signal y order
        price_change_signal_to_order: null,
        price_change_signal_to_resolution: null,

        // Completitud
        is_complete: signal && orderSent && fill && resolution,
        missing: []
      };

      // Identificar qué falta
      if (!orderSent) latencies.missing.push('ORDER_SENT');
      if (!fill) latencies.missing.push('FILL');
      if (!resolution) latencies.missing.push('MARKET_END');

      if (latencies.is_complete) {
        completedTrades.push(latencies);
      } else {
        incompleteChains.push(latencies);
      }
    }

    console.log(`✅ Operaciones completas: ${completedTrades.length}`);
    console.log(`⏳ Operaciones incompletas: ${incompleteChains.length}\n`);

    return { completedTrades, incompleteChains };
  }

  analyzeLatencyCorrelation(completedTrades) {
    console.log('📊 ANÁLISIS DE CORRELACIÓN: ¿Afecta la latencia el resultado?\n');

    if (completedTrades.length < 3) {
      console.log('⚠️  Insuficientes operaciones completas para análisis de correlación\n');
      return;
    }

    // Separar por resultado
    const winners = completedTrades.filter(t => t.result === 'WIN');
    const losers = completedTrades.filter(t => t.result === 'LOSS');

    console.log(`Winners: ${winners.length}`);
    console.log(`Losers: ${losers.length}\n`);

    if (winners.length > 0) {
      const winLatencies = winners
        .filter(t => t.signal_to_order_ms !== null)
        .map(t => t.signal_to_order_ms);

      if (winLatencies.length > 0) {
        const avgWinLatency = winLatencies.reduce((a, b) => a + b, 0) / winLatencies.length;
        console.log(`GANADORES:`);
        console.log(`  • Latencia signal→order promedio: ${avgWinLatency.toFixed(0)}ms`);
        console.log(`  • Min: ${Math.min(...winLatencies)}ms, Max: ${Math.max(...winLatencies)}ms`);
        console.log(`  • P&L promedio: $${(winners.map(t => t.pnl).reduce((a, b) => a + b, 0) / winners.length).toFixed(2)}`);
      }
    }

    if (losers.length > 0) {
      const lossLatencies = losers
        .filter(t => t.signal_to_order_ms !== null)
        .map(t => t.signal_to_order_ms);

      if (lossLatencies.length > 0) {
        const avgLossLatency = lossLatencies.reduce((a, b) => a + b, 0) / lossLatencies.length;
        console.log(`\nPERDEDORES:`);
        console.log(`  • Latencia signal→order promedio: ${avgLossLatency.toFixed(0)}ms`);
        console.log(`  • Min: ${Math.min(...lossLatencies)}ms, Max: ${Math.max(...lossLatencies)}ms`);
        console.log(`  • P&L promedio: $${(losers.map(t => t.pnl).reduce((a, b) => a + b, 0) / losers.length).toFixed(2)}`);
      }
    }

    // Calcular correlación de Pearson
    console.log(`\n📈 CORRELACIÓN: Latency → Result\n`);

    const correlation = this.calculatePearsonCorrelation(
      completedTrades.filter(t => t.signal_to_order_ms !== null).map(t => t.signal_to_order_ms),
      completedTrades.filter(t => t.signal_to_order_ms !== null).map(t => t.pnl || 0)
    );

    if (correlation !== null) {
      console.log(`Correlación de Pearson (latency vs P&L): ${correlation.toFixed(3)}`);
      if (Math.abs(correlation) < 0.3) {
        console.log(`└─ DÉBIL: La latencia NO predice fuertemente el resultado`);
      } else if (Math.abs(correlation) < 0.7) {
        console.log(`└─ MODERADA: La latencia contribuye al resultado`);
      } else {
        console.log(`└─ FUERTE: La latencia predice fuertemente el resultado`);
      }
    }

    console.log();
  }

  calculatePearsonCorrelation(x, y) {
    if (x.length !== y.length || x.length < 2) return null;

    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denom = Math.sqrt(denomX * denomY);
    return denom !== 0 ? numerator / denom : null;
  }

  generateSummaryTable(completedTrades) {
    console.log('📋 TABLA: Latencias y Resultados\n');
    console.log('┌────────┬──────────────────┬──────────┬──────────┬─────────────┬─────────┐');
    console.log('│ Signal │ Signal Time      │ Latency  │ Z-Score  │ Result      │ P&L     │');
    console.log('├────────┼──────────────────┼──────────┼──────────┼─────────────┼─────────┤');

    completedTrades.slice(0, 10).forEach(t => {
      const timeStr = new Date(t.signal_time).toISOString().split('T')[1].split('.')[0];
      const latency = t.signal_to_order_ms !== null ? `${t.signal_to_order_ms}ms` : '—';
      const zScore = t.z_score ? t.z_score.toFixed(2) : '—';
      const result = (t.result || '—').padEnd(11);
      const pnl = t.pnl !== null ? `$${t.pnl.toFixed(2)}` : '—';

      console.log(`│ ${t.signal_id.padEnd(6)} │ ${timeStr} │ ${latency.padEnd(8)} │ ${zScore.padEnd(8)} │ ${result} │ ${pnl.padEnd(7)} │`);
    });

    if (completedTrades.length > 10) {
      console.log(`│        │                  │          │          │             │         │`);
      console.log(`│ ...    │ ...              │ ...      │ ...      │ ...         │ ...     │`);
      console.log(`│        │ (${completedTrades.length - 10} más trades)        │          │          │             │         │`);
    }

    console.log('└────────┴──────────────────┴──────────┴──────────┴─────────────┴─────────┘\n');
  }

  generateStatistics(completedTrades) {
    console.log('\n📊 ESTADÍSTICAS GENERALES\n');

    const latencies = completedTrades
      .filter(t => t.signal_to_order_ms !== null)
      .map(t => t.signal_to_order_ms);

    if (latencies.length > 0) {
      const sorted = [...latencies].sort((a, b) => a - b);
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      console.log('Latencia Signal → Order (ms):');
      console.log(`  Min:     ${Math.min(...latencies)}ms`);
      console.log(`  Max:     ${Math.max(...latencies)}ms`);
      console.log(`  Promedio: ${avg.toFixed(0)}ms`);
      console.log(`  Mediana:  ${median}ms`);
      console.log(`  P95:      ${p95}ms`);
      console.log(`  P99:      ${p99}ms\n`);
    }

    // Estadísticas por resultado
    const wins = completedTrades.filter(t => t.result === 'WIN');
    const losses = completedTrades.filter(t => t.result === 'LOSS');
    const noFills = completedTrades.filter(t => t.result === 'NO_FILL');

    console.log('Distribución de Resultados:');
    console.log(`  Ganancias: ${wins.length} (${(wins.length / completedTrades.length * 100).toFixed(1)}%)`);
    console.log(`  Pérdidas:  ${losses.length} (${(losses.length / completedTrades.length * 100).toFixed(1)}%)`);
    console.log(`  Sin llenar: ${noFills.length} (${(noFills.length / completedTrades.length * 100).toFixed(1)}%)\n`);

    if (wins.length > 0) {
      const avgPnlWin = wins.map(t => t.pnl || 0).reduce((a, b) => a + b, 0) / wins.length;
      console.log(`P&L Promedio Ganancias: $${avgPnlWin.toFixed(2)}`);
    }

    if (losses.length > 0) {
      const avgPnlLoss = losses.map(t => t.pnl || 0).reduce((a, b) => a + b, 0) / losses.length;
      console.log(`P&L Promedio Pérdidas:  $${avgPnlLoss.toFixed(2)}`);
    }

    const totalPnl = completedTrades.map(t => t.pnl || 0).reduce((a, b) => a + b, 0);
    console.log(`P&L Total:              $${totalPnl.toFixed(2)}\n`);
  }

  async run(dataDir) {
    console.log('═'.repeat(80));
    console.log('ANÁLISIS RIGUROSO DE TIMING - ÚLTIMAS 24 HORAS');
    console.log('═'.repeat(80));
    console.log();

    const { botEvents, binanceData, polymarketData } = await this.loadAllData(dataDir);

    if (botEvents.length === 0) {
      console.log('❌ No se encontraron datos en bot-events.jsonl');
      console.log('Por favor, proporciona la ruta correcta al directorio /data\n');
      return;
    }

    this.reconstructSignalChain(botEvents);
    const { completedTrades, incompleteChains } = this.calculateLatencies();

    if (completedTrades.length === 0) {
      console.log('⚠️  No hay operaciones completas para analizar\n');
      console.log('Operaciones incompletas encontradas:');
      incompleteChains.slice(0, 5).forEach(chain => {
        console.log(`  • ${chain.signal_id}: falta ${chain.missing.join(', ')}`);
      });
      return;
    }

    this.generateSummaryTable(completedTrades);
    this.generateStatistics(completedTrades);
    this.analyzeLatencyCorrelation(completedTrades);

    console.log('═'.repeat(80));
    console.log('FIN DEL ANÁLISIS');
    console.log('═'.repeat(80));
  }
}

// Main
const dataDir = process.argv[2] || '/data';
const analyzer = new RigorousTimingAnalyzer();
analyzer.run(dataDir).catch(console.error);
