/**
 * Polymarket User WebSocket — Real-time order status updates and fill notifications
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/user
 * Purpose: Receive fill events immediately when orders are matched
 * Benefits: Eliminates polling for fill status, provides T7 timestamp accuracy
 *
 * Auth: Requires X-CLOB-Auth header with signature
 * Events: orders, fills, balances
 * Heartbeat: PING/PONG every 10s
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('USER-WS');
const USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const PING_MS = 10_000;
const RECONNECT_MIN = 1_000;
const RECONNECT_MAX = 30_000;

class UserWebSocket {
  constructor(authHeader) {
    this.ws = null;
    this._connected = false;
    this._connecting = false;
    this._intentionalClose = false;
    this._pingInterval = null;
    this._reconnectDelay = RECONNECT_MIN;
    this._fillCallback = null;
    this._statusCallback = null;
    this._orderUpdates = new Map(); // posId → order state
    this._authHeader = authHeader;
  }

  // Subscribe to fill events
  onFill(cb) { this._fillCallback = cb; }

  // Subscribe to order status updates
  onStatusChange(cb) { this._statusCallback = cb; }

  isConnected() { return this._connected; }

  async connect() {
    if (this._connected || this._connecting) return;
    if (!this._authHeader) {
      logger.warn('No auth header provided for User WebSocket');
      return;
    }

    this._connecting = true;
    try {
      this.ws = new WebSocket(USER_WS_URL, {
        headers: {
          'X-CLOB-Auth': this._authHeader,
        },
      });

      this.ws.on('open', () => {
        logger.info('🔌 User WebSocket connected');
        this._connected = true;
        this._connecting = false;
        this._reconnectDelay = RECONNECT_MIN;
        this._startPing();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          this._handleMessage(msg);
        } catch (e) {
          if (data === 'PONG') return;
          logger.warn(`Failed to parse User WS message: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        logger.warn(`User WS error: ${err.message}`);
      });

      this.ws.on('close', () => {
        this._connected = false;
        this._connecting = false;
        this._stopPing();

        if (this._intentionalClose) {
          logger.info('User WebSocket closed intentionally');
          return;
        }

        logger.info(`User WS reconnecting in ${this._reconnectDelay}ms`);
        setTimeout(() => this.connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX);
      });
    } catch (e) {
      logger.error(`User WS connection failed: ${e.message}`);
      this._connecting = false;
      setTimeout(() => this.connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX);
    }
  }

  _handleMessage(msg) {
    // Polymarket User WS sends: { type, data }
    if (!msg || typeof msg !== 'object') return;

    const { type, data } = msg;

    if (type === 'order') {
      // Order status update
      if (data && data.id) {
        this._orderUpdates.set(data.id, data);

        if (this._statusCallback) {
          this._statusCallback({
            orderId: data.id,
            status: data.status, // 'pending', 'live', 'filled', 'cancelled'
            filledSize: data.filledSize,
            filledPrice: data.filledPrice,
            timestamp: Date.now(),
          });
        }

        // Log order status changes
        if (data.status === 'filled') {
          logger.info(`✅ ORDER FILLED via User WS: ${data.id} | size=${data.filledSize} @ $${data.filledPrice}`);
        } else if (data.status === 'live') {
          logger.info(`📍 ORDER LIVE: ${data.id}`);
        } else if (data.status === 'cancelled') {
          logger.info(`❌ ORDER CANCELLED: ${data.id}`);
        }
      }
    } else if (type === 'fill') {
      // Fill event (subset of order status)
      if (data && (data.orderId || data.id)) {
        const orderId = data.orderId || data.id;
        const fillInfo = {
          orderId,
          size: data.size || data.filledSize,
          price: data.price || data.filledPrice,
          timestamp: data.timestamp || Date.now(),
          createdAt: data.createdAt || Date.now(),
        };

        logger.info(`✅ FILL EVENT: ${orderId} | ${fillInfo.size} @ $${fillInfo.price}`);

        if (this._fillCallback) {
          this._fillCallback(fillInfo);
        }
      }
    } else if (type === 'balance') {
      // Balance update — typically not critical for fill detection
      if (data) {
        logger.debug(`💰 Balance update: ${data.asset || 'unknown'}`);
      }
    }
  }

  _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping('PING');
      }
    }, PING_MS);
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  close() {
    this._intentionalClose = true;
    this._stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  // Get cached order state
  getOrder(orderId) {
    return this._orderUpdates.get(orderId) || null;
  }

  // Check if order was filled
  isFilled(orderId) {
    const order = this._orderUpdates.get(orderId);
    return order && order.status === 'filled';
  }
}

module.exports = UserWebSocket;
