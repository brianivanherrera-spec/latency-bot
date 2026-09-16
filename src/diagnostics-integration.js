const { EventDiagnostics } = require('./event-diagnostics');

class DiagnosticsIntegration {
  constructor(logger = console) {
    this.logger = logger;
    this.diag = new EventDiagnostics(logger);
  }

  hookRTDS(rtdsInstance) {
    const originalEmit = rtdsInstance.emit.bind(rtdsInstance);

    rtdsInstance.emit = function(eventType, data) {
      if (eventType === 'update') {
        const { event_type, age_ms, twap_timestamp } = data;
        const sourceTs = twap_timestamp || Date.now() - age_ms;

        if (event_type === 'crypto_prices_twap_thirty') {
          this.diag.logEvent('RTDS_TWAP_30', {
            market_id: data.market_id,
            price: data.twap_value,
            age_ms,
          }, sourceTs);
        } else if (event_type === 'crypto_prices_twap_sixty') {
          this.diag.logEvent('RTDS_TWAP_60', {
            market_id: data.market_id,
            price: data.twap_value,
            age_ms,
          }, sourceTs);
        }
      }
      return originalEmit(eventType, data);
    };

    rtdsInstance.diag = this.diag;
  }

  hookBinance(binanceInstance) {
    const originalOnPrice = binanceInstance.onPrice.bind(binanceInstance);

    binanceInstance.onPrice = function(callback) {
      const wrappedCallback = (tick) => {
        const sourceTs = tick.E || tick.timestamp || Date.now();
        this.diag.logEvent('BINANCE_TICK', {
          market_id: tick.symbol,
          price: tick.c,
          timestamp: tick.E,
          buyer_maker: tick.m,
        }, sourceTs);
        return callback(tick);
      };
      return originalOnPrice(wrappedCallback);
    };

    binanceInstance.diag = this.diag;
  }

  hookPolymarket(polymarketInstance) {
    const originalOnBook = polymarketInstance.onBook.bind(polymarketInstance);

    polymarketInstance.onBook = function(callback) {
      const wrappedCallback = (book) => {
        this.diag.logEvent('POLYMARKET_UPDATE', {
          market_id: book.market_id,
          yes_price: book.yes,
          no_price: book.no,
          yes_size: book.yesSize,
          no_size: book.noSize,
        }, Date.now());
        return callback(book);
      };
      return originalOnBook(wrappedCallback);
    };

    polymarketInstance.diag = this.diag;
  }

  logMarketStart(marketId, strikePrice) {
    this.diag.logEvent('MARKET_START', {
      market_id: marketId,
      strike_price: strikePrice,
    }, Date.now());
  }

  logSignal(marketId, signalData) {
    this.diag.logEvent('SIGNAL', {
      market_id: marketId,
      ...signalData,
    }, Date.now());
  }

  logOrder(marketId, orderData) {
    this.diag.logEvent('ORDER', {
      market_id: marketId,
      ...orderData,
    }, Date.now());
  }

  logFill(marketId, fillData) {
    this.diag.logEvent('FILL', {
      market_id: marketId,
      ...fillData,
    }, Date.now());
  }

  logMarketEnd(marketId) {
    this.diag.logEvent('MARKET_END', {
      market_id: marketId,
    }, Date.now());
  }

  logResolution(marketId, outcome) {
    this.diag.logEvent('RESOLUTION', {
      market_id: marketId,
      outcome,
    }, Date.now());
  }

  getReport(limit = 3) {
    return this.diag.getCompleteReport(limit);
  }

  saveReport(filename = `diagnostics-${Date.now()}.json`) {
    return this.diag.saveReport(filename);
  }

  getMetrics() {
    return this.diag.getMetrics();
  }
}

module.exports = { DiagnosticsIntegration };
