# Latency Bot - WebSocket Edition

## 🚀 Cambios Implementados

### ✅ WebSocket en Tiempo Real
- **ANTES:** HTTP polling cada 2 segundos → latencia 2-5 segundos
- **AHORA:** WebSocket CLOB → latencia <100ms

### ✅ Bloqueo de Mercados Resueltos
- Detecta y **bloquea** trades cuando precios = 0 o 1 (mercado cerrado)
- Invalida automáticamente mercados resueltos

### ✅ Validación de Precios Stale
- Máximo 3 segundos de antigüedad
- Bloquea trades con datos desactualizados

### ✅ Verificación de Liquidez
- Valida mínimo $15 de liquidez antes de tradear
- Previene slippage excesivo

---

## 🔧 Configuración

### Variables de Entorno en Railway

**Para PAPER TRADING (actual):**
```bash
DRY_RUN=true
MIN_EDGE_PCT=3
COOLDOWN_SECONDS=180
MAX_PRICE_AGE_MS=3000
```

**Para LIVE TRADING (después de validar):**
```bash
DRY_RUN=false
POLY_PRIVATE_KEY=tu_private_key_de_rabby
MIN_EDGE_PCT=3
COOLDOWN_SECONDS=180
MAX_PRICE_AGE_MS=3000
```

### Obtener POLY_PRIVATE_KEY de Rabby Wallet

1. Abrir Rabby Wallet
2. Ir a Settings → Advanced
3. Exportar Private Key de la cuenta que vas a usar
4. ⚠️ **NUNCA compartir esta clave**

---

## 📊 Deploy en Railway

### Opción A: Deploy Automático (Recomendado)
1. Push a GitHub (ya está configurado)
2. Railway detecta cambios y redeploya automáticamente

### Opción B: Deploy Manual
```bash
# En Railway Dashboard:
# 1. Ir a tu servicio
# 2. Settings → Deploy Trigger
# 3. Click "Deploy"
```

---

## ✅ Validación PRE-LIVE

**ANTES de cambiar `DRY_RUN=false`, verificar:**

1. ✅ **20-30 trades válidos** acumulados
2. ✅ **0% de trades contra mercados resueltos** (precios 0 o 1)
3. ✅ **Win rate > 55%** consistente
4. ✅ **P&L positivo** en paper trading

**Comando para verificar logs:**
```bash
# En Railway Dashboard → Deployments → View Logs
# Buscar líneas con [WIN] y [LOSS]
# Verificar que NO haya "outcomePrices=["0", "1"]" o "outcomePrices=["1", "0"]"
```

---

## 💰 Cargar USDC para LIVE Trading

### Desde Binance

1. **Binance** → Wallet → Spot → Withdraw
2. Seleccionar **USDC**
3. Red: **Polygon** (más barato que Ethereum)
4. Dirección: Tu wallet de **Rabby**
5. Monto inicial recomendado: **$50-100**

### Conectar a Polymarket

1. Ir a [polymarket.com](https://polymarket.com)
2. Conectar con Rabby Wallet
3. Verificar balance de USDC en Polygon

---

## 🔍 Monitoreo

### Logs Importantes

**✅ Trades válidos:**
```
[OPEN] DOWN @ $0.475 | Edge: 7.27% | Move: -0.038%
Liquidez: BID=$45.23 ASK=$52.10
```

**🚨 Trades bloqueados (correcto):**
```
⚠️  Precio resuelto detectado: YES=0 NO=1 - BLOQUEANDO
[SKIP] Sin precio Poly válido
```

**❌ Trades inválidos (NO debería pasar):**
```
outcomePrices=["0", "1"]  // ← Mercado resuelto, MALO
outcomePrices=["1", "0"]  // ← Mercado resuelto, MALO
```

### Health Check (cada 5 minutos)

```
[HEALTH]
  Señales: 142
  Active slots: 2/10
  Mercado actual: Bitcoin Up or Down - May 15, 10:15AM-10:20AM ET
  Poly precio válido: ✓
  Último precio: YES=0.485 (age: 250ms)

=== P&L TRACKER ===
  Open: 2 | Closed: 28
  Wins: 18 | Losses: 10
  Win Rate: 64.3%
  Total P&L: +$45.20
```

---

## 🎯 Roadmap

- [x] WebSocket CLOB
- [x] Bloqueo de mercados resueltos
- [x] Validación de precios stale
- [x] Verificación de liquidez
- [ ] **Validar 20-30 trades limpios**
- [ ] **Live trading con $50-100**
- [ ] Dashboard de monitoreo
- [ ] Alertas por Telegram/Discord

---

## ⚠️ IMPORTANTE

1. **NO ir a LIVE sin validar** 20-30 trades válidos
2. **Empezar con poco capital** ($50-100)
3. **Monitorear los primeros trades** en vivo
4. **Incrementar gradualmente** si funciona

El bot está **mucho mejor** ahora, pero necesita validación real antes de arriesgar capital.

---

## 📞 Soporte

Si algo no funciona:
1. Revisar logs en Railway
2. Verificar variables de entorno
3. Confirmar que Rabby tiene USDC en Polygon
