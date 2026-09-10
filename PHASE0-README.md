# PHASE 0: Detailed Fill Telemetry Collection

## Objective
Validate two critical hypotheses from the audit about NO_FILL causes:

1. **Hypothesis 1 (status='live' bug)**: How many NO_FILLs are status='live' orders wrongly classified as NO_FILL without waiting 60s for potential fills?
2. **Hypothesis 2 (book-depth)**: How many NO_FILLs are due to book-depth exhaustion (constant Polymarket price, no volume)?

## What PHASE 0 Collects

Every order attempt (both FILLED and NO_FILL) logs detailed telemetry to `/data/fills.jsonl`:

```json
{
  "posId": "POS_1726...",
  "timestamp": 1726...,
  "fill_result": "FILLED" | "NO_FILL",
  "order_status": "matched" | "live" | "pending" | "error" | "simulated_*",
  "order_price": "0.3500",
  "best_ask": "0.3501",
  "rejection_reason": "timeout 60s sin fill" | "bestAsk demasiado alto" | etc.,
  "time_to_fill_ms": 234,
  "order_size": 100,
  "size_filled": 100,
  "btc_price_entry": "98,567",
  "poly_price_entry": "0.3200",
  "signal_direction": "UP" | "DOWN",
  "market_strike_price": "98,500"
}
```

## How to Analyze

Run the analysis tool once you have 50+ trades:

```bash
node analyze-fills.js
```

This will report:
- Fill rate (actual vs reported)
- No-fill reasons breakdown  
- Confirmation/rejection of each hypothesis
- Estimated impact if fixed

## Risk Level
🟢 **ZERO RISK** — Pure data collection, no logic changes. Safe to deploy immediately.

## Timeline
- Collect data from ~50-100 trades (5-15 minutes of live trading)
- Run analysis 
- Use results to decide if PHASE 1 (bug fix) and PHASE 2 (A/B test) should proceed

## What Happens After

Once data is collected:

- **If Hypothesis 1 confirmed** (status='live' misclassifications found):
  - PHASE 1: Fix index-final.js line 1707 to register status='live' orders as PENDING, not NO_FILL
  - Expect +20-30pp to reported fill rate
  
- **If Hypothesis 2 confirmed** (book-depth issues found):
  - PHASE 2: A/B test MAX_PRICE_LIMIT only if ask_too_high >5% of NO_FILLs
  - Or: Accept that some NO_FILLs are unfixable (market-side limitation)

- **DO NOT**: Change env vars (MAX_PRICE, TICK_INTERVAL) until data validates the need

## Important Constraints (per audit)
✓ No code logic changes  
✓ No env var modifications  
✓ No new filters or business rules  
✓ Pure telemetry, zero side effects  
✓ Data speaks for itself — evidence-based decisions only  

---

**Deployed**: PHASE 0 telemetry logging  
**File**: `/data/fills.jsonl`  
**Analysis tool**: `analyze-fills.js`  
**Next**: Collect ~100 trades, then run analysis
