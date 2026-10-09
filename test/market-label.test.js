/**
 * Etiqueta corta de mercado para los logs (src/market-label.js).
 * Uso: node test/market-label.test.js
 */
'use strict';
const assert = require('assert');
const { marketLabel } = require('../src/market-label');

assert.strictEqual(marketLabel('Bitcoin Up or Down - October 8, 9:55PM-10:00PM ET'), 'Oct 8, 9:55PM-10:00PM ET');
assert.strictEqual(marketLabel('Bitcoin Up or Down - October 8, 10:00PM-10:05PM ET'), 'Oct 8, 10:00PM-10:05PM ET');
assert.strictEqual(marketLabel('Bitcoin Up or Down - May 9, 8:20PM-8:25PM ET'), 'May 9, 8:20PM-8:25PM ET', 'mes de 3 letras: igual');
assert.strictEqual(marketLabel('Bitcoin Up or Down - June 9, 8:20PM-8:25PM ET'), 'Jun 9, 8:20PM-8:25PM ET');
assert.strictEqual(marketLabel('mercado g1'), 'mercado g1', 'sin " - ": la pregunta (hasta 28 caracteres)');
assert.strictEqual(marketLabel(undefined), '');
assert.strictEqual(marketLabel(null), '');
console.log('market-label: 7 ok');
