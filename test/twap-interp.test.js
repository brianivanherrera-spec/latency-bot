/**
 * Strike con hueco del feed en la apertura (chainlink-rtds.js getTwapInterp).
 * Uso: node test/twap-interp.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { ChainlinkRTDS } = require('../src/chainlink-rtds');

const c = new ChainlinkRTDS();
const T = 1_791_000_000_000; // apertura
for (let s = -20; s <= -2; s++) c._record(60, T + s * 1000, 84800 + s * 0.1); // hasta T-2s
for (let s = 6; s <= 20; s++) c._record(60, T + s * 1000, 84800 + s * 0.1);   // hueco T-1..T+5
assert.strictEqual(c.getTwapAt(60, T, 1000), null, 'sin punto a <= 1 s antes de la apertura');
const v = c.getTwapInterp(60, T);
assert.ok(Math.abs(v - 84800) < 1e-6, `interpola en la recta: ${v}`);
assert.strictEqual(c.getTwapInterp(60, T + 30_000), null, 'sin punto posterior = null');
assert.strictEqual(c.getTwapInterp(60, T, 1500), null, 'lados más lejos que maxSideMs = null');

const d = new ChainlinkRTDS();
d._record(60, T, 84900);
d._record(60, T + 1000, 84901);
assert.strictEqual(d.getTwapInterp(60, T), 84900, 'punto exacto = ese valor');
console.log('twap-interp: 5 ok');
