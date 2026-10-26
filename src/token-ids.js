/**
 * IDs de los resultados de un mercado de Gamma para operar en el CLOB.
 *
 * Protocol V2 (02/11/2026): según la guía de migración de Polymarket, en un mercado con version "v2" los IDs vienen en
 * positionIds (array de strings decimales) y hay que elegir el campo por version aunque estén los dos. Sin version v2
 * (o si positionIds no sirve) se sigue con clobTokenIds como hasta ahora; si falta clobTokenIds, positionIds de respaldo.
 */
'use strict';

const parseArr = v => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : null; } catch { return null; } };

function outcomeTokenIds(m) {
  if (!m) return null;
  const clob = parseArr(m.clobTokenIds), pos = parseArr(m.positionIds);
  const v2 = String(m.version || '').toLowerCase() === 'v2';
  if (v2 && pos && pos.length >= 2) return pos.map(String);
  if (clob && clob.length >= 2) return clob;
  if (pos && pos.length >= 2) return pos.map(String);
  return clob || pos || null;
}

module.exports = { outcomeTokenIds };
