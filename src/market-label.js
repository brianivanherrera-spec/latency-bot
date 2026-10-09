/**
 * Etiqueta corta de un mercado para los logs:
 *   "Bitcoin Up or Down - October 8, 10:00PM-10:05PM ET" → "Oct 8, 10:00PM-10:05PM ET"
 * Antes se cortaban los últimos 22 caracteres, que con horas de dos dígitos se comían el mes
 * ("r 8, 9:55PM-10:00PM ET", " 8, 10:00PM-10:05PM ET").
 */
'use strict';

function marketLabel(question) {
  const q = String(question || '');
  const i = q.lastIndexOf(' - ');
  if (i < 0) return q.slice(-28);
  return q.slice(i + 3).replace(/^([A-Z][a-z]{2})[a-z]+(?= \d)/, '$1');
}

module.exports = { marketLabel };
