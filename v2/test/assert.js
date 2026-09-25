'use strict';
let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log('  PASS ' + msg); } else { fails++; process.exitCode = 1; console.log('  FAIL ' + msg); } }
function near(a, b, tol, msg) { ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol, msg); }
function eq(a, b, msg) { ok(a === b, `${msg} (esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)})`); }
process.on('exit', () => console.log(`  → ${passes} OK, ${fails} fallas`));
module.exports = { ok, near, eq };
