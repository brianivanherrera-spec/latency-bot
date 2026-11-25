/**
 * Respaldo del estado al arrancar (pedido del 25/11, antes del deploy del vivo).
 *
 * En cada arranque, antes de que las cuentas lean su estado, copia los archivos chicos del primer nivel
 * de DATA_DIR (balances y posiciones de A, B, B15, CAL, los intentos de B y B15, stats) a
 * DATA_DIR/backup/<fecha UTC>/. No copia los archivos grandes de análisis (ticks de la sombra, crudos,
 * signals, fills): se regeneran y no son el P&L. Guarda los últimos STATE_BACKUP_KEEP respaldos (10).
 * Archivos de más de STATE_BACKUP_MAX_MB (5) se saltean. STATE_BACKUP=off lo apaga.
 * Nunca frena el arranque: cualquier error queda en el log y sigue.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_RE = /^(shadow-ticks|shadow-markets|binance-raw|polymarket-raw|bot-events|signals|fills|open-snaps|market-research)/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function backupState({ dataDir = process.env.DATA_DIR || '/data', keep, maxMb, now = Date.now(), env = process.env } = {}) {
  if (env.STATE_BACKUP === 'off') return { skipped: 'off' };
  keep = keep ?? Math.max(1, parseInt(env.STATE_BACKUP_KEEP || '10', 10) || 10);
  maxMb = maxMb ?? (parseFloat(env.STATE_BACKUP_MAX_MB || '5') || 5);
  const root = path.join(dataDir, 'backup');
  const stamp = new Date(now).toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const dest = path.join(root, stamp);
  const copied = [], skippedBig = [];
  let bytes = 0;
  if (!fs.existsSync(dataDir)) return { skipped: 'sin DATA_DIR' };
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dataDir)) {
    if (SKIP_RE.test(name) || !/\.(json|jsonl)$/.test(name) || name.endsWith('.tmp')) continue;
    const src = path.join(dataDir, name);
    let st;
    try { st = fs.statSync(src); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (st.size > maxMb * 1024 * 1024) { skippedBig.push(name); continue; }
    fs.copyFileSync(src, path.join(dest, name));
    copied.push(name);
    bytes += st.size;
  }
  // Solo los últimos `keep` respaldos
  const old = fs.readdirSync(root).filter(d => STAMP_RE.test(d)).sort();
  const removed = old.slice(0, Math.max(0, old.length - keep));
  for (const d of removed) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  return { dest, copied, skippedBig, bytes, removed };
}

module.exports = { backupState };
