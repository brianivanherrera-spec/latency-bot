'use strict';
// Corre todas las pruebas: node test/run-all.js
const { execFileSync } = require('child_process');
const path = require('path');
let failed = 0;
for (const t of ['t-pricer.js', 't-trading.js', 't-resolver.js', 't-e2e.js']) {
  console.log(`\n▶ ${t}`);
  try { process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8', timeout: 90000 })); }
  catch (e) { failed++; process.stdout.write((e.stdout || '') + (e.stderr || '')); }
}
console.log(failed ? `\n✗ ${failed} archivo(s) con fallas` : '\n✓ Todas las pruebas pasaron');
process.exitCode = failed ? 1 : 0;
