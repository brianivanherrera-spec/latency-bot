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
    this.inFallbackMode = false; // Flag to prevent reconnect loop after fallback
    this.fallbackStartTime = null; // Track when fallback mode started
    this.fallbackRetryInterval = 5 * 60 * 1000; // Retry every 5 minutes
    this.fallbackRetryTimeout = null; // Handle to clear retry timeout
    this.subscriptionFormats = [
      {
        name: 'FORMAT_E (assets_ids Polymarket CLOB)',
        msg: {
          assets_ids: ['crypto_prices_twap_thirty', 'crypto_prices_twap_sixty'],
          type: 'Market'
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
      this.inFallbackMode = true; // Flag to prevent reconnect attempts
      this.fallbackStartTime = Date.now(); // Track when fallback started
      this.emit('fallback', { mode: 'BINANCE_ONLY', reason: 'All subscription formats rejected' });
      this._stopPing();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      // Schedule retry after fallback interval
      this.fallbackRetryTimeout = setTimeout(() => {
        this.logger.info('[CHAINLINK-RTDS] Attempting recovery from fallback mode...');
        this.inFallbackMode = false;
        this.currentFormatIndex = 0;
        this.connect();
      }, this.fallbackRetryInterval);
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

      if (msg.type === 'update' && (msg.topic === 'crypto_prices_twap_thirty' || msg.topic === 'crypto_prices_twap_sixty')) {
        this._processTWAP(msg);
      } else if (msg.type === 'subscribed' || msg.action === 'subscribe_confirmation' || msg.status === 'subscribed' || msg.subscribed) {
        this.logger.info(`[CHAINLINK-RTDS] ✓ Subscription confirmed with ${this.subscriptionFormat.name}`);
        this.diag.subscription_confirmed = true;
      } else if (msg.message === 'Invalid request body') {
        this.logger.warn(`[CHAINLINK-RTDS] ⚠ Invalid request body for ${this.subscriptionFormat.name}`);
        this._tryNextFormat();
      } else if (msg.error) {
        this.logger.error(`[CHAINLINK-RTDS] Error: ${msg.error}`);
      } else if (this.msgCount > 2 && !this.diag.subscription_confirmed) {
        // After receiving several messages without subscription confirmation, try next format
        this.logger.warn(`[CHAINLINK-RTDS] ⚠ No subscription confirmation after ${this.msgCount} messages for ${this.subscriptionFormat.name}`);
        this.logger.debug(`[CHAINLINK-RTDS] Unrecognized message: ${JSON.stringify(msg).slice(0, 200)}`);
        this._tryNextFormat();
      }
    } catch (e) {
      this.logger.warn(`[CHAINLINK-RTDS] Parse error: ${e.message}`);
      this._tryNextFormat();
    }
  }

  _processTWAP(msg) {
    const { topic, payload, timestamp: receivedTs } = msg;
    if (!payload || !payload.value || !payload.timestamp) return;

    const isThirty = topic === 'crypto_prices_twap_thirty';
    const key = topic;
    const ts = payload.timestamp; // already ms epoch
    const now = Date.now();
    const age = now - ts;

    if (age > 10000) {
      this.diag.stale++;
      return;
    }

    if (age > 3000) {
      this.logger.warn(`[CHAINLINK-RTDS] High latency: ${age}ms for ${topic}`);
    }

    const price = parseFloat(payload.value);
    if (price < 1000 || price > 10000000) {
      this.diag.out_of_range++;
      return;
    }

    if (this.lastTs[key] !== undefined) {
      const gap = ts - this.lastTs[key];
      if (gap > 5000) this.diag.gaps++;
    }

    this.lastTs[key] = ts;

    if (age > 3000) this.diag.high_latency_events++;
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

    this.emit('update', { event_type: topic, asset_pair: payload.symbol, twap_value: price, twap_timestamp: ts, received_ts: now, age_ms: age });
  }

  _onClose() {
    this.connected = false;
    this.diag.connected = false;
    this._stopPing();
    this.diag.disconnections++;

    // Don't reconnect if we're in fallback mode (all subscription formats exhausted)
    if (this.inFallbackMode) {
      this.logger.warn('[CHAINLINK-RTDS] In BINANCE_ONLY_MODE - not reconnecting to Chainlink');
      return;
    }

    this.logger.warn('[CHAINLINK-RTDS] Disconnected, reconnecting...');
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
    if (this.fallbackRetryTimeout) {
      clearTimeout(this.fallbackRetryTimeout);
      this.fallbackRetryTimeout = null;
    }
    this.connected = false;
    this.diag.connected = false;
    this.inFallbackMode = false; // Reset fallback flag on explicit disconnect
    this.currentFormatIndex = 0; // Reset format index for potential future reconnect
  }
}

module.exports = { ChainlinkRTDS };
