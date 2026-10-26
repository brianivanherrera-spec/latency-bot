/**
 * IDs de los resultados según la versión del mercado (src/token-ids.js).
 * Uso: node test/token-ids.test.js
 */
'use strict';
const assert = require('assert');
const { outcomeTokenIds } = require('../src/token-ids');

assert.deepStrictEqual(outcomeTokenIds({ clobTokenIds: '["A", "B"]' }), ['A', 'B'], 'sin version: clobTokenIds como siempre');
assert.deepStrictEqual(outcomeTokenIds({ clobTokenIds: ['A', 'B'] }), ['A', 'B'], 'clobTokenIds ya parseado');
assert.deepStrictEqual(outcomeTokenIds({ version: 'v2', clobTokenIds: '["A", "B"]', positionIds: '["1", "2"]' }), ['1', '2'],
  'v2: positionIds aunque esté clobTokenIds');
assert.deepStrictEqual(outcomeTokenIds({ version: 'V2', positionIds: [11, 22] }), ['11', '22'], 'v2 con números: strings');
assert.deepStrictEqual(outcomeTokenIds({ version: 'v1', clobTokenIds: '["A", "B"]', positionIds: '["1", "2"]' }), ['A', 'B'],
  'v1: clobTokenIds');
assert.deepStrictEqual(outcomeTokenIds({ version: 'v2', clobTokenIds: '["A", "B"]', positionIds: '[]' }), ['A', 'B'],
  'v2 sin positionIds útiles: clobTokenIds de respaldo');
assert.deepStrictEqual(outcomeTokenIds({ positionIds: '["1", "2"]' }), ['1', '2'], 'sin clobTokenIds: positionIds de respaldo');
assert.strictEqual(outcomeTokenIds({ clobTokenIds: 'roto' }), null);
assert.strictEqual(outcomeTokenIds(null), null);
console.log('token-ids: OK');
