# 🤖 Latency Bot - BTC 5min Polymarket

Bot de latencia que detecta movimientos bruscos de BTC/USDT en Binance WebSocket
y coloca limit orders en mercados de predicción de 5 minutos en Polymarket.

**Costo de inferencia: $0** (señal matemática pura, sin Claude API)

---

## 📁 Estructura

```
latency-bot/
├── src/
│   ├── index.js       ← Entrada principal del bot
│   ├── binance.js     ← Binance WebSocket (stream público)
│   ├── signal.js      ← Motor de señales matemáticas
│   ├── polymarket.js  ← CLOB API client (limit orders)
│   ├── config.js      ← Configuración por variables de entorno
│   ├── logger.js      ← Logger con niveles
│   └── test-signal.js ← Test del motor de señales
├── package.json
├── railway.toml
└── .env.example
```

---

## 🚀 Deploy en Railway

### Paso 1: Subir al repositorio GitHub

```bash
# En el proyecto existente de Railway, reemplazar archivos
# O crear nueva carpeta y push a main

git init
git add .
git commit -m "latency-bot v1"
git push origin main
```

### Paso 2: Railway - Dar de baja el servicio viejo

1. Railway → tu proyecto → servicio viejo
2. **Settings → Danger Zone → Remove Service**
3. O simplemente hacer el nuevo deploy y apagar el viejo con el toggle

### Paso 3: Railway - Crear nuevo servicio

1. Railway → New Service → GitHub Repo
2. Seleccionar el repo / carpeta `latency-bot`
3. Railway detecta automáticamente Node.js

### Paso 4: Variables de entorno en Railway

Railway → Settings → Variables → Add Variable:

| Variable | Valor inicial |
|----------|---------------|
| `DRY_RUN` | `true` |
| `LOG_LEVEL` | `info` |
| `ZSCORE_THRESHOLD` | `1.8` |
| `MOVE_PCT_THRESHOLD` | `0.08` |
| `COOLDOWN_SECONDS` | `120` |
| `ORDER_SIZE_USDC` | `5` |

Las credenciales de Polymarket agregarlas **solo cuando** quieras pasar a live.

### Paso 5: Deploy

Railway hace deploy automático al push. Ver logs en Railway → Logs.

---

## 🧪 Testear localmente

```bash
npm install
node src/test-signal.js   # prueba el motor de señales sin APIs
```

Para correr el bot en local con paper trading:
```bash
cp .env.example .env
# editar .env: DRY_RUN=true
node src/index.js
```

---

## 📊 Estrategia matemática

1. **Binance aggTrade WebSocket** → recibe cada operación en BTC/USDT en tiempo real
2. **Buffer deslizante** de 300 ticks (~20 segundos de actividad)
3. **Z-Score**: detecta cuando el precio se aleja N desviaciones estándar de la media
4. **Momentum**: calcula movimiento % en ventana corta
5. **Presión de compra**: ratio de buy vs sell en últimos 50 ticks
6. **Velocidad**: valida que el movimiento sea rápido (no gradual)
7. Si todos los filtros pasan → señal UP o DOWN → limit order en Polymarket

---

## ⚙️ Parámetros ajustables

| Variable | Default | Descripción |
|----------|---------|-------------|
| `SIGNAL_WINDOW` | 300 | Ticks en buffer de análisis |
| `ZSCORE_THRESHOLD` | 1.8 | Mínimo z-score para señal |
| `MOVE_PCT_THRESHOLD` | 0.08 | Mínimo % de movimiento |
| `MIN_VELOCITY` | 0.005 | Mínimo %/segundo |
| `COOLDOWN_SECONDS` | 120 | Pausa entre órdenes |
| `ORDER_SIZE_USDC` | 5 | USDC por orden |

---

## 🔐 Credenciales Polymarket (para live trading)

1. Ir a polymarket.com → conectar wallet MetaMask
2. Perfil → API → Generate API Key
3. Copiar: `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`
4. `POLY_PRIVATE_KEY`: clave privada de la wallet (guardar con cuidado)

**⚠️ Nunca commitear estas keys al repo. Solo en Railway Variables.**

---

## 📈 Logs esperados (DRY RUN)

```
[INFO] [MAIN] 🚀 Latency Bot iniciando...
[INFO] [MAIN] Modo: PAPER TRADING (DRY RUN)
[INFO] [BINANCE-WS] Conectado: wss://stream.binance.com...
[INFO] [MAIN] ✅ Conectado a Binance WebSocket
...
[INFO] [MAIN] 📊 Señal: UP | Move: 0.092% | Z: 2.13
[INFO] [POLYMARKET] [DRY RUN] BUY 8 tokens @ $0.61 (Will BTC be higher...)
[INFO] [MAIN] ✅ Orden colocada: DRY_1234567890
[INFO] [MAIN] 💓 Health | Ticks: 15420 | Señales: 3 | WS: OK
```
