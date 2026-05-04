#!/usr/bin/env node

/**
 * Quick Log Analysis - Análisis rápido de logs del bot
 * 
 * Uso: node analyze-now.js [archivo.log]
 */

const fs = require('fs');

function analyzeLogs(logFile) {
  console.log(`\n📊 Analizando: ${logFile}\n`);

  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n');

  const data = {
    trades: { wins: 0, losses: 0, open: 0 },
    signals: 0,
    edges: [],
    latencies: [],
    stale: 0,
    errors: 0,
  };

  lines.forEach(line => {
    // Posiciones abiertas
    if (line.includes('Posicion abierta:')) {
      data.trades.open++;
    }

    // Posiciones cerradas
    if (line.includes('Posicion cerrada:')) {
      data.trades.open--;
      const pnlMatch = line.match(/P&L: \$([-\d.]+)/);
      if (pnlMatch) {
        const pnl = parseFloat(pnlMatch[1]);
        if (pnl > 0) data.trades.wins++;
        else if (pnl < 0) data.trades.losses++;
      }
    }

    // Señales
    if (line.includes('[SIGNAL]')) {
      data.signals++;
    }

    // Edges
    if (line.includes('edgePct=')) {
      const match = line.match(/edgePct=([\d.]+)%/);
      if (match) data.edges.push(parseFloat(match[1]));
    }

    // Latencia
    if (line.includes('Age=') && line.includes('ms')) {
      const match = line.match(/Age=(\d+)ms/);
      if (match) data.latencies.push(parseInt(match[1]));
    }

    // Stale
    if (line.includes('POLY_PRICE_STALE')) {
      data.stale++;
    }

    // Errores
    if (line.includes('[ERROR]') || line.includes('❌')) {
      data.errors++;
    }
  });

  // Calcular métricas
  const totalTrades = data.trades.wins + data.trades.losses;
  const winRate = totalTrades > 0 ? (data.trades.wins / totalTrades * 100) : 0;
  
  const avgEdge = data.edges.length > 0
    ? data.edges.reduce((a, b) => a + b, 0) / data.edges.length
    : 0;
  
  const maxEdge = data.edges.length > 0 ? Math.max(...data.edges) : 0;
  
  const avgLatency = data.latencies.length > 0
    ? data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length
    : 0;

  const stalePercent = data.signals > 0 ? (data.stale / data.signals * 100) : 0;

  // Reporte
  console.log('═'.repeat(60));
  console.log('📈 RESUMEN RÁPIDO');
  console.log('═'.repeat(60));
  console.log('');

  console.log('🎯 TRADES:');
  console.log(`  Total: ${totalTrades} (${data.trades.wins}W / ${data.trades.losses}L)`);
  console.log(`  Win Rate: ${winRate.toFixed(1)}% ${getEmoji(winRate, 45, 55)}`);
  console.log(`  Posiciones abiertas: ${data.trades.open}`);
  console.log('');

  console.log('⚡ PERFORMANCE:');
  console.log(`  Latencia promedio: ${avgLatency.toFixed(0)}ms ${avgLatency < 2000 ? '✅' : '⚠️'}`);
  console.log(`  Edge promedio: ${avgEdge.toFixed(2)}% ${avgEdge >= 2 && avgEdge <= 15 ? '✅' : '⚠️'}`);
  console.log(`  Edge máximo: ${maxEdge.toFixed(2)}% ${maxEdge > 15 ? '⚠️ SOSPECHOSO' : '✅'}`);
  console.log('');

  console.log('📡 SEÑALES:');
  console.log(`  Total señales: ${data.signals}`);
  console.log(`  Eventos STALE: ${data.stale} (${stalePercent.toFixed(1)}%) ${stalePercent < 10 ? '✅' : '⚠️'}`);
  console.log(`  Errores: ${data.errors} ${data.errors < 5 ? '✅' : '⚠️'}`);
  console.log('');

  // Alertas
  const alerts = [];
  
  if (totalTrades >= 5 && winRate < 35) {
    alerts.push('🔴 Win rate CRÍTICO (<35%)');
  } else if (totalTrades >= 5 && winRate < 45) {
    alerts.push('⚠️  Win rate bajo (<45%)');
  }
  
  if (avgLatency > 3000) {
    alerts.push('🔴 Latencia MUY alta (>3s)');
  } else if (avgLatency > 2000) {
    alerts.push('⚠️  Latencia alta (>2s)');
  }
  
  if (maxEdge > 20) {
    alerts.push('🔴 Edge sospechoso (>20%) - precios stale');
  } else if (maxEdge > 15) {
    alerts.push('⚠️  Edge alto (>15%)');
  }
  
  if (stalePercent > 15) {
    alerts.push('🔴 Muchos eventos STALE (>15%)');
  } else if (stalePercent > 10) {
    alerts.push('⚠️  Eventos STALE elevados (>10%)');
  }

  if (alerts.length > 0) {
    console.log('🚨 ALERTAS:');
    alerts.forEach(alert => console.log(`  ${alert}`));
    console.log('');
  }

  // Recomendaciones
  if (totalTrades < 10) {
    console.log('💡 Continuar acumulando datos (mínimo 10 trades)');
  } else if (totalTrades >= 20 && winRate > 50) {
    console.log('✨ Win rate excelente! Considerar WebSocket real');
  } else if (totalTrades >= 50 && winRate > 45) {
    console.log('📊 Datos suficientes - extender a 72h de monitoring');
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log('');
}

function getEmoji(value, min, good) {
  if (value >= good) return '🎯';
  if (value >= min) return '✅';
  if (value >= min * 0.8) return '⚠️';
  return '🔴';
}

// Main
const logFile = process.argv[2] || './logs/bot.log';

if (!fs.existsSync(logFile)) {
  console.error(`\n❌ Archivo no encontrado: ${logFile}\n`);
  console.log('Uso: node analyze-now.js [ruta-al-log]\n');
  process.exit(1);
}

analyzeLogs(logFile);
