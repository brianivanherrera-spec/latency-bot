# 🚀 GO LIVE GUIDE - De Paper Trading → Live Trading

**Última actualización:** 10 Mayo 2026  
**Versión bot:** 2.0 con Stop Loss

---

## ✅ PRE-REQUISITOS

Antes de ir live, verificar:

- [ ] **Paper trading exitoso:** Win rate >58%, mínimo 20 trades
- [ ] **WebSocket estable:** Sin errores de conexión
- [ ] **Capital listo:** $50 USDC + $10 gas
- [ ] **Private key segura:** Exportada de Rabby y guardada

---

## 📝 PASO A PASO - GO LIVE

### **PASO 1: Exportar Private Key de Rabby**

1. Abrir Rabby Wallet
2. Click en **Settings** (⚙️)
3. **Security** → **Export Private Key**
4. Ingresar password de Rabby
5. **Copiar** la private key (empieza con `0x...`)
6. **GUARDAR EN LUGAR SEGURO:**
   - Password manager (1Password, LastPass)
   - Archivo encriptado
   - **NUNCA** compartir ni subir a GitHub

⚠️ **CRÍTICO:** Si perdés esta key, perdés acceso a los fondos.

---

### **PASO 2: Fondear Wallet**

#### **A. Comprar USDC:**

1. Exchange (Binance/Coinbase): Comprar $60 USDC
2. Retirar a Polygon network
3. Dirección destino: Tu wallet de Rabby (copiar desde Rabby)
4. **Network:** Polygon (NO Ethereum, NO BSC)
5. Esperar confirmación (~2-5 min)

#### **B. Configurar gas fees:**

**Opción 1: GasAccount (Recomendado)**
```
1. En Rabby → Scroll abajo → "GasAccount"
2. Login con tu dirección actual
3. Deposit → Polygon → USDC
4. Monto: $10
5. Confirm
6. Listo - ahora podés usar USDC para gas
```

**Opción 2: MATIC nativo**
```
1. Comprar $10 MATIC en exchange
2. Retirar a Polygon
3. Dirección: Tu wallet Rabby
4. Esperar confirmación
```

#### **C. Depositar en Polymarket:**

```
1. Ir a polymarket.com
2. Conectar wallet Rabby
3. Deposit USDC
4. Monto: $50
5. Aprobar transacción en Rabby
6. Esperar confirmación
7. Verificar balance en Polymarket
```

**Resultado final:**
- ✅ Polymarket balance: $50 USDC
- ✅ Gas disponible: $10 (GasAccount o MATIC)

---

### **PASO 3: Configurar Railway Variables**

**Railway Dashboard → Tu proyecto → Settings → Variables**

**AGREGAR/MODIFICAR:**

```bash
# ============================================
# MODO LIVE (CAMBIAR)
# ============================================

DRY_RUN=false                                    # ✅ false = LIVE

# ============================================
# WALLET CREDENTIALS (AGREGAR)
# ============================================

POLY_PRIVATE_KEY=0xTU_PRIVATE_KEY_AQUI          # ✅ De Rabby

# ============================================
# STOP LOSS PROTECTION (AGREGAR)
# ============================================

MAX_DAILY_LOSS_USD=5                             # Max -$5/día
MAX_CONSECUTIVE_LOSSES=3                         # Max 3 losses seguidas
MAX_TRADES_PER_DAY=50                            # Max 50 trades/día

# ============================================
# TRADING PARAMS (Ya deberían estar)
# ============================================

ORDER_SIZE_USDC=5
MIN_EDGE_PCT=3
COOLDOWN_SECONDS=300
MAX_POSITIONS=10
ZSCORE_THRESHOLD=1.2
MOVE_PCT_THRESHOLD=0.03
POLY_SENSITIVITY=2.5
MAX_PRICE_AGE_MS=3000
```

**Click "Save"** → Railway redeploya automáticamente

---

### **PASO 4: Verificar Logs Live**

**Railway → Logs (esperar ~30 segundos)**

**Logs esperados:**

```bash
🚀 Latency Bot v2.0 - WebSocket + Timing + Liquidez
Modo: LIVE TRADING ⚠️                           # ← Debe decir LIVE, no DRY RUN
Capital por trade: $5
Max posiciones: 10
Ventana de entrada: Minutos 1-3
Min liquidez requerida: $15
────────────────────────────────────────────────

Stop Loss inicializado:                         # ← Nuevo
  Max pérdida diaria: $5
  Max pérdidas consecutivas: 3
  Max trades/día: 50

✓ @polymarket/clob-client disponible
✓ Wallet conectada: 0xYourAddress              # ← Tu dirección
🟢 WebSocket conectado a Polymarket CLOB
✓ Suscrito a token: 123456...
✓ Conectado al WebSocket Binance
```

**⚠️ SI VES ERRORES:**
- `Error inicializando Polymarket WebSocket` → Private key incorrecta
- `Insufficient funds` → Wallet sin fondos
- `Network error` → VPN/proxy bloqueando

---

### **PASO 5: Monitorear Primer Trade**

**Esperar señal:**

```bash
[SIGNAL] DOWN | Move: -0.034% | Z: 1.82
[EDGE] fairYes=$0.485 polyYes=$0.515 edgePct=4.87%
[TIMING] ✓ Minuto 2/4 - Ventana óptima
[LIQUIDITY] ✓ BID=$42.50 ASK=$38.20 | Spread=1.8%

[OPEN] DOWN @ $0.485 | Edge: 4.87% | Move: -0.034%
  Exposure: $5.00 | Size: 10 contratos

✓ Orden colocada: ORDER_ABC123456              # ← Orden REAL
```

**Verificar en Polymarket:**

1. Ir a polymarket.com
2. Conectar wallet
3. **Portfolio** → **Positions**
4. Deberías ver: "Bitcoin Up or Down - ..."
5. Cantidad: 10 shares
6. Precio: ~$0.485

**✅ Si aparece = FUNCIONANDO PERFECTO**

---

### **PASO 6: Verificar Cierre de Posición**

**Esperar 5-10 minutos (hasta que el mercado resuelva):**

```bash
[TRACKER] Market raw fields: resolved=undefined closed=true ...
[WIN] Posicion cerrada: POS_123456
   Resultado: NO | PnL: +$5.15                 # ← Ganancia real

✅ Ganancia: +$5.15 | P&L día: +$5.15          # ← Stop loss tracking
```

**Verificar en Polymarket:**

1. Portfolio → **History**
2. Deberías ver el trade cerrado
3. Profit/Loss mostrado
4. Balance actualizado

---

### **PASO 7: Monitorear Trades 2-5**

**Mismo proceso:**
- Esperar señal
- Verificar logs de apertura
- Verificar en Polymarket
- Esperar cierre
- Verificar P&L

**Después de 5 trades exitosos:**
- ✅ Si todo OK → **Dejá correr 24/7**
- ❌ Si hay errores → **Detener y debuggear**

---

## 🛡️ PROTECCIONES ACTIVAS

### **Stop Loss Diario:**

El bot **SE DETIENE AUTOMÁTICAMENTE** si:

1. **Pérdida diaria ≥ $5**
   ```
   ⛔ TRADING DETENIDO
   Razón: Pérdida diaria alcanzada: -$5.00
   Reinicio: Medianoche UTC
   ```

2. **3 pérdidas consecutivas**
   ```
   ⛔ TRADING DETENIDO
   Razón: 3 pérdidas consecutivas
   ```

3. **50 trades en un día**
   ```
   ⛔ TRADING DETENIDO
   Razón: Max trades alcanzado: 50/50
   ```

**Reset automático:** Medianoche UTC (21:00 hora Argentina)

---

## 📊 MONITOREO DIARIO

### **Health Check cada 5 minutos:**

```bash
[HEALTH]
  Señales: 18451
  Active slots: 0/10

[STOP LOSS DIARIO]
  P&L hoy: +$12.50                              # ← Ganancia del día
  Trades hoy: 8                                 # ← Trades ejecutados
  Pérdidas consecutivas: 0                      # ← Wins resetan a 0
  Estado: ✅ ACTIVO

=== P&L TRACKER (REAL Polymarket) ===
  Open: 0 | Closed: 28
  Wins: 18 | Losses: 10
  Win Rate: 64.3%
  Total P&L: +$42.80                            # ← P&L total
```

**Qué monitorear:**

- **Win rate:** Debe mantenerse >58%
- **P&L diario:** Debe ser positivo la mayoría de días
- **Stop loss:** No debe activarse frecuentemente
- **Trades/día:** Normal: 20-40 trades

---

## ⚠️ QUÉ HACER SI...

### **Problema: Stop loss se activa todos los días**

**Causa:** Win rate bajo o mercado muy volátil

**Solución:**
1. Revisar win rate actual
2. Si <55% → Ajustar parámetros:
   - Subir `MIN_EDGE_PCT` de 3 a 4
   - Subir `ZSCORE_THRESHOLD` de 1.2 a 1.5
3. Considerar pausar 1-2 días

### **Problema: Sin trades todo el día**

**Causa:** Parámetros muy estrictos o BTC sin volatilidad

**Solución:**
1. Revisar logs: ¿Qué dice [SKIP]?
2. Si "Edge insuficiente" → Bajar `MIN_EDGE_PCT` de 3 a 2.5
3. Si "Fuera de ventana" → Normal, esperar minutos 1-3
4. Si "Liquidez insuficiente" → Normal en mercados quietos

### **Problema: Orden no se ejecuta**

**Síntomas:**
```
[OPEN] DOWN @ $0.485
❌ Error colocando orden: Insufficient funds
```

**Solución:**
1. Verificar balance en Polymarket
2. Verificar gas disponible
3. Re-fondear si necesario

### **Problema: WebSocket desconecta**

**Síntomas:**
```
⚠️  WebSocket desconectado
Reconectando en 2s... (intento 1/5)
```

**Solución:**
- Esto es NORMAL
- Auto-reconexión funciona
- Si falla 5 veces → Fallback a polling 1s
- Sigue funcionando, solo con +1s latencia

---

## 💰 EXPECTATIVAS REALISTAS

### **Semana 1 (Live con $50):**

```
Capital: $50
Trades/día: 25-35
Win rate: 60-65%
Profit/día: $4-7
Profit/semana: $28-49

Balance fin semana: $78-99
```

### **Semana 2-4 (Escalando):**

```
Capital inicio: $78-99
Trades/día: 30-40
Profit/día: $6-10
Profit/semana: $42-70

Balance fin mes 1: $170-240
ROI mes 1: 240-380%
```

### **Mes 2 (Reinvirtiendo):**

```
Capital: $200+
Profit/día: $15-25
Profit/mes: $450-750

Balance fin mes 2: $650-990
```

---

## 🎯 ESCALADO FUTURO

### **Cuándo escalar:**

**De $50 → $100:**
- ✅ Win rate estable >60%
- ✅ 2 semanas sin stop loss diario
- ✅ Profit consistente $5+/día

**De $100 → $200:**
- ✅ Win rate >62%
- ✅ 1 mes operando sin problemas
- ✅ Profit $10+/día

**De $200 → $500:**
- ✅ 2 meses profitable
- ✅ Considerás vivir de esto

### **Cómo escalar:**

```
1. Aumentar capital en wallet
2. Aumentar ORDER_SIZE_USDC:
   - $50 capital → ORDER_SIZE_USDC=5
   - $100 capital → ORDER_SIZE_USDC=10
   - $200 capital → ORDER_SIZE_USDC=20
   - $500 capital → ORDER_SIZE_USDC=50

3. Aumentar MAX_DAILY_LOSS proporcional:
   - $50 capital → MAX_DAILY_LOSS_USD=5 (10%)
   - $100 capital → MAX_DAILY_LOSS_USD=10 (10%)
   - $200 capital → MAX_DAILY_LOSS_USD=20 (10%)
```

---

## 🔒 SEGURIDAD

### **Backups:**

1. **Private key:** Guardada en 2+ lugares seguros
2. **Seed phrase Rabby:** Guardada offline
3. **Logs de Railway:** Descargados semanalmente

### **Monitoreo:**

1. **Diario:** Revisar P&L en Polymarket
2. **Semanal:** Analizar win rate y métricas
3. **Mensual:** Backup completo de datos

### **Retiros:**

**Recomendado:**
- Retirá **50% del profit semanal** a wallet fría
- Dejá **50%** para capitalizar el bot
- Nunca dejes >$1,000 en trading wallet

---

## ✅ CHECKLIST GO-LIVE

**Antes de cambiar DRY_RUN=false:**

- [ ] Paper trading >20 trades con win rate >58%
- [ ] WebSocket funcionando sin errores
- [ ] Private key exportada y guardada SEGURA
- [ ] Wallet fondeada: $50 USDC + gas
- [ ] Balance verificado en Polymarket
- [ ] Variables configuradas en Railway
- [ ] Stop loss configurado
- [ ] Estás listo para monitorear intensivamente

**Después del primer trade:**

- [ ] Orden apareció en Polymarket
- [ ] Precio de ejecución correcto
- [ ] Posición se cerró automáticamente
- [ ] P&L tracker funcionando

**Después de 5 trades:**

- [ ] Win rate >55%
- [ ] Sin errores de ejecución
- [ ] Stop loss sin activarse
- [ ] Listo para dejar 24/7

---

## 📞 SOPORTE POST-LIVE

**Si algo falla:**

1. **NO ENTRAR EN PÁNICO**
2. Revisar logs en Railway
3. Verificar balance en Polymarket
4. Si posiciones abiertas → Esperar cierre natural
5. Si necesario → `DRY_RUN=true` para pausar

**Contacto emergencia:**
- Logs completos en Railway
- Screenshot de error
- Balance actual en Polymarket

---

**¡ÉXITO CON EL LIVE TRADING!** 🚀💰

Recordá: Empezás con $50. En 30 días podés tener $200-300. En 90 días, $1,000-3,000.

**La clave: Dejarlo correr, confiar en las protecciones, y NO interferir.**
