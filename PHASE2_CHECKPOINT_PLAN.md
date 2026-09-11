# PHASE 2: Checkpoint 1 Validation Plan

**Status:** Waiting for 20-50 complete markets (currently at 3 trades)  
**Instrumentation:** FROZEN — No strategy/Z-score/threshold modifications  
**Data Source:** Real Railway deployment  
**Validation Type:** Data capture integrity only

---

## 🎯 Checkpoint 1 Objectives

Verify that the 3 JSONL streams are capturing data correctly and completely before scaling to 500+ markets for statistical analysis.

### Completion Criteria
- [x] Phase2 logger integrated into 6 critical points
- [x] Binance raw stream ready
- [x] Polymarket raw stream ready
- [x] Bot events stream ready
- [ ] Collect 20-50 complete markets
- [ ] Run validation analysis
- [ ] Verify 9-point checklist

---

## 📋 9-Point Validation Checklist

When `validate-phase2.js` is executed (after 20-50 markets):

### 1. ✓ Strike Price Validation
- [ ] 100% of markets have `official_strike_price` captured
- [ ] 100% of markets have `bot_captured_strike_price` captured
- [ ] Both values exist together in same event
- **Impact:** Without complete strikes, latency measurements are meaningless

### 2. ✓ Timestamp Quality (Source vs Received-Only)
- [ ] Binance timestamps: >90% from "source" (exchange timestamp)
- [ ] Polymarket timestamps: >90% from "source" (event origin)
- [ ] Bot event timestamps: >90% from "source"
- **Impact:** Timestamps from exchange are required for true latency; received_only timestamps are second-order

### 3. ✓ Market Resolution Validation
- [ ] Markets have `market_resolution` field populated (UP/DOWN)
- [ ] Resolution timestamp exists
- [ ] Can correlate signal → entry → resolution
- **Impact:** Without resolution, profit/loss analysis is impossible

### 4. ✓ Event Chain Traceability
- [ ] signal_id exists in all SIGNAL_GENERATED events
- [ ] order_id exists in ORDER_SENT events
- [ ] order_id matches in corresponding FILL/NO_FILL events
- [ ] Can reconstruct: market_id → signal_id → order_id → fill_result
- **Impact:** Traceability enables complete market reconstruction

### 5. ✓ Order Book Completeness
- [ ] >95% of polymarket-raw.jsonl entries have all 4 bid/ask levels
- [ ] yes_bid, yes_ask, no_bid, no_ask all non-null
- [ ] yes_bid_size, yes_ask_size, no_bid_size, no_ask_size present
- [ ] Spread calculations available
- **Impact:** Order book depth needed for slippage and liquidity analysis

### 6. ✓ Timestamp Non-Fabrication
- [ ] No timestamp anomalies (reverse time, huge jumps)
- [ ] Binance timestamp < Polymarket timestamp (causality)
- [ ] Bot event timestamp > both Binance and Polymarket
- [ ] Latency calculations are sensible (0-500ms typical)
- **Impact:** Detects if timestamps are being synthesized incorrectly

### 7. ✓ Data Stream Continuity
- [ ] Binance raw events: >1000 events
- [ ] Polymarket raw events: >5000 events
- [ ] Bot events: >50 events total
- **Impact:** Sufficient volume for statistical confidence

### 8. ✓ Complete Market Cycles
- [ ] >10 markets have full signal → order → fill/no-fill cycle
- [ ] Each complete market has market_start_ms and market_end_ms
- [ ] Window elapsed timing available
- **Impact:** Enables end-to-end latency reconstruction

### 9. ✓ Market Snapshot Quality
- [ ] BTC price snapshots at signal generation
- [ ] YES/NO price snapshots at signal generation
- [ ] Bid/ask snapshots available
- [ ] Can reconstruct decision context
- **Impact:** Proves bot state at each critical moment

---

## 🚨 When to Execute Validation

### Trigger: 20+ Complete Markets Collected

```bash
# In Railway logs or monitoring:
- Watch for SIGNAL_GENERATED event count
- Target: >50 total signals across 20+ markets
- When ready, execute:

cd /home/user/latency-bot
node src/validate-phase2.js
```

### Expected Report Structure
```
═════════════════════════════════════════════════════════════
  PHASE 2 VALIDATION REPORT
═════════════════════════════════════════════════════════════

1️⃣  EVENT SUMMARY BY TYPE
   FILL                    : X
   NO_FILL                 : X
   ORDER_SENT              : X
   SIGNAL_GENERATED        : X

2️⃣  MARKET COMPLETENESS
   Total markets: X

3️⃣  STRIKE PRICE VALIDATION
   Valid (both official & captured): X
   Missing strikes: X

4️⃣  TIMESTAMP QUALITY (SOURCE vs RECEIVED_ONLY)
   Binance timestamps from SOURCE: X%
   Polymarket timestamps from SOURCE: X%

5️⃣  ORDER BOOK COMPLETENESS
   Complete order book (4 levels): X%
   Partial order book: X%

6️⃣  MARKET RECONSTRUCTION EXAMPLES
   [2-3 complete examples]

✅ READY FOR SCALED COLLECTION
   or
⚠️  PARTIAL VALIDATION
   or
⏳ COLLECTION IN PROGRESS
```

---

## 📊 What Pass / Fail Means

### ✅ READY FOR SCALED COLLECTION
- **All 9 checks pass**
- Proceed to accumulate 500+ markets
- No trading logic changes needed yet
- Begin statistical analysis phase

### ⚠️ PARTIAL VALIDATION
- **7-8 checks pass, 1-2 need investigation**
- Likely cause: Not enough data (20-50 markets is minimum)
- **Action:** Continue bot running, re-check in 1 hour
- No code changes needed

### 🚫 BLOCKED
- **<7 checks pass**
- Indicates data capture issue
- Must debug before proceeding
- **Possible causes:**
  - Logging calls not integrated correctly
  - Timestamp issues in exchange data
  - Order book missing fields
  - Market metadata not populated

---

## 🔄 Post-Checkpoint 1 Plan

### If ✅ READY (Goal: Answer 6 Questions)

**Phase 2B: Statistical Data Accumulation**
```
Target: 500+ complete markets

Questions to answer:
1. When does BTC move relative to strike?
   - Time from strike capture to significant move
   - Move magnitude distribution
   
2. When does Polymarket react?
   - Latency from BTC move to Polymarket price change
   - Yes/No correlation with BTC movement
   
3. When does bot detect?
   - Latency from Poly move to SIGNAL_GENERATED
   - Z-score threshold crossing timing
   
4. How long is the exploitable window?
   - From SIGNAL_GENERATED to ORDER_SENT duration
   - From ORDER_SENT to FILL duration
   - Total end-to-end latency distribution
   
5. Is the problem signal detection or execution?
   - NO_FILL percentage and magnitude
   - Fill price vs order price slippage
   - Order timing vs market spread
   
6. How many opportunities exist regardless of bot entry?
   - Markets with 2%+ move but no signal
   - Markets with signal but no fill
   - Markets with fill but wrong direction
```

**No Strategy Modifications Yet**
- Leave bot running as-is
- Accumulate raw data
- Identify patterns first
- Only optimize after statistical validation

---

## ⚠️ Critical Constraints

### DO NOT
- ❌ Modify Z-score thresholds during collection
- ❌ Change entry/exit logic
- ❌ Adjust trade sizing or risk parameters
- ❌ Filter market selection criteria
- ❌ Modify Polymarket price reaction logic

### DO
- ✅ Run bot continuously
- ✅ Capture every event to JSONL streams
- ✅ Preserve raw data (never delete /data/*.jsonl)
- ✅ Monitor collection progress
- ✅ Execute validation when checkpoint reached

---

## 📍 Monitoring

### Quick Status Check
```bash
# Terminal: Watch data accumulation
watch -n 5 'echo "=== BINANCE RAW ==="; wc -l /data/binance-raw.jsonl 2>/dev/null || echo "0"; \
echo "=== POLYMARKET RAW ==="; wc -l /data/polymarket-raw.jsonl 2>/dev/null || echo "0"; \
echo "=== BOT EVENTS ==="; wc -l /data/bot-events.jsonl 2>/dev/null || echo "0"; \
echo "---"; tail -1 /data/bot-events.jsonl 2>/dev/null | jq .event_type,.market_id 2>/dev/null || echo "waiting..."'
```

### Event Type Breakdown
```bash
# See distribution of events
jq -r '.event_type' /data/bot-events.jsonl 2>/dev/null | sort | uniq -c
```

### Strike Validation Sample
```bash
# Check if strikes are being captured
jq -r '[.official_strike_price, .bot_captured_strike_price] | @csv' /data/bot-events.jsonl 2>/dev/null | head -10
```

---

## 🎯 Timeline

| Phase | Duration | Trigger | Action |
|-------|----------|---------|--------|
| **Collection** | 2-8 hours | Ongoing | Bot accumulates markets |
| **Checkpoint 1** | 5-10 min | 20-50 markets | Run validate-phase2.js |
| **Decision** | Immediate | Validation result | Proceed or debug |
| **Data Accum** | 24-48h | If ✅ READY | Accumulate to 500+ |
| **Analysis** | 1-2h | 500+ markets | Statistical analysis |
| **Report** | — | Complete | Answer 6 questions |

---

## 📝 Notes

- **Timestamps are critical:** All milliseconds (Date.now())
- **Traceability is critical:** Every signal must link to order must link to fill
- **Order book is critical:** Slippage calculation requires complete depth
- **Market resolution is critical:** Cannot measure profit without knowing outcome
- **No hypothesis:** Just measure what actually happens, no thresholds imposed
