/**
 * Discord Alert System
 * Envía alertas cuando el bot detecta una señal para trade manual
 */

const config = require('./config');
const { Logger } = require('./logger');
const logger = new Logger('ALERTS');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

async function sendDiscordAlert(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn(`Discord webhook error: ${res.status}`);
  } catch (e) {
    logger.warn(`Discord send failed: ${e.message}`);
  }
}

/**
 * Alerta de señal para trade manual
 */
async function alertTradeSignal({ direction, price, edge, move, zscore, segsRestantes, market, size, exposure }) {
  const emoji = direction === 'UP' ? '🟢' : '🔴';
  const dirLabel = direction === 'UP' ? 'YES (UP)' : 'NO (DOWN)';
  const polyUrl = `https://polymarket.com/event/${market.marketSlug || 'btc-up-or-down-5m'}`;

  const embed = {
    title: `${emoji} SEÑAL ${direction} — BTC Latency Bot`,
    color: direction === 'UP' ? 0x00ff88 : 0xff4444,
    fields: [
      { name: '📈 Mercado',     value: market.question,                          inline: false },
      { name: '🎯 Apuesta',     value: `**${dirLabel}** @ $${price.toFixed(3)}`, inline: true  },
      { name: '⚡ Edge',        value: `**${edge.toFixed(2)}%**`,                inline: true  },
      { name: '📊 Z-score',     value: zscore.toFixed(2),                        inline: true  },
      { name: '📉 Move BTC',    value: `${move.toFixed(3)}%`,                    inline: true  },
      { name: '⏱️ Tiempo',      value: `**${segsRestantes}s restantes**`,        inline: true  },
      { name: '💵 Sugerido',    value: `$${exposure} → ${size} tokens`,          inline: true  },
    ],
    description: `[👉 Abrir en Polymarket](${polyUrl})`,
    footer: { text: 'Entrá rápido — ventana de latency arbitrage' },
    timestamp: new Date().toISOString(),
  };

  await sendDiscordAlert({ embeds: [embed] });
  logger.info(`🔔 Alerta Discord enviada: ${direction} @ $${price.toFixed(3)}`);
}

/**
 * Alerta de resultado (para cuando se implemente resolución)
 */
async function alertTradeResult({ direction, price, result, pnl, market }) {
  const won = result === 'WIN';
  const embed = {
    title: `${won ? '✅ WIN' : '❌ LOSS'} — Trade cerrado`,
    color: won ? 0x00ff88 : 0xff4444,
    fields: [
      { name: 'Mercado', value: market.question, inline: false },
      { name: 'Dirección', value: `${direction} @ $${price.toFixed(3)}`, inline: true },
      { name: 'P&L', value: `**${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}**`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
  await sendDiscordAlert({ embeds: [embed] });
}

/**
 * Alerta de inicio del bot
 */
async function alertBotStart({ dryRun }) {
  if (!WEBHOOK_URL) return;
  await sendDiscordAlert({
    embeds: [{
      title: `🤖 Latency Bot ${dryRun ? '(DRY RUN)' : '🔴 LIVE'} — Iniciado`,
      color: dryRun ? 0xffaa00 : 0xff4444,
      description: dryRun
        ? 'Modo paper trading — recibirás alertas pero sin trades reales'
        : 'Modo LIVE — las alertas requieren acción manual en Polymarket',
      timestamp: new Date().toISOString(),
    }]
  });
}

module.exports = { alertTradeSignal, alertTradeResult, alertBotStart };
