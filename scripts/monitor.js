#!/usr/bin/env node

/**
 * Log Analyzer - Monitoreo automático del Latency Bot
 * 
 * Analiza logs en tiempo real y genera reportes cada 6 horas
 * Detecta red flags y envía alertas
 */

const fs = require('fs');
const path = require('path');

// Configuración
const CONFIG = {
  logFile: process.env.LOG_FILE || './logs/bot.log',
  reportInterval: 6 * 60 * 60 * 1000, // 6 horas
  alertThresholds: {
    minWinRate: 0.45,        // 45%
    maxLatency: 3000,        // 3 segundos
    maxEdge: 15,             // 15%
    maxStalePercent: 0.10,   // 10% de señales
    criticalWinRate: 0.35,   // 35% - alerta crítica
  },
  minTradesForAnalysis: 5,
};

class LogAnalyzer {
  constructor() {
    this.data = {
      trades: [],
      signals: [],
      latencies: [],
      edges: [],
      staleEvents: 0,
      errors: [],
      positions: {
        open: 0,
        closed: 0,
      },
      startTime: Date.now(),
      lastReport: Date.now(),
    };
  }

  parseLine(line) {
    try {
      // Extraer timestamp
      const timestampMatch = line.match(/\[([\d-]+T[\d:.]+)Z?\]/);
      if (!timestampMatch) return;

      const timestamp = new Date(timestampMatch[1]).getTime();

      // Detectar trades (posiciones abiertas)
      if (line.includes('[TRACKER] Posicion abierta:')) {
        const posMatch = line.match(/Posicion abierta: (POS_\d+)/);
        const sideMatch = line.match(/(BUY|SELL) (\d+)t @ \$([\d.]+)/);
        const edgeMatch = line.match(/Edge: ([\d.]+)%/);
        
        if (posMatch && sideMatch) {
          this.data.trades.push({
            id: posMatch[1],
            timestamp,
            side: sideMatch[1],
            size: parseInt(sideMatch[2]),
            price: parseFloat(sideMatch[3]),
            edge: edgeMatch ? parseFloat(edgeMatch[1]) : null,
            status: 'OPEN',
          });
          this.data.positions.open++;
        }
      }

      // Detectar trades cerrados
      if (line.includes('[TRACKER] Posicion cerrada:')) {
        const posMatch = line.match(/Posicion cerrada: (POS_\d+)/);
        const pnlMatch = line.match(/P&L: \$([-\d.]+)/);
        
        if (posMatch && pnlMatch) {
          const trade = this.data.trades.find(t => t.id === posMatch[1]);
          if (trade) {
            trade.status = 'CLOSED';
            trade.pnl = parseFloat(pnlMatch[1]);
            trade.closedAt = timestamp;
            trade.duration = timestamp - trade.timestamp;
            this.data.positions.open--;
            this.data.positions.closed++;
          }
        }
      }

      // Detectar señales
      if (line.includes('[SIGNAL]')) {
        const dirMatch = line.match(/\[SIGNAL\] (UP|DOWN)/);
        const moveMatch = line.match(/Move: ([-\d.]+)%/);
        const zMatch = line.match(/Z: ([-\d.]+)/);
        const confMatch = line.match(/Conf: (\d+)\/100/);
        
        if (dirMatch) {
          this.data.signals.push({
            timestamp,
            direction: dirMatch[1],
            move: moveMatch ? parseFloat(moveMatch[1]) : null,
            zScore: zMatch ? parseFloat(zMatch[1]) : null,
            confidence: confMatch ? parseInt(confMatch[1]) : null,
          });
        }
      }

      // Detectar edges
      if (line.includes('[EDGE]') && line.includes('edgePct=')) {
        const edgeMatch = line.match(/edgePct=([\d.]+)%/);
        if (edgeMatch) {
          const edge = parseFloat(edgeMatch[1]);
          this.data.edges.push({ timestamp, edge });
        }
      }

      // Detectar latencia
      if (line.includes('Age=') && line.includes('ms')) {
        const ageMatch = line.match(/Age=(\d+)ms/);
        if (ageMatch) {
          const latency = parseInt(ageMatch[1]);
          this.data.latencies.push({ timestamp, latency });
        }
      }

      // Detectar eventos stale
      if (line.includes('POLY_PRICE_STALE')) {
        this.data.staleEvents++;
      }

      // Detectar errores
      if (line.includes('[ERROR]') || line.includes('❌')) {
        this.data.errors.push({ timestamp, line: line.trim() });
      }

    } catch (err) {
      // Ignorar líneas que no se puedan parsear
    }
  }

  calculateMetrics() {
    const closedTrades = this.data.trades.filter(t => t.status === 'CLOSED');
    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl < 0);
    
    const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
    
    const avgLatency = this.data.latencies.length > 0
      ? this.data.latencies.reduce((sum, l) => sum + l.latency, 0) / this.data.latencies.length
      : 0;
    
    const avgEdge = this.data.edges.length > 0
      ? this.data.edges.reduce((sum, e) => sum + e.edge, 0) / this.data.edges.length
      : 0;
    
    const maxEdge = this.data.edges.length > 0
      ? Math.max(...this.data.edges.map(e => e.edge))
      : 0;
    
    const stalePercent = this.data.signals.length > 0
      ? this.data.staleEvents / this.data.signals.length
      : 0;

    const uptime = Date.now() - this.data.startTime;

    return {
      trades: {
        total: closedTrades.length,
        open: this.data.positions.open,
        wins: wins.length,
        losses: losses.length,
        winRate: winRate,
        totalPnL: totalPnL,
        avgPnL: closedTrades.length > 0 ? totalPnL / closedTrades.length : 0,
      },
      signals: {
        total: this.data.signals.length,
        staleEvents: this.data.staleEvents,
        stalePercent: stalePercent,
      },
      performance: {
        avgLatency: avgLatency,
        maxLatency: this.data.latencies.length > 0 ? Math.max(...this.data.latencies.map(l => l.latency)) : 0,
        avgEdge: avgEdge,
        maxEdge: maxEdge,
      },
      errors: this.data.errors.length,
      uptime: uptime,
    };
  }

  generateReport(metrics) {
    const runtime = this.formatDuration(metrics.uptime);
    
    console.log('\n' + '═'.repeat(70));
    console.log('📊 REPORTE AUTOMÁTICO - LATENCY BOT');
    console.log('═'.repeat(70));
    console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
    console.log(`⏱️  Runtime: ${runtime}`);
    console.log('');

    // Trades
    console.log('📈 TRADING');
    console.log('─'.repeat(70));
    console.log(`  Total trades cerrados: ${metrics.trades.total}`);
    console.log(`  Posiciones abiertas: ${metrics.trades.open}`);
    console.log(`  Wins: ${metrics.trades.wins} | Losses: ${metrics.trades.losses}`);
    console.log(`  Win Rate: ${(metrics.trades.winRate * 100).toFixed(1)}% ${this.getWinRateEmoji(metrics.trades.winRate)}`);
    console.log(`  P&L Total: $${metrics.trades.totalPnL.toFixed(2)} ${metrics.trades.totalPnL >= 0 ? '✅' : '❌'}`);
    console.log(`  P&L Promedio: $${metrics.trades.avgPnL.toFixed(2)}`);
    console.log('');

    // Performance
    console.log('⚡ PERFORMANCE');
    console.log('─'.repeat(70));
    console.log(`  Latencia promedio: ${metrics.performance.avgLatency.toFixed(0)}ms ${this.getLatencyEmoji(metrics.performance.avgLatency)}`);
    console.log(`  Latencia máxima: ${metrics.performance.maxLatency.toFixed(0)}ms`);
    console.log(`  Edge promedio: ${metrics.performance.avgEdge.toFixed(2)}% ${this.getEdgeEmoji(metrics.performance.avgEdge)}`);
    console.log(`  Edge máximo: ${metrics.performance.maxEdge.toFixed(2)}% ${metrics.performance.maxEdge > CONFIG.alertThresholds.maxEdge ? '⚠️' : '✅'}`);
    console.log('');

    // Señales
    console.log('📡 SEÑALES');
    console.log('─'.repeat(70));
    console.log(`  Total señales: ${metrics.signals.total}`);
    console.log(`  Eventos STALE: ${metrics.signals.staleEvents} (${(metrics.signals.stalePercent * 100).toFixed(1)}%) ${this.getStaleEmoji(metrics.signals.stalePercent)}`);
    console.log(`  Errores: ${metrics.errors} ${metrics.errors > 5 ? '⚠️' : '✅'}`);
    console.log('');

    // Alertas
    const alerts = this.checkAlerts(metrics);
    if (alerts.length > 0) {
      console.log('🚨 ALERTAS');
      console.log('─'.repeat(70));
      alerts.forEach(alert => {
        console.log(`  ${alert.level === 'CRITICAL' ? '🔴' : '⚠️'}  ${alert.message}`);
      });
      console.log('');
    } else {
      console.log('✅ Sin alertas - Todo funcionando correctamente');
      console.log('');
    }

    // Recomendaciones
    const recommendations = this.getRecommendations(metrics);
    if (recommendations.length > 0) {
      console.log('💡 RECOMENDACIONES');
      console.log('─'.repeat(70));
      recommendations.forEach(rec => {
        console.log(`  • ${rec}`);
      });
      console.log('');
    }

    console.log('═'.repeat(70));
    console.log('');
  }

  checkAlerts(metrics) {
    const alerts = [];

    // Win rate crítico
    if (metrics.trades.total >= CONFIG.minTradesForAnalysis) {
      if (metrics.trades.winRate < CONFIG.alertThresholds.criticalWinRate) {
        alerts.push({
          level: 'CRITICAL',
          message: `Win rate CRÍTICO: ${(metrics.trades.winRate * 100).toFixed(1)}% (mínimo: ${CONFIG.alertThresholds.criticalWinRate * 100}%)`,
        });
      } else if (metrics.trades.winRate < CONFIG.alertThresholds.minWinRate) {
        alerts.push({
          level: 'WARNING',
          message: `Win rate bajo: ${(metrics.trades.winRate * 100).toFixed(1)}% (objetivo: ${CONFIG.alertThresholds.minWinRate * 100}%)`,
        });
      }
    }

    // Latencia alta
    if (metrics.performance.avgLatency > CONFIG.alertThresholds.maxLatency) {
      alerts.push({
        level: 'WARNING',
        message: `Latencia alta: ${metrics.performance.avgLatency.toFixed(0)}ms (máximo: ${CONFIG.alertThresholds.maxLatency}ms)`,
      });
    }

    // Edge sospechoso
    if (metrics.performance.maxEdge > CONFIG.alertThresholds.maxEdge) {
      alerts.push({
        level: 'WARNING',
        message: `Edge sospechoso detectado: ${metrics.performance.maxEdge.toFixed(1)}% (indica precios stale)`,
      });
    }

    // Muchos eventos stale
    if (metrics.signals.stalePercent > CONFIG.alertThresholds.maxStalePercent) {
      alerts.push({
        level: 'WARNING',
        message: `Demasiados eventos STALE: ${(metrics.signals.stalePercent * 100).toFixed(1)}% (máximo: ${CONFIG.alertThresholds.maxStalePercent * 100}%)`,
      });
    }

    // Muchos errores
    if (metrics.errors > 10) {
      alerts.push({
        level: 'WARNING',
        message: `Muchos errores detectados: ${metrics.errors}`,
      });
    }

    // P&L muy negativo
    if (metrics.trades.total >= 10 && metrics.trades.totalPnL < -20) {
      alerts.push({
        level: 'CRITICAL',
        message: `P&L muy negativo: $${metrics.trades.totalPnL.toFixed(2)}`,
      });
    }

    return alerts;
  }

  getRecommendations(metrics) {
    const recommendations = [];

    if (metrics.trades.total < CONFIG.minTradesForAnalysis) {
      recommendations.push(`Continuar acumulando datos (${metrics.trades.total}/${CONFIG.minTradesForAnalysis} trades mínimos)`);
    }

    if (metrics.trades.total >= 20 && metrics.trades.winRate > 0.50) {
      recommendations.push('✨ Win rate excelente (>50%) - considerar implementar WebSocket real para optimizar latencia');
    }

    if (metrics.performance.avgLatency > 2000) {
      recommendations.push('Revisar conectividad - latencia >2s puede afectar performance');
    }

    if (metrics.signals.stalePercent > 0.15) {
      recommendations.push('Alto porcentaje de eventos STALE - verificar configuración MAX_PRICE_AGE_MS');
    }

    if (metrics.trades.total >= 50 && metrics.trades.winRate > 0.45) {
      recommendations.push('📊 Datos suficientes con win rate aceptable - considerar extender monitoring a 72 horas');
    }

    if (metrics.trades.total >= 100 && metrics.trades.winRate > 0.50) {
      recommendations.push('🎯 HITO ALCANZADO - 100+ trades con win rate >50% - evaluar activación de dinero real (con capital mínimo)');
    }

    return recommendations;
  }

  getWinRateEmoji(winRate) {
    if (winRate >= 0.55) return '🎯';
    if (winRate >= 0.45) return '✅';
    if (winRate >= 0.35) return '⚠️';
    return '🔴';
  }

  getLatencyEmoji(latency) {
    if (latency < 1000) return '⚡';
    if (latency < 2000) return '✅';
    if (latency < 3000) return '⚠️';
    return '🔴';
  }

  getEdgeEmoji(edge) {
    if (edge >= 2 && edge <= 10) return '✅';
    if (edge > 10 && edge <= 15) return '⚠️';
    return '🔴';
  }

  getStaleEmoji(percent) {
    if (percent < 0.05) return '✅';
    if (percent < 0.10) return '⚠️';
    return '🔴';
  }

  formatDuration(ms) {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  async analyze(logFilePath) {
    try {
      const content = fs.readFileSync(logFilePath, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach(line => this.parseLine(line));
      
      const metrics = this.calculateMetrics();
      this.generateReport(metrics);
      
      return metrics;
    } catch (err) {
      console.error(`Error leyendo log file: ${err.message}`);
      return null;
    }
  }

  watchLog(logFilePath) {
    console.log(`👀 Monitoreando: ${logFilePath}`);
    console.log(`📊 Reportes cada: 6 horas`);
    console.log('');

    // Análisis inicial
    this.analyze(logFilePath);

    // Reportes periódicos cada 6 horas
    setInterval(() => {
      console.log('\n🔄 Generando reporte programado...\n');
      this.analyze(logFilePath);
      this.data.lastReport = Date.now();
    }, CONFIG.reportInterval);

    // Watch file para análisis en tiempo real
    let lastSize = 0;
    setInterval(() => {
      try {
        const stats = fs.statSync(logFilePath);
        if (stats.size > lastSize) {
          const stream = fs.createReadStream(logFilePath, {
            start: lastSize,
            end: stats.size,
          });
          
          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line
            
            lines.forEach(line => this.parseLine(line));
          });
          
          lastSize = stats.size;
        }
      } catch (err) {
        // File might not exist yet
      }
    }, 5000); // Check every 5 seconds
  }
}

// Main
if (require.main === module) {
  const analyzer = new LogAnalyzer();
  
  const logPath = process.argv[2] || CONFIG.logFile;
  
  if (!fs.existsSync(logPath)) {
    console.error(`❌ Log file no encontrado: ${logPath}`);
    console.log('');
    console.log('Uso:');
    console.log('  node monitor.js [ruta-al-log]');
    console.log('');
    console.log('O configurar LOG_FILE en variables de entorno');
    process.exit(1);
  }

  analyzer.watchLog(logPath);
}

module.exports = { LogAnalyzer };
