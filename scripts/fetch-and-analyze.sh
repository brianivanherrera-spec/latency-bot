#!/bin/bash

###############################################################################
# Fetch Data from Railway and Run Analysis
#
# Este script:
# 1. Obtiene URL de Railway desde tu config
# 2. Descarga los 3 archivos JSONL
# 3. Ejecuta análisis riguroso
# 4. Reporta resultados
###############################################################################

set -e

echo "🚀 Analizador de Timing - Fetching datos de Railway"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# Verificar si tenemos railway CLI
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI no encontrado"
    echo "Por favor instala: npm install -g @railway/cli"
    echo
    echo "O conecta manualmente:"
    echo "  1. Ve a Railway dashboard"
    echo "  2. Obtén URL de tu servicio"
    echo "  3. Descarga los archivos:"
    echo "     curl https://[tu-url]/phase2-download/bot-events.jsonl > /tmp/bot-events.jsonl"
    echo "     curl https://[tu-url]/phase2-download/binance-raw.jsonl > /tmp/binance-raw.jsonl"
    echo "     curl https://[tu-url]/phase2-download/polymarket-raw.jsonl > /tmp/polymarket-raw.jsonl"
    echo "  4. Luego ejecuta: node scripts/rigorous-timing-analysis.js /tmp"
    exit 1
fi

# Crear directorio temporal
TMPDIR=$(mktemp -d)
echo "📂 Directorio temporal: $TMPDIR"
echo

# Intentar conectar a Railway y obtener datos
echo "🔄 Conectando a Railway..."
if ! railway status &> /dev/null; then
    echo "❌ No puedo conectar a Railway"
    echo "Por favor ejecuta primero: railway login"
    exit 1
fi

echo "✅ Conectado a Railway"
echo

# Obtener URL del servicio (si está disponible)
echo "📥 Descargando datos..."

# Nota: Esto es pseudocódigo. El endpoint real depende de tu configuración
# Puedes obtener esto desde: railway service list | grep latency-bot

# Alternativa: acceso directo a los archivos en Railway
echo "Intentando acceso directo a /data en Railway..."

# Ejecutar commandos en Railway
railway shell --command "cat /data/bot-events.jsonl" > "$TMPDIR/bot-events.jsonl" 2>/dev/null || {
    echo "❌ No puedo acceder a /data/bot-events.jsonl en Railway"
    echo
    echo "Opciones:"
    echo "1. Verificar que el bot está corriendo en Railway"
    echo "2. Ejecutar: railway logs para ver estado"
    echo "3. Acceso manual: railway shell, luego: ls -la /data/"
    rm -rf "$TMPDIR"
    exit 1
}

echo "✅ bot-events.jsonl descargado"

railway shell --command "cat /data/binance-raw.jsonl" > "$TMPDIR/binance-raw.jsonl" 2>/dev/null && \
    echo "✅ binance-raw.jsonl descargado" || \
    echo "⚠️  binance-raw.jsonl no disponible"

railway shell --command "cat /data/polymarket-raw.jsonl" > "$TMPDIR/polymarket-raw.jsonl" 2>/dev/null && \
    echo "✅ polymarket-raw.jsonl descargado" || \
    echo "⚠️  polymarket-raw.jsonl no disponible"

echo

# Verificar tamaño de datos
echo "📊 Tamaño de archivos:"
du -h "$TMPDIR"/*.jsonl 2>/dev/null | sed 's/^/  /'

echo
echo "🔍 Ejecutando análisis riguroso..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# Ejecutar análisis
node scripts/rigorous-timing-analysis.js "$TMPDIR"

# Limpiar
echo
echo "🧹 Limpiando..."
rm -rf "$TMPDIR"

echo "✅ Análisis completado"
