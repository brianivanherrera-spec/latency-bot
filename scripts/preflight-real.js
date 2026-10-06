#!/usr/bin/env node
/**
 * Chequeo previo a operar con dinero real — SOLO LECTURA.
 * No envía órdenes, no cancela, no crea claves de API, no refresca la caché de saldo
 * ni mueve fondos. Solo consulta y escribe líneas [PREFLIGHT] (sin secretos).
 *
 * Revisa: credenciales presentes (sí/no), dirección EOA y deposit wallet (públicas),
 * que las claves de API autentiquen, saldo y allowance de colateral en el CLOB, órdenes
 * abiertas, modo "solo cierre" (cuenta restringida), geobloqueo desde la IP del servidor,
 * latencia al CLOB y gas (POL) de la EOA.
 *
 * Uso: node scripts/preflight-real.js   (lee las mismas variables que el bot)
 */
'use strict';
const config = require('../src/config');

const CLOB = 'https://clob.polymarket.com';
const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DEPOSIT_WALLET_IMPL = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';
const TIMEOUT = 8000;

const out = (k, v) => console.log(`[PREFLIGHT] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const errMsg = e => String(e?.response?.data?.error || e?.message || e).slice(0, 160);
const withTimeout = (p, ms = TIMEOUT) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms))]);

async function getJson(url, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  const ms = Date.now() - t0;
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, ms, body };
}

async function latency() {
  const ms = []; let last = null;
  for (let i = 0; i < 10; i++) {
    try { const r = await getJson(`${CLOB}/time`); if (r.status === 200) ms.push(r.ms); else last = r.status; } catch (e) { last = errMsg(e); }
  }
  if (!ms.length) return { ok: false, last };
  ms.sort((a, b) => a - b);
  return { ok: true, n: ms.length, p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))], max: ms[ms.length - 1] };
}

async function geoblock() {
  try {
    const r = await getJson('https://polymarket.com/api/geoblock');
    if (r.status !== 200 || !r.body) return { ok: false, status: r.status };
    const { blocked, country, region } = r.body;
    return { ok: true, blocked, country, region };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

async function polBalance(addr) {
  try {
    const r = await getJson(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }) });
    const wei = BigInt(r.body?.result ?? '0x0');
    return { ok: true, pol: Number(wei) / 1e18 };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

async function main() {
  const has = k => Boolean(config[k]);
  out('modo', config.DRY_RUN ? 'paper (DRY_RUN=true)' : 'REAL (DRY_RUN=false)');
  out('credenciales', { POLY_PRIVATE_KEY: has('POLY_PRIVATE_KEY'), POLY_API_KEY: has('POLY_API_KEY'),
    POLY_API_SECRET: has('POLY_API_SECRET'), POLY_PASSPHRASE: has('POLY_PASSPHRASE'),
    POLY_FUNDER_ADDRESS: has('POLY_FUNDER_ADDRESS'), POLY_DEPOSIT_WALLET: has('POLY_DEPOSIT_WALLET'),
    POLY_RELAYER_API_KEY: has('POLY_RELAYER_API_KEY') });

  out('geobloqueo', await geoblock());
  out('latencia_clob_ms', await latency());

  if (!config.POLY_PRIVATE_KEY) {
    out('resultado', 'sin POLY_PRIVATE_KEY: no se puede revisar la cuenta (cargarla en Railway para el chequeo completo)');
    return;
  }

  let ClobClient, SignatureTypeV2, Chain, createWalletClient, http, privateKeyToAccount, deriveDepositWallet;
  try {
    ({ ClobClient, SignatureTypeV2, Chain } = require('@polymarket/clob-client-v2'));
    ({ createWalletClient, http } = require('viem'));
    ({ privateKeyToAccount } = require('viem/accounts'));
  } catch (e) { out('resultado', `librerías no disponibles: ${errMsg(e)}`); return; }
  try { ({ deriveDepositWallet } = require('@polymarket/builder-relayer-client')); } catch (_) {}

  let account;
  try {
    const pk = config.POLY_PRIVATE_KEY.startsWith('0x') ? config.POLY_PRIVATE_KEY : `0x${config.POLY_PRIVATE_KEY}`;
    account = privateKeyToAccount(pk);
  } catch (e) { out('resultado', `POLY_PRIVATE_KEY inválida: ${errMsg(e)}`); return; }
  const walletClient = createWalletClient({ account, transport: http(RPC) });
  let depositWallet = config.POLY_FUNDER_ADDRESS || config.POLY_DEPOSIT_WALLET;
  let depositSrc = config.POLY_FUNDER_ADDRESS ? 'POLY_FUNDER_ADDRESS' : config.POLY_DEPOSIT_WALLET ? 'POLY_DEPOSIT_WALLET' : null;
  if (!depositWallet && deriveDepositWallet) {
    depositWallet = deriveDepositWallet(account.address, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL);
    depositSrc = 'derivada';
  }
  out('direcciones', { eoa: account.address, deposit_wallet: depositWallet || null, origen: depositSrc });
  out('gas_eoa', await polBalance(account.address));

  // Claves de API: las configuradas, o derivar las existentes (deriveApiKey solo lee; nunca crea)
  let creds = null, credsSrc = null;
  if (config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE) {
    creds = { key: config.POLY_API_KEY, secret: config.POLY_API_SECRET, passphrase: config.POLY_PASSPHRASE };
    credsSrc = 'variables';
  } else {
    try {
      const tmp = new ClobClient({ host: CLOB, chain: Chain?.POLYGON ?? 137, signer: walletClient, useServerTime: false });
      const c = await withTimeout(tmp.deriveApiKey());
      if (c?.key) { creds = c; credsSrc = 'derivadas'; }
      else out('api_keys', { ok: false, error: String(c?.error || 'no hay claves para esta cuenta').slice(0, 160) });
    } catch (e) { out('api_keys', { ok: false, error: errMsg(e) }); }
  }
  if (!creds) { out('resultado', 'sin claves de API válidas: el bot no podría operar en real'); return; }

  const client = new ClobClient({ host: CLOB, chain: Chain?.POLYGON ?? 137, signer: walletClient, creds,
    signatureType: SignatureTypeV2.POLY_1271, funderAddress: depositWallet, useServerTime: false });

  const checks = {};
  try {
    const k = await withTimeout(client.getApiKeys());
    checks.api_keys = { ok: !k?.error, origen: credsSrc, cantidad: Array.isArray(k?.apiKeys) ? k.apiKeys.length : undefined, error: k?.error };
  } catch (e) { checks.api_keys = { ok: false, origen: credsSrc, error: errMsg(e) }; }
  try {
    const b = await withTimeout(client.getBalanceAllowance({ asset_type: 'COLLATERAL' }));
    if (b?.error) checks.saldo = { ok: false, error: String(b.error).slice(0, 160) };
    else {
      const allow = b?.allowances ? Object.values(b.allowances).map(v => Number(v) / 1e6) : (b?.allowance != null ? [Number(b.allowance) / 1e6] : []);
      checks.saldo = { ok: true, usdc: b?.balance != null ? +(Number(b.balance) / 1e6).toFixed(2) : null,
        allowance_min: allow.length ? Math.min(...allow) : null };
    }
  } catch (e) { checks.saldo = { ok: false, error: errMsg(e) }; }
  try {
    const o = await withTimeout(client.getOpenOrders());
    checks.ordenes_abiertas = Array.isArray(o) ? o.length : (o?.error ? { error: String(o.error).slice(0, 160) } : o?.data?.length ?? null);
  } catch (e) { checks.ordenes_abiertas = { error: errMsg(e) }; }
  try {
    const c = await withTimeout(client.getClosedOnlyMode());
    checks.solo_cierre = c?.closed_only ?? c;
  } catch (e) { checks.solo_cierre = { error: errMsg(e) }; }
  for (const [k, v] of Object.entries(checks)) out(k, v);

  const minOrder = config.ORDER_SIZE_USDC || 5;
  const problems = [];
  if (!checks.api_keys?.ok) problems.push('las claves de API no autentican');
  if (!checks.saldo?.ok) problems.push('no se pudo leer el saldo');
  else if ((checks.saldo.usdc ?? 0) < minOrder) problems.push(`saldo ${checks.saldo.usdc} < orden mínima ${minOrder}`);
  if (checks.saldo?.ok && checks.saldo.allowance_min != null && checks.saldo.allowance_min < minOrder) problems.push('allowance menor que una orden');
  if (checks.solo_cierre === true) problems.push('cuenta en modo solo cierre');
  out('resultado', problems.length ? `NO LISTO: ${problems.join('; ')}` : 'cuenta lista para operar (falta tu OK y DRY_RUN=false)');
}

main().catch(e => { out('resultado', `error inesperado: ${errMsg(e)}`); process.exitCode = 1; });
