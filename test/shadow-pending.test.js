/**
 * Shadow: los mercados cerrados que esperan el ganador oficial de Gamma se guardan al apagar y se
 * retoman al arrancar (antes cada reinicio perdía 1-2 mercados).
 * Uso: node test/shadow-pending.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-pending-'));
process.env.DATA_DIR = dir;
const assert = require('assert');
const { Shadow, PENDING_FILE } = require('../src/shadow');

(async () => {
  assert.strictEqual(PENDING_FILE, path.join(dir, 'shadow-pending.json'));
  const now = Date.now();
  const mk = (id, endTs) => ({ gammaId: id, question: `mercado ${id}`, startTs: endTs - 300000, endTs, rows: [[1, 299]], closed: true });
  const fv = { priceAt: () => null };
  const a = new Shadow({ fairValue: fv, polyWs: {} });
  // Sin pendientes: no deja archivo
  assert.strictEqual(a.savePending(), 0);
  assert.ok(!fs.existsSync(PENDING_FILE));
  // Dos pendientes: uno cerrado hace 2 min y otro hace 3 h (demasiado viejo para retomar)
  a.pending.set('g1', mk('g1', now - 120000));
  a.pending.set('g0', mk('g0', now - 3 * 3600000));
  assert.strictEqual(a.savePending(), 2);
  assert.ok(fs.existsSync(PENDING_FILE));
  // Después de guardarlos, este proceso ya no los escribe aunque Gamma conteste (los escribe el nuevo)
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ closed: true, outcomePrices: '["1", "0"]' }) });
  await a._resolve(a.pending.get('g1'), 0);
  global.fetch = realFetch;
  assert.deepStrictEqual([a.stats.written, a.pending.size], [0, 2]);

  // Arranque: retoma solo el reciente, borra el archivo y busca su ganador
  const b = new Shadow({ fairValue: fv, polyWs: {} });
  const calls = [];
  b._resolve = (m, attempt) => calls.push([m.gammaId, attempt]);
  assert.strictEqual(b.restorePending({ now, delayMs: 0 }), 1);
  assert.ok(!fs.existsSync(PENDING_FILE), 'el archivo se borra al retomarlo');
  assert.deepStrictEqual([...b.pending.keys()], ['g1']);
  assert.deepStrictEqual(b.pending.get('g1').rows, [[1, 299]], 'conserva la serie del mercado');
  await new Promise(r => setTimeout(r, 5));
  assert.deepStrictEqual(calls, [['g1', 0]]);
  // Un segundo arranque sin archivo no hace nada
  assert.strictEqual(b.restorePending({ now, delayMs: 0 }), 0);
  // Archivo roto: se descarta sin romper el arranque
  fs.writeFileSync(PENDING_FILE, '{roto');
  assert.strictEqual(b.restorePending({ now, delayMs: 0 }), 0);
  assert.ok(!fs.existsSync(PENDING_FILE));
  // Entradas inválidas o ya pendientes se saltean
  fs.writeFileSync(PENDING_FILE, JSON.stringify([null, { gammaId: 'x' }, mk('g1', now - 60000)]));
  assert.strictEqual(b.restorePending({ now, delayMs: 0 }), 0, 'g1 ya estaba pendiente; x sin serie');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('shadow-pending: 15 ok');
})().catch(e => { console.error(e); process.exit(1); });
