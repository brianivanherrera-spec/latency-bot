#!/usr/bin/env node
/**
 * Reconciliación de las compras reales del bot contra los trades de Polymarket — SOLO LECTURA.
 * No envía ni cancela órdenes, no crea claves (solo deriveApiKey) y no mueve fondos.
 *
 * Toma las compras llenadas en real de /data/fills.jsonl (exec.mode = live) y los trades de la
 * cuenta en el CLOB (getTrades) de las últimas RECONCILE_HOURS (26) horas, y empareja por token
 * y tiempo: cada compra del bot contra los trades de COMPRA de ese token entre 5 s antes del
 * envío y RECONCILE_WINDOW_MIN (10) minutos después (una GTD puede quedar en el libro). Avisa:
 *   - compra del bot sin trades en Polymarket (registro de más)
 *   - trade de compra en Polymarket sin compra del bot (posición que el bot no conoce)
 *   - acciones o precio distintos (tolerancia 0.01 acc y $0.005)
 * Líneas [RECONCILIA]; las diferencias empiezan con "⚠️".
 *
 * Uso: node scripts/reconcile-live.js [dataDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SHARE_TOL = 0.01, PRICE_TOL = 0.005;

// Nuestra parte de un trade del CLOB: como tomador es el trade entero; como maker son nuestras
// órdenes dentro de maker_orders (por dirección de la billetera).
function ownLegs(trade, wallet) {
  const t = Date.parse(trade.match_time) || Number(trade.match_time) * 1000;
  if (trade.trader_side !== 'MAKER') {
    return [{ id: trade.id, t, asset: trade.asset_id, side: trade.side, shares: Number(trade.size), price: Number(trade.price) }];
  }
  const w = String(wallet || '').toLowerCase();
  return (trade.maker_orders || []).filter(m => String(m.maker_address || '').toLowerCase() === w)
    .map(m => ({ id: `${trade.id}:${m.order_id}`, t, asset: m.asset_id, side: m.side || 'BUY',
      shares: Number(m.matched_amount), price: Number(m.price) }));
}

function reconcile({ fills, trades, wallet, windowMs = 10 * 60_000 }) {
  const bot = fills.filter(f => f.fill_result === 'FILLED' && f.exec?.mode === 'live' && f.exec?.token_id)
    .map(f => ({ posId: f.posId, asset: String(f.exec.token_id), t: f.latencies?.t4_order_sent_ms ?? f.timestamp,
      shares: Number(f.size_filled), price: Number(f.exec.fill_price ?? f.order_price) }))
    .sort((a, b) => a.t - b.t);
  const legs = trades.flatMap(tr => ownLegs(tr, wallet)).sort((a, b) => a.t - b.t);
  const buys = legs.filter(l => l.side === 'BUY'), sells = legs.filter(l => l.side !== 'BUY');
  const used = new Set();
  const matched = [], mismatches = [], botOnly = [];
  for (const b of bot) {
    const mine = buys.filter(l => !used.has(l.id) && l.asset === b.asset && l.t >= b.t - 5000 && l.t <= b.t + windowMs);
    if (!mine.length) { botOnly.push(b); continue; }
    // Se toman trades en orden hasta cubrir lo que el bot dice que compró
    let shares = 0, cost = 0;
    for (const l of mine) {
      if (shares >= b.shares - SHARE_TOL) break;
      used.add(l.id); shares += l.shares; cost += l.shares * l.price;
    }
    const price = shares > 0 ? cost / shares : null;
    const row = { posId: b.posId, botShares: b.shares, polyShares: +shares.toFixed(4), botPrice: b.price, polyPrice: price != null ? +price.toFixed(4) : null };
    if (Math.abs(shares - b.shares) > SHARE_TOL || (price != null && Math.abs(price - b.price) > PRICE_TOL)) mismatches.push(row);
    else matched.push(row);
  }
  const polyOnly = buys.filter(l => !used.has(l.id));
  return { botFills: bot.length, polyBuys: buys.length, polySells: sells.length, matched, mismatches, botOnly, polyOnly };
}

function lines(r) {
  const L = [`[RECONCILIA] compras del bot en real: ${r.botFills} | trades de compra en Polymarket: ${r.polyBuys} (ventas: ${r.polySells}) | coinciden: ${r.matched.length}`];
  for (const m of r.mismatches) L.push(`[RECONCILIA] ⚠️ ${m.posId}: bot ${m.botShares} acc a $${m.botPrice} vs Polymarket ${m.polyShares} acc a $${m.polyPrice}`);
  for (const b of r.botOnly) L.push(`[RECONCILIA] ⚠️ ${b.posId}: el bot registró ${b.shares} acc a $${b.price} y no hay trade en Polymarket`);
  for (const p of r.polyOnly) L.push(`[RECONCILIA] ⚠️ trade ${p.id} en Polymarket sin registro del bot: ${p.shares} acc a $${p.price} (${new Date(p.t).toISOString()}, token …${String(p.asset).slice(-6)})`);
  if (!r.mismatches.length && !r.botOnly.length && !r.polyOnly.length) L.push('[RECONCILIA] sin diferencias');
  return L;
}

module.exports = { reconcile, ownLegs, lines };

async function main() {
  const config = require('../src/config');
  const dir = process.argv[2] || process.env.DATA_DIR || '/data';
  if (!config.POLY_PRIVATE_KEY) { console.log('[RECONCILIA] sin POLY_PRIVATE_KEY: nada que reconciliar'); return; }
  const { ClobClient, SignatureTypeV2, Chain } = require('@polymarket/clob-client-v2');
  const { createWalletClient, http } = require('viem');
  const { privateKeyToAccount } = require('viem/accounts');
  const pk = config.POLY_PRIVATE_KEY.startsWith('0x') ? config.POLY_PRIVATE_KEY : `0x${config.POLY_PRIVATE_KEY}`;
  const account = privateKeyToAccount(pk);
  const signer = createWalletClient({ account, transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com') });
  const host = 'https://clob.polymarket.com', chain = Chain?.POLYGON ?? 137;
  let creds = config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE
    ? { key: config.POLY_API_KEY, secret: config.POLY_API_SECRET, passphrase: config.POLY_PASSPHRASE } : null;
  if (!creds) creds = await new ClobClient({ host, chain, signer, useServerTime: false }).deriveApiKey(); // solo lee
  if (!creds?.key) { console.log('[RECONCILIA] sin claves de API: no se pueden leer los trades'); return; }
  const wallet = config.POLY_FUNDER_ADDRESS || config.POLY_DEPOSIT_WALLET || account.address;
  const client = new ClobClient({ host, chain, signer, creds, signatureType: SignatureTypeV2.POLY_1271, funderAddress: wallet, useServerTime: false });
  const hours = Number(process.env.RECONCILE_HOURS || 26);
  const after = Math.floor(Date.now() / 1000 - hours * 3600);
  const trades = await client.getTrades({ after: String(after) });
  if (!Array.isArray(trades)) { console.log(`[RECONCILIA] no se pudieron leer los trades: ${JSON.stringify(trades).slice(0, 160)}`); return; }
  const fills = [];
  const file = path.join(dir, 'fills.jsonl');
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { const f = JSON.parse(l); if ((f.latencies?.t4_order_sent_ms ?? f.timestamp) >= after * 1000) fills.push(f); } catch (_) {} }
  const r = reconcile({ fills, trades, wallet, windowMs: Number(process.env.RECONCILE_WINDOW_MIN || 10) * 60_000 });
  for (const l of lines(r)) console.log(l);
}

if (require.main === module) main().catch(e => { console.log(`[RECONCILIA] error: ${String(e?.message || e).slice(0, 160)}`); process.exitCode = 1; });
