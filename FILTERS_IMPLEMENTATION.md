# 🛡️ FILTROS DE TRADING - Implementación v1.0

## 📊 Análisis que motivó los filtros

Después de analizar **169 trades** en paper trading (2.5 días), se identificaron 3 patrones críticos en las **69 losses**:

### Patrones identificados:
1. **Edge insuficiente**: 60% de losses tenían edge < 5%
2. **Mercado lateral**: 81% de losses tenían movimiento < 0.05%
3. **Sesgo DOWN**: 87% de losses fueron trades SHORT

### Impacto proyectado:
- **Con filtros**: 46 de 47 losses habrían sido evitadas (97.9%)
- **Win rate**: 61.2% → 98.7% proyectado
- **P&L**: $149.46 → $367.96 proyectado
- **ROI**: 24.7% → 60.8% proyectado

---

## 🎯 Filtros Implementados

### 1. **Edge Mínimo Diferenciado**
```javascript
MIN_EDGE_UP: 5.0%      // Para trades LONG (UP)
MIN_EDGE_DOWN: 6.0%    // Para trades SHORT (DOWN) - más estricto
```

**Razón**: El sesgo DOWN está fuertemente presente en losses (87%), por lo que se requiere edge más alto para compensar.

### 2. **Movimiento Mínimo**
```javascript
MIN_MOVE_PCT: 0.05%    // 0.05% mínimo
```

**Razón**: 81% de losses ocurrieron en mercados laterales con movimientos < 0.05%. La estrategia de latencia no funciona bien sin dirección clara.

### 3. **Edge Máximo (Anti-Anomalías)**
```javascript
MAX_EDGE: 15.0%        // 15% máximo
```

**Razón**: Edges superiores a 15% suelen indicar errores de datos o condiciones de mercado anómalas.

---

## 📁 Archivos Modificados

### Nuevos archivos:
- `src/filters.js` - Módulo de filtros con lógica y estadísticas

### Modificados:
- `src/index-final.js` - Integración de filtros en el flujo principal

---

## 🔧 Uso

Los filtros se aplican automáticamente en `index-final.js` antes de cada trade:

```javascript
const filterResult = filters.evaluate(sig);
if (!filterResult.pass) {
  // Trade rechazado - se loggea la razón
  return;
}
```

### Logging detallado:
- `[REJECT]` - Trade rechazado con razón específica
- `[PASS]` - Trade aprobado con métricas
- Health check cada 5 min incluye estadísticas de filtros

---

## 📈 Estadísticas Disponibles

En cada health check verás:

```
=== FILTROS ===
  Evaluados: 150
  Aprobados: 45 (30.0%)
  Rechazados: 105
    - Edge bajo: 60
    - Move chico: 40
    - Edge alto: 5
```

Esto te permite monitorear:
- Cuántas señales son filtradas
- Razón principal de rechazo
- Si los filtros están muy agresivos o conservadores

---

## ⚙️ Configuración

Puedes ajustar los filtros en `src/filters.js`:

```javascript
this.config = {
  MIN_EDGE_UP: 5.0,       // Ajustar si muy restrictivo
  MIN_EDGE_DOWN: 6.0,     // Ajustar según sesgo
  MIN_MOVE_PCT: 0.05,     // Ajustar para más/menos volumen
  MAX_EDGE: 15.0,         // Ajustar según volatilidad
  
  // Activar/desactivar filtros individuales
  ENABLE_EDGE_FILTER: true,
  ENABLE_MOVE_FILTER: true,
  ENABLE_SIDE_BIAS_FILTER: true,
}
```

---

## 🚀 Deploy

### 1. Commitear cambios
```bash
git add .
git commit -m "feat: add trading filters based on loss analysis"
git push origin main
```

### 2. Railway auto-deploy
El deploy en Railway se activará automáticamente.

### 3. Monitorear primeras 24h
- Verificar que los filtros funcionen correctamente
- Observar win rate con menos volumen
- Ajustar thresholds si es necesario

---

## 📊 Expectativas

### Volumen de trades:
- **Sin filtros**: ~55 trades/día
- **Con filtros**: ~25-35 trades/día (reducción 30-40%)

### Win Rate:
- **Sin filtros**: 61.2%
- **Con filtros (proyectado)**: 68-75%
- **Con filtros (optimista)**: 98%+ si análisis es correcto

### P&L:
- **Sin filtros**: $68/día
- **Con filtros (conservador)**: $70-90/día
- **Con filtros (optimista)**: $120-150/día

---

## ⚠️ Próximos Pasos

1. **Correr 24-48h con filtros en paper trading**
2. **Analizar nuevos logs**:
   - ¿Se mantiene el win rate >65%?
   - ¿Aparecen nuevos patrones de loss?
   - ¿Los filtros son muy conservadores?
3. **Ajustar thresholds si es necesario**
4. **Si todo OK → iniciar live con $50-100 USD**

---

## 🐛 Debugging

Si necesitas ver qué está pasando:

```javascript
// En filters.js, cambiar nivel de log
this.logger.info(`[REJECT] ...`);  // Ver todos los rechazos
this.logger.debug(`[REJECT] ...`); // Solo en modo debug
```

O acceder a stats programáticamente:
```javascript
const filterStats = filters.getStats();
console.log(filterStats);
```

---

## 📝 Notas Finales

- Los filtros son **conservadores por diseño**
- Mejor dejar pasar un trade ganador que ejecutar un perdedor
- Los thresholds pueden ajustarse basándose en data real
- Este es un sistema **iterativo** - se mejora con data

**Fecha de implementación**: Mayo 2026  
**Versión**: 1.0  
**Autor**: Claude + Brian
