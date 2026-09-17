const WebSocket = require('ws');
const { EventEmitter } = require('events');

class ChainlinkRTDS extends EventEmitter {
  constructor(logger = console) {
    super();
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.url = 'wss://ws-live-data.polymarket.com';
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 32000;
    this.currentReconnectDelay = this.reconnectDelay;
    this.pingInterval = null;
    this.twap_30s = { value_num: null, received_ts: null, event_count: 0 };
    this.twap_60s = { value_num: null, received_ts: null, event_count: 0 };
    this.diag = {
      connected: false,
      events_30s: 0,
      events_60s: 0,
      latest_twap_30s: null,
      latest_twap_60s: null,
      age_30s_ms: null,
      age_60s_ms: null,
      gaps: 0,
      duplicates: 0,
      stale: 0,
      out_of_range: 0,
      disconnections: 0,
      subscription_format_attempts: 0,
      subscription_confirmed: false,
      avg_latency_ms: 0,
      high_latency_events: 0,
    };
    this.lastSeq = {};
    this.lastTs = {};
    this.msgCount = 0;
    this.subscriptionFormats = [
      {
        name: 'FORMAT_A-ALT (topic + type + filters as OBJECT)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty', type: '*', filters: {symbol: 'btc/usd'} },
            { topic: 'crypto_prices_twap_sixty', type: '*', filters: {symbol: 'btc/usd'} }
          ]
        }
      },
      {
        name: 'FORMAT_A (official: topic + type + filters as JSON string)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty', type: '*', filters: '{"symbol":"btc/usd"}' },
            { topic: 'crypto_prices_twap_sixty', type: '*', filters: '{"symbol":"btc/usd"}' }
          ]
        }
      },
      {
        name: 'FORMAT_B (topic + symbol only)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty', symbol: 'btc/usd' },
            { topic: 'crypto_prices_twap_sixty', symbol: 'btc/usd' }
          ]
        }
      },
      {
        name: 'FORMAT_B-UPPER (topic + symbol uppercase)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty', symbol: 'BTC/USD' },
            { topic: 'crypto_prices_twap_sixty', symbol: 'BTC/USD' }
          ]
        }
      },
      {
        name: 'FORMAT_C (topic only, no filters)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty' },
            { topic: 'crypto_prices_twap_sixty' }
          ]
        }
      },
      {
        name: 'FORMAT_D (asset_pair)',
        msg: {
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_twap_thirty', asset_pair: 'btc/usd' },
            { topic: 'crypto_prices_twap_sixty', asset_pair: 'btc/usd' }
          ]
        }
      }
    ];
    this.currentFormatIndex = 0;
    this.subscriptionFormat = null;
  }

  connect() {
    if (this.connected) return;
    try {
      this.ws = new WebSocket(this.url, { perMessageDeflate: true });
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('close', () => this._onClose());
      this.ws.on('error', (err) => this._onError(err));
    } catch (e) {
      this.logger.error(`[CHAINLINK-RTDS] Connection error: ${e.message}`);
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.connected = true;
    this.diag.connected = true;
    this.currentReconnectDelay = this.reconnectDelay;
    this.logger.info('[CHAINLINK-RTDS] ✓ Connected to Polymarket RTDS');
    this._subscribe();
    this._startPing();
  }

  _subscribe() {
    if (this.currentFormatIndex >= this.subscriptionFormats.length) {
      this.logger.error('[CHAINLINK-RTDS] All subscription formats exhausted, giving up');
      this.logger.warn('[CHAINLINK-RTDS] ⚠️ FALLBACK: Entering BINANCE_ONLY_MODE - Chainlink RTDS unavailable');
      this.emit('fallback', { mode: 'BINANCE_ONLY', reason: 'All subscription formats rejected' });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      return;
    }

    this.subscriptionFormat = this.subscriptionFormats[this.currentFormatIndex];
    this.diag.subscription_format_attempts++;

    try {
      const msgStr = JSON.stringify(this.subscriptionFormat.msg);
      this.logger.info(`[CHAINLINK-RTDS] Attempt ${this.currentFormatIndex + 1}/${this.subscriptionFormats.length}: ${this.subscriptionFormat.name}`);
      this.logger.info(`[CHAINLINK-RTDS] Subscription message: ${msgStr}`);
      this.ws.send(msgStr);
    } catch (e) {
      this.logger.error(`[CHAINLINK-RTDS] Subscribe error: ${e.message}`);
    }
  }

  _tryNextFormat() {
    this.currentFormatIndex++;
    this.logger.info(`[CHAINLINK-RTDS] ✗ Current format rejected, trying next format...`);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._subscribe();
    }
  }

  _startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 3000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _onMessage(data) {
    try {
      const msg = JSON.parse(data);
      ++this.msgCount;

      if (msg.event_type === 'crypto_prices_twap_thirty' || msg.event_type === 'crypto_prices_twap_sixty') {
        this._processTWAP(msg);
      } else if (msg.action === 'subscribe_confirmation' || msg.status === 'subscribed' || msg.subscribed) {
        this.logger.info(`[CHAINLINK-RTDS] ✓ Subscription confirmed with ${this.subscriptionFormat.name}`);
        this.diag.subscription_confirmed = true;
      } else if (msg.message === 'Invalid request body') {
        this.logger.warn(`[CHAINLINK-RTDS] ⚠ Invalid request body for ${this.subscriptionFormat.name}`);
        this._tryNextFormat();
      } else if (msg.error) {
        this.logger.error(`[CHAINLINK-RTDS] Error: ${msg.error}`);
      }
    } catch (e) {
      this.logger.warn(`[CHAINLINK-RTDS] Parse error: ${e.message}`);
      this._tryNextFormat();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    }
  }

  _processTWAP(msg) {
    const { event_type, asset_pair, twap_value, twap_timestamp, sequence } = msg;
    const isThirty = event_type === 'crypto_prices_twap_thirty';
    const key = `${event_type}`;

    if (!twap_timestamp || !twap_value) return;

    const ts = new Date(twap_timestamp).getTime();
    const now = Date.now();
    const age = now - ts;

    if (age > 10000) {
      this.diag.stale++;
      return;
    }

    if (age > 500) {
      this.logger.warn(`[CHAINLINK-RTDS] High latency: ${age}ms for ${event_type}`);
    }

    const price = parseFloat(twap_value);
    if (price < 1000 || price > 10000000) {
      this.diag.out_of_range++;
      return;
    }

    if (this.lastSeq[key] !== undefined && sequence <= this.lastSeq[key]) {
      this.diag.duplicates++;
      return;
    }

    if (this.lastTs[key] !== undefined) {
      const gap = ts - this.lastTs[key];
      if (gap > 5000) this.diag.gaps++;
    }

    this.lastSeq[key] = sequence;
    this.lastTs[key] = ts;

    if (age > 500) this.diag.high_latency_events++;
    this.diag.avg_latency_ms = Math.round((this.diag.avg_latency_ms + age) / 2);

    if (isThirty) {
      this.twap_30s = { value_num: price, received_ts: now, event_count: this.twap_30s.event_count + 1 };
      this.diag.events_30s++;
      this.diag.latest_twap_30s = `$${price.toFixed(2)}`;
      this.diag.age_30s_ms = age;
    } else {
      this.twap_60s = { value_num: price, received_ts: now, event_count: this.twap_60s.event_count + 1 };
      this.diag.events_60s++;
      this.diag.latest_twap_60s = `$${price.toFixed(2)}`;
      this.diag.age_60s_ms = age;
    }

    this.emit('update', { event_type, asset_pair, twap_value: price, twap_timestamp: ts, age_ms: age });
  }

  _onClose() {
    this.connected = false;
    this.diag.connected = false;
    this._stopPing();
    this.logger.warn('[CHAINLINK-RTDS] Disconnected, reconnecting...');
    this.diag.disconnections++;
    this._scheduleReconnect();
  }

  _onError(err) {
    this.logger.error(`[CHAINLINK-RTDS] WebSocket error: ${err.message}`);
  }

  _scheduleReconnect() {
    setTimeout(() => this.connect(), this.currentReconnectDelay);
    this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, this.maxReconnectDelay);
  }

  getLatestTWAP(seconds) {
    const target = seconds === 30 ? this.twap_30s : this.twap_60s;
    return target.value_num ? target : null;
  }

  onUpdate(callback) {
    this.on('update', callback);
  }

  getDiag() {
    return { ...this.diag };
  }

  disconnect() {
    this._stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.diag.connected = false;
  }
}

module.exports = { ChainlinkRTDS };
