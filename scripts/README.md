# Scripts de Monitoreo - Latency Bot

## 📊 Scripts Disponibles

### 1. `analyze-now.js` - Análisis Rápido On-Demand

Analiza los logs actuales y muestra un resumen instantáneo.

**Uso:**
```bash
# Análisis del log por defecto
node scripts/analyze-now.js

# Análisis de un log específico
node scripts/analyze-now.js /path/to/bot.log

# Desde Railway (descarga logs primero)
railway logs > logs/bot.log
node scripts/analyze-now.js logs/bot.log
```

**Salida:**
```
📈 RESUMEN RÁPIDO
══════════════════════════════════════════════════════════
🎯 TRADES:
  Total: 3 (2W / 1L)
  Win Rate: 66.7% 🎯
  Posiciones abiertas: 0

⚡ PERFORMANCE:
  Latencia promedio: 850ms ✅
  Edge promedio: 4.2% ✅
  Edge máximo: 7.8% ✅

📡 SEÑALES:
  Total señales: 45
  Eventos STALE: 2 (4.4%) ✅
  Errores: 0 ✅
```

---

### 2. `monitor.js` - Monitoreo Continuo con Reportes Automáticos

Monitorea logs en tiempo real y genera reportes cada 6 horas.

**Uso:**
```bash
# Monitoreo continuo
node scripts/monitor.js

# Con log específico
node scripts/monitor.js /path/to/bot.log

# En background (recomendado)
nohup node scripts/monitor.js > monitor.log 2>&1 &
```

**Características:**
- ✅ Reportes automáticos cada 6 horas
- ✅ Detección de alertas en tiempo real
- ✅ Análisis continuo de métricas
- ✅ Recomendaciones automáticas

**Salida (cada 6 horas):**
```
═══════════════════════════════════════════════════════════════════
📊 REPORTE AUTOMÁTICO - LATENCY BOT
═══════════════════════════════════════════════════════════════════
⏰ Timestamp: 2026-05-04T20:00:00.000Z
⏱️  Runtime: 6h 15m

📈 TRADING
──────────────────────────────────────────────────────────────────
  Total trades cerrados: 12
  Posiciones abiertas: 1
  Wins: 8 | Losses: 4
  Win Rate: 66.7% 🎯
  P&L Total: $2.40 ✅
  P&L Promedio: $0.20

⚡ PERFORMANCE
──────────────────────────────────────────────────────────────────
  Latencia promedio: 920ms ⚡
  Latencia máxima: 2800ms
  Edge promedio: 5.4% ✅
  Edge máximo: 12.8% ✅

📡 SEÑALES
──────────────────────────────────────────────────────────────────
  Total señales: 145
  Eventos STALE: 8 (5.5%) ✅
  Errores: 2 ✅

✅ Sin alertas - Todo funcionando correctamente

💡 RECOMENDACIONES
──────────────────────────────────────────────────────────────────
  • ✨ Win rate excelente (>50%) - considerar implementar WebSocket
  • 📊 Datos suficientes - extender monitoring a 72 horas
```

---

## 🚨 Sistema de Alertas

Ambos scripts detectan automáticamente:

### 🔴 Alertas CRÍTICAS:
- Win rate <35% (con 5+ trades)
- Latencia >3 segundos
- Edge >20% (precios muy stale)
- P&L <-$20
- Eventos STALE >15%

### ⚠️ Alertas WARNING:
- Win rate 35-45%
- Latencia 2-3 segundos
- Edge 15-20%
- Eventos STALE 10-15%
- 5+ errores

---

## 📋 Métricas Monitoreadas

| Métrica | Objetivo | Warning | Crítico |
|---------|----------|---------|---------|
| Win Rate | >50% | 35-45% | <35% |
| Latencia | <1s | 2-3s | >3s |
| Edge Promedio | 2-10% | 10-15% | >15% |
| Eventos STALE | <5% | 10-15% | >15% |
| P&L | Positivo | -$10 a -$20 | <-$20 |

---

## 🎯 Hitos Automáticos

El script detecta y notifica hitos importantes:

- **5 trades:** Primeras métricas confiables
- **10 trades:** Checkpoint 1 - validar win rate >40%
- **25 trades:** Checkpoint 2 - extender monitoring
- **50 trades:** Checkpoint 3 - considerar WebSocket
- **100 trades:** Go/No-Go para dinero real

---

## 🔧 Configuración

Edita las constantes en `monitor.js` si quieres ajustar:

```javascript
const CONFIG = {
  reportInterval: 6 * 60 * 60 * 1000, // 6 horas (cambiar aquí)
  alertThresholds: {
    minWinRate: 0.45,        // 45%
    maxLatency: 3000,        // 3 segundos
    maxEdge: 15,             // 15%
    maxStalePercent: 0.10,   // 10%
    criticalWinRate: 0.35,   // 35%
  },
};
```

---

## 📱 Uso en Railway

### Opción 1: Análisis Manual (Recomendado para empezar)

```bash
# 1. Descargar logs
railway logs > logs/bot.log

# 2. Analizar
node scripts/analyze-now.js logs/bot.log

# 3. Repetir cada 6 horas
```

### Opción 2: Monitoreo Continuo

```bash
# 1. SSH a Railway (si está disponible)
railway run bash

# 2. Iniciar monitor
nohup node scripts/monitor.js /app/logs/bot.log > monitor.log 2>&1 &

# 3. Ver reportes
tail -f monitor.log
```

---

## 💡 Tips

### Para ver solo alertas:
```bash
node scripts/analyze-now.js | grep -A 10 "ALERTAS"
```

### Para comparar dos momentos:
```bash
# Análisis 1
node scripts/analyze-now.js logs/bot-morning.log > report1.txt

# Análisis 2 (6 horas después)
node scripts/analyze-now.js logs/bot-evening.log > report2.txt

# Comparar
diff report1.txt report2.txt
```

### Para alertas por email (Linux/Mac):
```bash
# Agregar al cron cada 6 horas
0 */6 * * * node /path/to/scripts/analyze-now.js | mail -s "Bot Report" tu@email.com
```

---

## 🆘 Troubleshooting

**"Archivo no encontrado"**
```bash
# Verificar que el log existe
ls -lh logs/bot.log

# O crear directorio
mkdir -p logs
```

**"Permission denied"**
```bash
# Hacer ejecutables
chmod +x scripts/*.js
```

**"Module not found"**
```bash
# Instalar dependencias
cd latency-bot
npm install
```

---

## 📊 Ejemplo de Flujo Completo

```bash
# DÍA 1 - Deployment
git push origin main
# Railway auto-deploya

# Esperar 6 horas...

# ANÁLISIS 1 (6 horas)
railway logs > logs/day1-6h.log
node scripts/analyze-now.js logs/day1-6h.log

# Esperar 6 horas más...

# ANÁLISIS 2 (12 horas)
railway logs > logs/day1-12h.log
node scripts/analyze-now.js logs/day1-12h.log

# Repetir cada 6 horas por 72 horas (12 análisis)

# DÍA 3 - Decisión
# Si win rate >50% consistente → WebSocket
# Si win rate 45-50% → Extender monitoring
# Si win rate <45% → Revisar estrategia
```

---

Creado: Mayo 4, 2026
Versión: 1.0
