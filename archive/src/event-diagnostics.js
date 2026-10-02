const fs = require('fs');
const path = require('path');

class EventDiagnostics {
  constructor(logger = console) {
    this.logger = logger;
    this.events = [];
    this.metrics = {
      rtds: {
        total_messages: 0,
        twap_30s: 0,
        twap_60s: 0,
        duplicates: 0,
        stale: 0,
        malformed: 0,
        gaps: 0,
        latencies: [],
      },
      binance: {
        total_ticks: 0,
        gaps: 0,
        latencies: [],
      },
      polymarket: {
        total_updates: 0,
        price_changes: 0,
        size_changes: 0,
        bid_ask_changes: 0,
      },
      markets: {},
    };
    this.markets = new Map();
  }

  logEvent(type, data, sourceTimestamp, receivedTimestamp = Date.now()) {
    const event = {
      type,
      timestamp: receivedTimestamp,
      sourceTimestamp,
      latencyMs: receivedTimestamp - sourceTimestamp,
      data,
      marketId: data.market_id || data.marketId || null,
    };

    this.events.push(event);

    switch (type) {
      case 'MARKET_START':
        this._trackMarket(event.marketId, event);
        break;
      case 'RTDS_TWAP_30':
        this.metrics.rtds.twap_30s++;
        this.metrics.rtds.latencies.push(event.latencyMs);
        this._trackMarket(event.marketId, event);
        break;
      case 'RTDS_TWAP_60':
        this.metrics.rtds.twap_60s++;
        this.metrics.rtds.latencies.push(event.latencyMs);
        this._trackMarket(event.marketId, event);
        break;
      case 'BINANCE_TICK':
        this.metrics.binance.total_ticks++;
        this.metrics.binance.latencies.push(event.latencyMs);
        this._trackMarket(event.marketId, event);
        break;
      case 'POLYMARKET_UPDATE':
        this.metrics.polymarket.total_updates++;
        this._trackMarket(event.marketId, event);
        break;
      case 'SIGNAL':
        this._trackMarket(event.marketId, event);
        break;
      case 'ORDER':
        this._trackMarket(event.marketId, event);
        break;
      case 'FILL':
        this._trackMarket(event.marketId, event);
        break;
      case 'MARKET_END':
        this._trackMarket(event.marketId, event);
        break;
      case 'RESOLUTION':
        this._trackMarket(event.marketId, event);
        break;
    }
  }

  _trackMarket(marketId, event) {
    if (!marketId) return;

    if (!this.markets.has(marketId)) {
      this.markets.set(marketId, {
        id: marketId,
        events: [],
        startTime: null,
        endTime: null,
        resolution: null,
      });
    }

    const market = this.markets.get(marketId);
    market.events.push(event);

    if (event.type === 'MARKET_START') {
      market.startTime = event.timestamp;
    }
    if (event.type === 'MARKET_END') {
      market.endTime = event.timestamp;
    }
    if (event.type === 'RESOLUTION') {
      market.resolution = event.data.outcome;
    }
  }

  getMetrics() {
    const rtdsLatencies = this.metrics.rtds.latencies;
    const binanceLatencies = this.metrics.binance.latencies;

    return {
      rtds: {
        ...this.metrics.rtds,
        avg_latency_ms: this._avg(rtdsLatencies),
        p50_latency_ms: this._percentile(rtdsLatencies, 50),
        p95_latency_ms: this._percentile(rtdsLatencies, 95),
        max_latency_ms: Math.max(...rtdsLatencies, 0),
      },
      binance: {
        ...this.metrics.binance,
        avg_latency_ms: this._avg(binanceLatencies),
        p50_latency_ms: this._percentile(binanceLatencies, 50),
        p95_latency_ms: this._percentile(binanceLatencies, 95),
        max_latency_ms: Math.max(...binanceLatencies, 0),
      },
      polymarket: this.metrics.polymarket,
      total_events: this.events.length,
      total_markets: this.markets.size,
    };
  }

  getMarketFlow(marketId) {
    if (!this.markets.has(marketId)) {
      return null;
    }

    const market = this.markets.get(marketId);
    const flow = {};

    market.events.forEach((event) => {
      if (!flow[event.type]) {
        flow[event.type] = [];
      }
      flow[event.type].push({
        timestamp: event.timestamp,
        sourceTimestamp: event.sourceTimestamp,
        latencyMs: event.latencyMs,
        data: event.data,
      });
    });

    return {
      marketId,
      duration: market.endTime ? market.endTime - market.startTime : null,
      resolution: market.resolution,
      flow,
    };
  }

  getCompleteReport(limit = 3) {
    const metrics = this.getMetrics();
    const marketIds = Array.from(this.markets.keys()).slice(-limit);
    const marketFlows = marketIds.map((id) => this.getMarketFlow(id));

    return {
      metrics,
      markets: marketFlows,
      generatedAt: new Date().toISOString(),
    };
  }

  saveReport(filename = 'diagnostics-report.json') {
    const report = this.getCompleteReport();
    const filepath = path.join('/home/user/latency-bot/data', filename);

    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));

    this.logger.info(`[DIAG] Report saved to ${filepath}`);
    return filepath;
  }

  _avg(arr) {
    if (arr.length === 0) return 0;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }

  _percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}

module.exports = { EventDiagnostics };
