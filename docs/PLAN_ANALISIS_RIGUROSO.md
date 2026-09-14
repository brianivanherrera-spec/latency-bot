# Plan de Análisis Riguroso: Book Filter y Timing

**Creado**: 2026-09-14  
**Objetivo**: Determinar CAUSALMENTE si el book filter causa ganancias bajas, basado en datos reales  
**Metodología**: Sin especulaciones, solo correlaciones estadísticas demostrables

---

## ⚠️ Lo Que NO Haremos

```
❌ Afirmar "40% del edge se pierde" sin datos que lo respalden
❌ Predecir "+15-25% win rate" sin análisis contrafactual real
❌ Asumir causalidad sin correlación estadística
❌ Ignorar posibilidad de confundidores (otros factores)
❌ Hacer cambios en código hasta terminar el análisis
```

---

## ✅ Lo Que SÍ Haremos

```
✅ Medir latencias reales en milisegundos
✅ Correlacionar latencia con resultado (ganancias/pérdidas)
✅ Calcular correlación de Pearson (¿latencia predice resultado?)
✅ Investigar confundidores (Z-score, volatilidad, etc.)
✅ Solo hacer afirmaciones respaldadas por números
```

---

## 📊 Preguntas Específicas a Responder

### Pregunta 1: ¿Cuál es la latencia actual (signal → order)?

**Método:**
1. Extraer timestamp de SIGNAL_GENERATED
2. Extraer timestamp de ORDER_SENT
3. Calcular diferencia en milisegundos
4. Reportar: min, max, promedio, mediana, P95, P99

**Resultado esperado:**
```
Latencia signal→order: XXXms
└─ Si < 200ms:  Rápido (normal)
└─ Si 200-500ms: Moderado (posible problema)
└─ Si > 500ms:   Lento (probable problema)
```

**SIN interpretación aún. Solo datos.**

---

### Pregunta 2: ¿Las operaciones más lentas pierden más?

**Método:**
1. Obtener signal_to_order_ms para cada operación completada
2. Obtener resultado (WIN/LOSS) y P&L
3. Dividir en cuartiles de latencia
4. Calcular win rate y P&L promedio por cuartil

**Resultado esperado:**
```
CUARTIL 1 (latencia baja):    XX% win rate, $Y.XX P&L promedio
CUARTIL 2:                    XX% win rate, $Y.XX P&L promedio
CUARTIL 3:                    XX% win rate, $Y.XX P&L promedio
CUARTIL 4 (latencia alta):    XX% win rate, $Y.XX P&L promedio

Correlación de Pearson: r = X.XXX
└─ Si |r| < 0.3:  Correlación DÉBIL
└─ Si 0.3 < |r| < 0.7: Correlación MODERADA
└─ Si |r| > 0.7:  Correlación FUERTE
```

**INTERPRETACIÓN:** Si r > 0.5, existe evidencia de que latencia predice resultado.

---

### Pregunta 3: ¿Cambia el precio de Polymarket entre SIGNAL y ORDER?

**Método:**
1. Para cada operación, extraer:
   - Precio de Polymarket en SIGNAL_GENERATED
   - Precio de Polymarket en ORDER_SENT
   - Latencia (ORDER_SENT - SIGNAL_GENERATED)
2. Calcular: cambio de precio = precio_order - precio_signal
3. Correlacionar: latencia vs cambio de precio

**Resultado esperado:**
```
Cambio promedio de precio: ±X.XX%
Correlación (latencia vs cambio precio): r = X.XXX

Si r > 0.4 Y cambio > 0.5%:
└─ EVIDENCIA: A más latencia, más movimiento de precio
└─ Esto sugiere delay causa entrada a precio peor
```

---

### Pregunta 4: ¿Existe diferencia de Z-score entre ganadores y perdedores?

**Método:**
1. Extraer Z-score de SIGNAL_GENERATED
2. Separar por resultado (WIN vs LOSS)
3. Comparar: Z-score promedio ganadores vs perdedores

**Resultado esperado:**
```
Z-score ganadores:  X.XX promedio
Z-score perdedores: X.XX promedio
Diferencia: ±X.XX

Si diferencia > 20%:
└─ Calidad de señal es MÁS IMPORTANTE que latencia
└─ El problema NO es principalmente el book filter
```

---

### Pregunta 5: Análisis Contrafactual (Si es posible)

**Método:**
1. Identificar trades donde book filter PASÓ validación (ORDER_SENT registrada)
2. Simular: "¿Qué habría pasado sin esperar validación?"
   - Precio de entrada: habría sido X ms antes
   - Polymarket habría tenido Y% menos movimiento
   - P&L habría sido diferente por Z

**Resultado esperado:**
```
Simulación SIN book filter delay:
├─ Entrada promedio: $X.XX (vs $Y.XX actual)
├─ Win rate estimada: ZZ% (vs AA% actual)
└─ P&L diferencial: $±B.BB por trade

ADVERTENCIA: Esta es simulación, no realidad
Diferencia > $0.50 = posible impacto significativo
```

---

## 🛠️ Herramienta de Análisis

He creado `rigorous-timing-analysis.js` que:

1. ✅ Carga datos de los 3 archivos JSONL
2. ✅ Reconstruye cadena completa de eventos por signal_id
3. ✅ Calcula todas las latencias
4. ✅ Genera estadísticas por resultado
5. ✅ Calcula correlación de Pearson
6. ✅ Evita especulación

---

## 🚀 Ejecución Paso a Paso

### PASO 1: Ejecutar Análisis (30 minutos)

```bash
# Conectar a Railway
railway shell

# Ejecutar análisis riguroso
node /tmp/rigorous-timing-analysis.js /data

# Salida:
# [Tabla de latencias]
# [Estadísticas por resultado]
# [Análisis de correlación]
# [Interpretación cuantitativa]
```

### PASO 2: Documentar Hallazgos

Extraer de la salida:
- Latencia promedio signal→order: ___ms
- Correlación latency vs P&L: r = ___
- P&L ganadores: $__
- P&L perdedores: $__
- Win rate: __% (con estos datos)

### PASO 3: Interpretar Resultados (SIN especulación)

**Si latencia > 500ms Y correlación r > 0.4:**
```
Hallazgo: Latencia alta correlaciona con resultados peores
Conclusión: Hay evidencia de que book filter contribuye
Próximo: Prueba A/B desactivando filtro
```

**Si latencia < 200ms O correlación r < 0.2:**
```
Hallazgo: Latencia baja, no predice resultado
Conclusión: El problema NO es principalmente el book filter
Próximo: Investigar otros factores (Z-score, volatilidad, etc.)
```

**Si latencia 200-500ms Y correlación r = 0.3-0.5:**
```
Hallazgo: Relación moderada entre latencia y resultado
Conclusión: Book filter es un factor, pero no el único
Próximo: Optimización asincrónica (no desactivación)
```

---

## 📋 Tabla de Interpretación de Resultados

| Latencia | Correlación | Conclusión | Acción |
|----------|------------|-----------|--------|
| <100ms | r<0.2 | Filtro no es problema | Investigar otros |
| 100-300ms | r<0.3 | Filtro está OK | Sin cambios |
| 300-500ms | r=0.3-0.5 | Filtro contribuye | Optimizar async |
| >500ms | r>0.5 | Filtro es problema | Desactivar/optimizar |

---

## 🔬 Qué NO Haremos Hasta Terminar Este Análisis

```
❌ NO cambiar BOOK_FILTER_ENABLED
❌ NO hacer prueba A/B
❌ NO afirmar percentages de mejora
❌ NO hacer commits de cambios
❌ NO especular sobre causas
```

---

## ✅ Qué Haremos DESPUÉS de Este Análisis

**Si hallazgos confirman que book filter es problema:**
```
1. Crear rama: git checkout -b debug/book-filter-latency
2. Prueba A/B controlada: 50 trades CON, 50 trades SIN filtro
3. Medir diferencia REAL en win rate y P&L
4. Si diferencia > 10%: Desactivar o optimizar
5. Si diferencia < 5%: Problema es otro
```

**Si hallazgos muestran que book filter NO es problema:**
```
1. Investigar confundidores:
   - Z-score en vivo vs histórico
   - Volatilidad de Polymarket
   - Spreads y liquidez
   - Parámetros de riesgo
2. Ajustar lo que sea necesario
3. Sin culpar al book filter
```

---

## 📝 Formato de Reporte Final

Después del análisis, reportaré:

```
DATOS REALES (de rigorous-timing-analysis.js):
├─ Latencia promedio signal→order: XXXms
├─ Correlación latency vs result: r = X.XXX (DÉBIL/MODERADA/FUERTE)
├─ Win rate en datos: XX%
├─ P&L promedio: $X.XX
└─ Operaciones analizadas: N

INTERPRETACIÓN BASADA EN DATOS:
├─ ¿Afecta la latencia el resultado? [SÍ/NO/PARCIAL] porque r = ___
├─ ¿Cuánto impacto tiene? [PEQUEÑO/MODERADO/GRANDE] basado en correlación
└─ Recomendación: [Optimizar/Desactivar/Investigar otros]

PRÓXIMOS PASOS:
└─ [Basados en hallazgos específicos, no especulación]
```

---

## 🎯 Regla de Oro

```
"No afirmaré ningún porcentaje de mejora, 
 costo de latencia, o impacto en ganancias,
 sin que esté respaldado por números reales
 de los datos analizados."
```

---

## 📞 Siguientes Acciones

**Ahora:**
1. Conectar a Railway
2. Ejecutar `rigorous-timing-analysis.js /data`
3. Documentar salida exacta

**Entonces:**
1. Interpretar resultados según tabla arriba
2. Decidir si necesita prueba A/B basado en datos
3. Implementar solución específica

---

**Status**: 🟢 Listo para ejecutar sin especulación  
**Duración**: 30-45 minutos  
**Garantía**: Todos los hallazgos respaldados por números
