# 📊 VOLUME DATA AUDIT REPORT

**Status**: ✅ Code is correctly configured to capture volume
**Issue**: ❌ Data files exist only in Railway (not in git/local)

---

## 📋 VOLUME FIELDS BEING CAPTURED

### 1️⃣ BINANCE VOLUME (binance-raw.jsonl)
**File**: `src/phase2-logger.js` → `logBinanceRaw()` (lines 98-105)

Campos capturando:
- ✅ `btc_volume` - Volumen base en 1min (BTC)
- ✅ `btc_quote_asset_volume` - Volumen nominal (USDT)
- ✅ `number_of_trades` - Número de trades en 1min
- ✅ `taker_buy_base_asset` - Volumen de compras (maker/taker)
- ✅ `taker_buy_quote_asset` - Volumen nominal de compras

**Fuente**: `src/index-final.js` line 1301
```javascript
phase2Logger.logBinanceRaw(priceData, cachedMarket, strikes);
```

**Frequency**: Cada tick de Binance (sub-segundo)

---

### 2️⃣ POLYMARKET 60s VOLUME (signals.jsonl)
**File**: `src/signal-logger.js` → `logSignalOpen()` (lines 117-120)

Campos capturando:
- ✅ `clob_vol60s_yes` - Volumen YES ejecutado en últimos 60s
- ✅ `clob_vol60s_no` - Volumen NO ejecutado en últimos 60s  
- ✅ `clob_vol60s_total` - Volumen total ejecutado en 60s
- ✅ `clob_vol60s_imbalance` - (yes-no)/total ratio

**Fuente**: `src/index-final.js` lines 2096-2098
```javascript
const vol60s_yes   = parseFloat(vol60s_yes.toFixed(2));
const vol60s_no    = parseFloat(vol60s_no.toFixed(2));
const vol60s_total = parseFloat(vol60s_total.toFixed(2));
```

**Frequency**: Cuando se genera una señal (every 10-30 seconds)

---

### 3️⃣ POLYMARKET ORDER BOOK (polymarket-raw.jsonl)
**File**: `src/phase2-logger.js` → `logPolymarketRaw()` (lines 198-201)

Campos capturando:
- ✅ `yes_bid_size` - Tamaño de bid en YES
- ✅ `yes_ask_size` - Tamaño de ask en YES
- ✅ `no_bid_size` - Tamaño de bid en NO
- ✅ `no_ask_size` - Tamaño de ask en NO

**Note**: NO está capturando volumen total de mercado, solo order book sizes

**Frequency**: Cuando hay cambios en precios/spreads

---

### 4️⃣ BOT EXECUTION VOLUME (bot-events.jsonl)
**File**: `src/phase2-logger.js` → `logBotEvent()` 

Campos capturando por evento:
- `SIGNAL_GENERATED`: signal_score, direction, edge_detected
- `ORDER_SENT`: order_size, order_price (pero NO el llenado real)
- `FILL`: filled_size, filled_price, fill_latency_ms
- `NO_FILL`: order_size, razón del no fill

**Frequency**: Cuando ocurren eventos

---

## ⚠️ GAPS EN CAPTURA

### Missing #1: Total Market Volume
**What**: No hay campo para volumen total del mercado en últimas 24h
**Impact**: No puedes medir liquidez general del mercado
**Recommendation**: Agregar a `logPolymarketRaw()`:
```javascript
market_volume_24h: market.volume_24h || null,
market_volume_1h: market.volume_1h || null,
```

### Missing #2: Fill vs Order Size Ratio
**What**: No hay cálculo de "qué porcentaje de la orden se llenó"
**Impact**: No puedes medir slippage por tamaño de orden
**Recommendation**: En `logBotEvent('FILL')`:
```javascript
order_size: data.order_size,
filled_size: data.filled_size,
fill_percentage: (data.filled_size / data.order_size) * 100,
```

### Missing #3: Spreads Evolution
**What**: Solo captura cambios, no histórico completo de spreads
**Impact**: No puedes analizar volatilidad de spread
**Recommendation**: Loguear siempre en `logPolymarketRaw()` aunque no haya cambios (o cachear último)

### Missing #4: Execution vs Polymarket Volume Correlation
**What**: No hay relación entre tu orden size y volumen disponible
**Impact**: No puedes detectar si tus órdenes son grandes relativo a liquidity
**Recommendation**: Agregar a `logBotEvent('ORDER_SENT')`:
```javascript
available_yes_volume: ...  // from book data
order_size_pct_of_available: (order_size / available_volume) * 100,
```

---

## 📂 FILES STRUCTURE IN RAILWAY

En Railway (`/data/`):
```
/data/
  ├── binance-raw.jsonl                    # Tick data from Binance (sub-second)
  ├── binance-raw.2026-09-17T12-34-56.jsonl # Rotated (50MB threshold)
  ├── polymarket-raw.jsonl                 # Book data from Polymarket WS
  ├── polymarket-raw.2026-09-17T09-45-12.jsonl # Rotated
  ├── bot-events.jsonl                     # All bot events (SIGNAL, ORDER, FILL, etc)
  ├── bot-events.2026-09-17T08-23-45.jsonl # Rotated
  ├── signals.jsonl                        # SIGNAL_GENERATED events with full data
  ├── fills.jsonl                          # Fill events with PnL
  └── markets/
      ├── MARKET_0x{id1}_{ts1}.jsonl
      ├── MARKET_0x{id2}_{ts2}.jsonl
      └── ... (per-market timeline)
```

**Rotation Logic**: 50MB threshold (see `src/phase2-logger.js` line 24)

---

## ✅ VERIFICATION CHECKLIST

- [x] Binance volume fields present in code
- [x] Polymarket 60s volume fields present in code
- [x] Book size fields present in code
- [x] Bot event logging includes size/fills
- [x] Files are correctly ignored in .gitignore
- [x] Rotation logic implemented (50MB)
- [ ] ⚠️ Data files missing from local /data/ (only in Railway)
- [ ] ⚠️ Missing: Market total volume (24h/1h)
- [ ] ⚠️ Missing: Fill percentage ratio
- [ ] ⚠️ Missing: Spread evolution history
- [ ] ⚠️ Missing: Order size vs available volume correlation

---

## 🎯 NEXT STEPS

**Option 1: Recover from Railway**
- SSH into Railway environment
- Backup `/data/*.jsonl` files
- Download and restore locally for analysis

**Option 2: Enhance Capture**
- Add missing volume fields (market 24h volume, fill %)
- Start fresh logging in Railway
- Build analysis dashboard from new data

**Option 3: Implement Streaming Export**
- Add daily export to S3/storage
- Keep live data in Railway, backup to persistent storage
- Prevent data loss in future

**Recommendation**: Do Option 1 + Option 3
- Recover existing volume data from Railway
- Implement daily backup to prevent future loss
- Add 4 missing capture fields for better analysis

