/**
 * Retención de datos en el volumen (/data, 5 GB).
 *
 * Nada borraba lo viejo: las grabaciones por mercado (/data/markets) y los crudos
 * rotados de phase2 (binance-raw / polymarket-raw / bot-events .<fecha>.jsonl) crecen
 * ~75 MB/h y llenaban el volumen en ~2.5 días. Cada hora se borran, de más viejo a
 * más nuevo:
 *   - los que tienen más de RETENTION_DAYS días;
 *   - los necesarios para que esos archivos no ocupen más de RETENTION_MAX_GB;
 *   - si el disco supera DISK_EMERGENCY_PCT, los necesarios para bajar de ese nivel.
 * No se tocan signals.jsonl, stats.json, positions.json, shadow-*.jsonl ni los
 * archivos que se están escribiendo (los crudos sin fecha en el nombre).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const logger = new Logger('RETENTION');

const DATA_DIR = process.env.DATA_DIR || '/data';
const MARKETS_DIR = path.join(DATA_DIR, 'markets');
const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS || '3');
const RETENTION_MAX_GB = parseFloat(process.env.RETENTION_MAX_GB || '2.5');
const DISK_EMERGENCY_PCT = parseFloat(process.env.DISK_EMERGENCY_PCT || '85');
const RUN_EVERY_MS = 60 * 60 * 1000;
// Crudos rotados por async-append: <base>.<YYYY-MM-DDTHH-MM-SS>.jsonl
const ROTATED_RE = /^(binance-raw|polymarket-raw|bot-events)\.\d{4}-\d{2}-\d{2}T[\d-]+\.jsonl$/;
// Grabación por mercado; la del mercado en curso tiene mtime reciente y nunca es la más vieja
const MARKET_RE = /^MARKET_.*\.jsonl$/;
const MIN_AGE_MS = 15 * 60 * 1000; // nunca borrar algo escrito en los últimos 15 min

const GB = 1024 ** 3, MB = 1024 ** 2;

async function listCandidates() {
  const out = [];
  const scan = async (dir, re) => {
    let names;
    try { names = await fs.promises.readdir(dir); } catch { return; }
    for (const name of names) {
      if (!re.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fs.promises.stat(file);
        if (st.isFile()) out.push({ file, size: st.size, mtime: st.mtimeMs });
      } catch (_) {}
    }
  };
  await scan(MARKETS_DIR, MARKET_RE);
  await scan(DATA_DIR, ROTATED_RE);
  return out.sort((a, b) => a.mtime - b.mtime); // más viejo primero
}

async function diskUsage() {
  try {
    const s = await fs.promises.statfs(DATA_DIR);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, used: total - free, pct: (total - free) / total * 100 };
  } catch { return null; }
}

async function runOnce() {
  const files = await listCandidates();
  let candBytes = files.reduce((a, f) => a + f.size, 0);
  const disk = await diskUsage();
  let usedBytes = disk ? disk.used : null;
  const now = Date.now();
  const cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000;
  let n = 0, freed = 0;

  for (const f of files) {
    if (now - f.mtime < MIN_AGE_MS) break; // ordenados: el resto es más nuevo
    const tooOld = f.mtime < cutoff;
    const overBudget = candBytes > RETENTION_MAX_GB * GB;
    const emergency = disk && usedBytes / disk.total * 100 > DISK_EMERGENCY_PCT;
    if (!tooOld && !overBudget && !emergency) break;
    try {
      await fs.promises.unlink(f.file);
      n++; freed += f.size; candBytes -= f.size;
      if (usedBytes != null) usedBytes -= f.size;
    } catch (_) {}
  }

  const diskTxt = disk
    ? `disco ${(usedBytes / GB).toFixed(2)}/${(disk.total / GB).toFixed(1)} GB (${(usedBytes / disk.total * 100).toFixed(0)}%)`
    : 'disco ?';
  logger.info(`borrados ${n} archivos (${(freed / MB).toFixed(0)} MB) | grabaciones+crudos rotados: ${files.length - n} archivos, ${(candBytes / MB).toFixed(0)} MB | ${diskTxt}`);
}

function start() {
  const run = () => runOnce().catch(e => logger.warn(`error: ${e.message}`));
  setTimeout(run, 60 * 1000).unref?.();          // primera pasada al minuto de arrancar
  setInterval(run, RUN_EVERY_MS).unref?.();
}

module.exports = { start, runOnce };
